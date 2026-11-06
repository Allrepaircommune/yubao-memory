/**
 * 记忆投影（2026-11-07 建）
 *
 * 每轮给模型看的那一小块「我记得」，600 字封顶。
 *
 * 三条铁律（见 I:\鱼宝的记忆\记忆调研\17-架构定稿与年推演.md）：
 *   1. **只放长期**：约束 + 长期决定。最近动态不放 —— 它本来就在历史里，读得到
 *   2. **会话内冻结**：算一次就不动，否则每轮变会让提示词前缀缓存全碎（每月多花一两千）
 *   3. **同一状态必得同一字节串**：查询全确定性，不用随机、不用时间戳到秒
 *
 * 为什么最近动态不放：13 号推算里算过，投影一变缓存全失效。
 * 放进"最近发生什么"等于每轮都变。而它本来就在历史里。
 */

/** 投影里各段的上限 */
const BUDGET = {
  decisions: 480, // 定过的事（字）
  maxItems: 10, // 最多几条 —— 2026-11-07 实测：不限条数会塞进 28 条，挤爆又杂乱
  lineChars: 40, // 每条正文截多少字（标题之外的部分）
};

/**
 * 截到 n 字，但别把词切两半。
 * 优先退到最后一个逗号/分号处，实在没有才硬截。
 */
function clip(s, n) {
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const cut = Math.max(
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('。'),
    head.lastIndexOf('、'),
  );
  if (cut >= n * 0.55) return head.slice(0, cut + 1) + '…';
  return head + '…';
}

/**
 * 为什么要有 pinned（2026-11-07 加）
 *
 * 自动挑「哪些决定值得常驻」这条路走不通，试过三种：
 *   1. `memories.dec=1` 按 alpha 排 —— 捞出来的是「睡多久并检查骰子任务」这种流程标题
 *   2. `decisions` 表 obj+text —— 干净多了，但按时间排会掺进「MAA 先停不停」这种早已过期的一次性决定
 *   3. 按 alpha 排 decisions —— 又变成一堆老事占坑，今晚的新方向反而进不来
 *
 * 根子上的问题：库里没有「这条到今天是仍然有效」的标记，而这个判断只有人（或我）能下。
 * 所以改成：**手工钉住 ≤10 条**，投影只读 pinned。
 * 没钉任何东西时退回自动逻辑，功能不至于空转。
 */

/**
 * 这行能不能放进投影。
 *
 * 2026-11-07 实测：不加过滤的话，投影里会混进 QQ 线标记、图片链接、表情符、
 * 「收到」「好」这类口水话 —— 它们 alpha 高是因为语义上算"回应"，但放投影纯占地方。
 */
function usable(line) {
  if (line.length < 8) return false; // 太短，多半是「好」「收到」
  if (/^\[QQ线/.test(line)) return false;
  if (/^\[表情/.test(line)) return false;
  if (/^\[可选表情/.test(line)) return false;
  if (/^!\[/.test(line)) return false; // 图片
  if (/\[图:/.test(line)) return false;
  if (/^[·\-*\s\d.、]+$/.test(line)) return false; // 纯标点/编号
  // 开头是纯符号的比例太高就丢
  const symbols = (line.match(/[\[\]【】()（）`~!@#$%^&*_+=|\\/<>]/g) ?? []).length;
  if (symbols / line.length > 0.3) return false;
  return true;
}

/** 往前推 n 天，返回 'YYYY-MM-DD HH:MM:SS'（本地时间） */
function windowStart(days) {
  const t = new Date(Date.now() + 8 * 3600 * 1000 - days * 86400 * 1000);
  return t.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 手工钉住的那几条（投影的首选来源）。
 *
 * 顺序按 id（= 我写进去的顺序），不按时间也不按 alpha —— 谁想让它第一眼看到，
 * 就把它排前面，这个顺序本身也是我定的。
 *
 * @param {{ all: (sql: string, ...p: unknown[]) => unknown[] }} store
 * @returns {string[]}
 */
function pinnedLines(store) {
  const rows = store.all(
    `SELECT COALESCE(oneline, substr(text, 1, 20)) AS title,
            text
       FROM memories
      WHERE pinned = 1
      ORDER BY id
      LIMIT ?`,
    BUDGET.maxItems,
  );
  const out = [];
  for (const r of rows) {
    const title = String(r.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const body = String(r.text ?? '').replace(/\s+/g, ' ').trim();
    // 标题 + 正文要点；正文就是标题本身时不再重复
    const rest = body.startsWith(title) ? body.slice(title.length).trim() : body;
    out.push(rest ? `${title} —— ${clip(rest, BUDGET.lineChars)}` : title);
  }
  return out;
}

/**
 * 从库里算出一块投影。
 *
 * 优先读手工钉住的（pinned），没有才退回自动挑。
 *
 * 为什么不放「约束」：约束（说话方式、称呼、锚定）在人格.md 里，每次会话本来就注入；
 * 为什么不放「最近动态」：它本来就在历史里，而且每轮变会让缓存全碎。
 * 投影要补的是「库里那些又不常翻、又该记着」的东西，比如「记忆方案定了全量存」。
 *
 * @param {{ all: (sql: string, ...p: unknown[]) => unknown[] }} store
 * @param {{ maxChars?: number, minAlpha?: number }} [opts]
 * @returns {string}
 */
export function buildProjection(store, opts = {}) {
  const maxChars = Math.max(200, Number(opts.maxChars) || 600);

  // 首选：手工钉住的
  const pins = pinnedLines(store);
  if (pins.length) {
    const text = ['【定过的事】', ...pins.map((l) => '· ' + l)].join('\n');
    return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
  }

  // 退回：自动挑（decisions 表里文本干净、最近 30 天、同一件事只取一条）
  const auto = autoLines(store, opts);
  if (!auto.length) return '';
  const text = ['【定过的事】', ...auto.map((l) => '· ' + l)].join('\n');
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

/**
 * 没钉东西时的兜底：从 decisions 表挑。
 * @param {{ all: (sql: string, ...p: unknown[]) => unknown[] }} store
 * @param {{ minAlpha?: number, since?: string }} [opts]
 * @returns {string[]}
 */
function autoLines(store, opts = {}) {
  const rows = store.all(
    `SELECT d.obj, d.text, m.event_id
       FROM decisions d
       LEFT JOIN memories m ON m.id = d.memory_id
      WHERE length(d.text) <= 60
        AND d.at >= ?
      ORDER BY d.at DESC
      LIMIT 200`,
    opts.since ?? windowStart(30),
  );
  const out = [];
  const seenEv = new Set();
  const seenObj = new Set();
  for (const r of rows) {
    const obj = String(r.obj ?? '').trim();
    const txt = String(r.text ?? '').replace(/\s+/g, ' ').trim();
    if (!obj || !txt) continue;
    if (!usable(obj) || !usable(txt)) continue;
    if (r.event_id != null && seenEv.has(r.event_id)) continue;
    if (seenObj.has(obj)) continue;
    seenEv.add(r.event_id);
    seenObj.add(obj);
    out.push(`${obj} —— ${clip(txt, BUDGET.lineChars)}`);
    if (out.length >= BUDGET.maxItems) break;
  }
  return out;
}

/**
 * 冻结版：算一次就不再变。
 *
 * 为什么冻结：投影在系统提示里、位置在历史之前。它一变，后面整个历史全部重算缓存，
 * 一个月能多花一两千。冻结的代价是长会话里新发生的事看不到 —— 但那些本来就在历史里。
 *
 * @param {{ all: (sql: string, ...p: unknown[]) => unknown[] }} store
 * @returns {() => string}
 */
export function frozenProjection(store) {
  let cached = null;
  return () => {
    if (cached === null) cached = buildProjection(store);
    return cached;
  };
}
