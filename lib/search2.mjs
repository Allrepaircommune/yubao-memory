/**
 * 记忆检索 v2（2026-11-07 建）
 *
 * 跟老的那套（query.mjs 里的 LIKE 子串）并存，互不影响。
 * 老的还在跑，这个先空跑验证，确认可靠再切过去。
 *
 * 为什么另起一个文件：改老的会牵动 memory_search / memory_event 所有路径，
 * 一次改坏就得整条线停。新文件出问题，直接不引用它就行。
 *
 * 算法：
 *   1. 查询分词 —— 中文按 2 字一组，英文/数字按整词，去停用词
 *   2. 同义词扩展 —— terms.json 里那 30~50 条（那台机器 → 出租屋笔记本）
 *   3. IDF —— 越少见的词权重越高（backtest 证明「备份」这种到处都有的词会盖过真正相关的）
 *   4. 打分 —— idf 之和 × alpha × beta惩罚 × sunk降权
 *   5. 返回 top N，带命中词说明（方便人核对）
 *
 * 不做的事（第一版）：
 *   - 时间衰减（库只有 15 天，没数据支撑）
 *   - 向量（先用同义词表顶着）
 *   - 跨表 join（只查 memories，bodies 后面再说）
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureMemorySchema, hasMemoryColumn } from './schema.mjs';

/** 识海库路径（跟 query.mjs 的 DEFAULT_DB_PATH 一致） */
const DB_PATH = 'I:\\鱼宝的记忆\\sea2.db';

/** 本地时区偏移（毫秒）—— 库里的时间全是本地时间字符串，不是 UTC */
function localOffsetMs() {
  return -new Date().getTimezoneOffset() * 60000;
}

/** UTC 毫秒 → 库里的本地时间字符串 `YYYY-MM-DD HH:mm:ss` */
function toLocalStamp(ms) {
  return new Date(ms + localOffsetMs()).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 记账：哪些记忆被检索命中了（2026-11-07 加）
 *
 * 为什么需要：老爸定的「半年没提就归档」要靠它判——没有命中记录就判不了。
 *
 * 为什么单独开连接：query.mjs 的铁律是"只读"，不能为了记账破例；
 * 这里自己开一个短连接，写完就关，失败了也不影响检索结果。
 *
 * 2026-11-07（0.5.0）加**复习回血一半**：命中时把「已流逝天数」折半，不是重置到现在。
 * 依据是 03/04 号调研（抄 neuron）：重置会让「鱼宝」「好鱼宝」这种口头禅永远霸屏；
 * 折半的意思是「它确实被想起过，但没被抬成常驻」。
 * 折半靠 `decay_at`（衰减基准）实现，`last_hit` 仍然只记真实的最后一次命中时间。
 *
 * @param {Array<number>} ids
 */
export function recordHits(ids) {
  const list = (ids ?? []).filter((x) => Number.isFinite(Number(x)));
  if (!list.length) return;
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
    // 老库可能缺列（0.5.0 之前没有 decay_at），顺手补齐；新库缺的更多，一起补
    ensureMemorySchema(db);
    const nowMs = Date.now();
    const at = toLocalStamp(nowMs);
    const read = db.prepare('SELECT COALESCE(decay_at, last_hit, at) AS base FROM memories WHERE id = ?');
    const upd = db.prepare(
      'UPDATE memories SET hits = COALESCE(hits, 0) + 1, last_hit = ?, decay_at = ? WHERE id = ?',
    );
    db.exec('BEGIN');
    for (const id of list) {
      const base = read.get(Number(id))?.base;
      let decay = at;
      const t = Date.parse(String(base ?? '').replace(' ', 'T'));
      // 折半：从现在往回退「已流逝距离」的一半
      if (Number.isFinite(t) && t < nowMs) decay = toLocalStamp(t + (nowMs - t) / 2);
      upd.run(at, decay, Number(id));
    }
    db.exec('COMMIT');
  } catch {
    // 记账失败不影响检索，静默跳过
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 中文停用词：这些当关键词没意义，会污染 IDF */
const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '就', '都', '也',
  '不', '吗', '呢', '啊', '哦', '嗯', '吧', '要', '会', '说', '把', '被', '给', '对', '从', '到', '与',
  '或', '但', '而', '所以', '因为', '如果', '然后', '还是', '可以', '一个', '什么', '怎么', '为什么',
  '现在', '时候', '一起', '已经', '还有', '没有', '这个', '那个', '这样', '那样', '我们', '你们',
  '他们', '自己', '知道', '觉得', '应该', '可能', '真的', '一直', '一点', '那种', '这种', '就是',
]);

/**
 * 把一句话切成检索单位。
 *
 * 中文同时出 2-gram 和单字：
 *   —— 只要 2-gram 的话，「老爸胃不好」会切成「老爸/爸胃/胃不/不好」，
 *      「胃」这个关键单字就丢了（2026-11-07 空跑实测）。
 *   —— 单字靠 IDF 自然压住常见字（「不」「好」会算出很低的分）。
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();

  const zh = s.replace(/[^\u4e00-\u9fffa-z0-9]/g, ' ');
  for (let i = 0; i < zh.length - 1; i++) {
    const g = zh.slice(i, i + 2);
    if (/^[\u4e00-\u9fff]{2}$/.test(g) && !STOP.has(g)) out.add(g);
  }
  // 单字：只收非停用词
  for (const ch of zh) {
    if (/^[\u4e00-\u9fff]$/.test(ch) && !STOP.has(ch)) out.add(ch);
  }

  // 英文/数字整词
  for (const w of s.match(/[a-z][a-z0-9_-]{1,30}/g) ?? []) out.add(w);

  return out;
}

/**
 * 同义词/指代表。文件放同目录的 terms.json，改词不用动代码。
 * 结构：{ "那台机器": ["出租屋", "笔记本"], "备份那天": ["备份", "演练"] }
 * @returns {Record<string, string[]>}
 */
export function loadTerms(dir = import.meta.dirname) {
  const p = path.join(dir, 'terms.json');
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 查询扩展：把命中的同义词也加进来。
 *
 * 匹配方式：整句里包含这个键就算命中（「备份那天怎么做的」包含「备份那天」）。
 * 只看 token 会漏——「备份那天」被切成「备份/份那/那天」，没有哪个 token 等于它。
 *
 * @param {Set<string>} tokens
 * @param {Record<string, string[]>} terms
 * @param {string} [rawQuery] 原始查询串，给了就用它做包含判断
 * @returns {Set<string>}
 */
export function expand(tokens, terms, rawQuery = '') {
  const out = new Set(tokens);
  const raw = String(rawQuery);
  for (const [k, vals] of Object.entries(terms)) {
    const hit = (raw && raw.includes(k)) || tokens.has(k);
    if (hit) for (const v of vals) for (const t of tokenize(v)) out.add(t);
  }
  return out;
}

/**
 * 检索主函数。
 *
 * @param {{ all: (sql: string, ...p: unknown[]) => unknown[] }} store
 * @param {{
 *   q?: string,
 *   scope?: string | string[],
 *   windowDays?: number,
 *   limit?: number,
 *   includeSunk?: boolean,
 * }} opts
 * @returns {{ hits: Array<Record<string, unknown>>, meta: Record<string, unknown> }}
 */
export function searchV2(store, opts = {}) {
  const t0 = Date.now();
  const q = String(opts.q ?? '').trim();
  if (!q) throw new Error('q 不能空');

  const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 100);
  // 2026-11-07 加（B3 时间理解）：「上次」「最近」这类词靠它把新的往上推。
  // 0 = 不加权（默认，老行为），1 = 越新越重（90 天半程，最重 ×2）。
  const recency = Math.min(Math.max(Number(opts.recency) || 0, 0), 1);
  // 时间衰减的半衰期（天），0.5.0。
  // 默认 90 天（跟默认窗口一致）；MINDSEA_HALF_LIFE_DAYS=0 整个关掉（想对比加不加时用）。
  const halfLifeDays = (() => {
    const raw = process.env.MINDSEA_HALF_LIFE_DAYS;
    if (raw === undefined || raw === '') return 90;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 90;
  })();
  // 「以前怎么定的」这种翻旧账的查询不该被衰减压（opts.decay === false）
  const decayOn = opts.decay !== false && halfLifeDays > 0;
  const terms = loadTerms();
  const rawTokens = tokenize(q);
  const tokens = expand(rawTokens, terms, q);
  if (!tokens.size) throw new Error('这句里没有可检索的词');

  // 拿候选：只要包含任一词就能进（SQL 粗筛，后面才算分）
  //
  // 粗筛只用「长词」（2 字以上）——单字太宽，全库一半都能进候选（实测 2542/5690）。
  // 单字照样参与打分，只是不用它决定「谁进候选」。
  const tokArr = [...tokens];
  const filterTokens = tokArr.filter((t) => t.length >= 2);
  const useFilter = filterTokens.length ? filterTokens : tokArr;
  const likeParts = useFilter.map(() => 'text LIKE ?');
  const params = useFilter.map((t) => `%${t}%`);

  const where = [`(${likeParts.join(' OR ')})`];
  if (Array.isArray(opts.scope) && opts.scope.length) {
    where.push(`scope IN (${opts.scope.map(() => '?').join(',')})`);
    params.push(...opts.scope.map(String));
  } else if (typeof opts.scope === 'string' && opts.scope) {
    where.push('scope = ?');
    params.push(opts.scope);
  }
  if (!opts.includeSunk) where.push("COALESCE(status, 'active') <> 'sunk'");
  // A4：被后来某条取代的旧话默认不冒头（老爸 2026-11-07 定的口径）
  // 只影响"默认检索"，要翻旧账时传 includeSuperseded: true 还能看到
  if (!opts.includeSuperseded) where.push('superseded_by IS NULL');
  // 2026-11-07 加（B3）：「昨天」「前天」这类由 query.mjs 的 parseTimeHint 翻成 YYYY-MM-DD 传进来
  if (opts.day) {
    where.push('at LIKE ?');
    params.push(`${String(opts.day)}%`);
  }
  if (opts.windowDays && Number(opts.windowDays) > 0) {
    where.push('at >= ?');
    const d = new Date(Date.now() - Number(opts.windowDays) * 86400000);
    params.push(d.toISOString().slice(0, 19).replace('T', ' '));
  }

  // 老库可能还没加 decay_at（0.5.0 才有这一列）；读不到就退回 last_hit / at
  const decayCol = hasMemoryColumn(store.handle(), 'decay_at') ? 'decay_at' : 'NULL AS decay_at';
  const rows = store.all(
    `SELECT id, at, speaker, text, scene, event_id, s, dec, alpha, beta, scope, status, last_hit, pinned,
            ${decayCol},
            COALESCE(oneline, substr(text, 1, 30)) AS oneline
       FROM memories
      WHERE ${where.join(' AND ')}
      LIMIT 20000`,
    ...params,
  );
  // 算 IDF —— 用候选集算，不查全表。
  //
  // 2026-11-07 实测：原来每个 token 跑一次 `SELECT count(*) WHERE text LIKE`，
  // 13.6 万条时要 2.3~4.8 秒。改成在已拿到的候选里数，一次 SQL 都不用。
  // 代价是 df 只反映候选集而不是全库，但 IDF 本来就是相对权重，够用。
  const df = new Map();
  for (const t of tokArr) {
    let c = 0;
    for (const row of rows) {
      if (String(row.text ?? '').toLowerCase().includes(t)) c++;
    }
    df.set(t, c);
  }
  const N = Math.max(rows.length, 1);
  /**
   * 词的权重。
   *
   * 2026-11-07 修一个真 bug：候选是**用查询词 LIKE 筛出来的**，
   * 所以查询词在候选集里 df 等于 N，`log((N+1)/(N+1)) = 0` ——
   * 只查一个词的时候（比如「备份」）整个分数归零，排序退化成按时间倒序，
   * 看起来就像「检索根本没在工作」（实测 score 全是 0）。
   *
   * 所以：查询原词给固定底权重（长词 1、单字 0.35），
   * 真正的 IDF 只算**扩展进来的同义词**——它们不是粗筛条件，df 才有区分度。
   */
  const idf = (t) => {
    const d = df.get(t) ?? 0;
    const raw = Math.log((N + 1) / (d + 1));
    if (rawTokens.has(t)) return Math.max(raw, t.length >= 2 ? 1 : 0.35);
    return raw;
  };

  // 逐条打分
  const scored = rows.map((row) => {
    const text = String(row.text ?? '').toLowerCase();
    let idfSum = 0;
    const matched = [];
    for (const t of tokArr) {
      if (text.includes(t)) {
        idfSum += idf(t);
        matched.push(t);
      }
    }
    const alpha = Number(row.alpha ?? 0.5);
    const beta = Number(row.beta ?? 0);
    // beta < 0 打折（玩笑/过时/外部），beta > 0 略微加权，都是温和的
    const betaFactor = beta >= 0 ? 1 + Math.min(beta / 20, 0.5) : Math.max(0.5, 1 + beta / 10);
    const sunkFactor = String(row.status ?? '') === 'sunk' ? 0.4 : 1;
    // 长度归一化：不加这个，长文本会霸榜
    // （2026-11-07 空跑实测：「回测跑完了」那条长文在 5 个查询里 4 个排第一，
    //   因为它字多、什么都沾一点。用 1/(1+len/400) 压，比 sqrt 版更狠。）
    const len = Math.max(text.length, 1);
    const lengthFactor = 1 / (1 + len / 400);
    // 时间衰减（2026-11-07，B3）：只有查询里带「上次 / 最近」这类词才生效。
    // 不当默认开 —— 翻旧账（"当初怎么定的"）时把新的往上推反而错。
    let recencyFactor = 1;
    if (recency > 0) {
      const t = Date.parse(String(row.at ?? '').replace(' ', 'T'));
      if (Number.isFinite(t)) {
        const ageDays = Math.max((Date.now() - t) / 86400000, 0);
        recencyFactor = 1 + recency * (1 / (1 + ageDays / 90));
      }
    }
    // 时间衰减（2026-11-07，0.5.0）：基础分 × 0.5^(已流逝天数 / 半衰期)
    //
    // 基准是 `decay_at` —— 不是写入时间，是「复习回血」维护的那个点：
    // 被命中时把已流逝的天数折半，所以常被取到的记忆衰得慢，长期不碰的才往下掉。
    // 没有 decay_at 就退回 last_hit，再没有用 at。
    let decayFactor = 1;
    // 手工钉住的（pinned）不衰减 —— 那是人判过「这条到今天仍有效」的，不该被时间压
    if (decayOn && Number(row.pinned ?? 0) !== 1) {
      const baseT = Date.parse(String(row.decay_at ?? row.last_hit ?? row.at ?? '').replace(' ', 'T'));
      if (Number.isFinite(baseT)) {
        const ageDays = Math.max((Date.now() - baseT) / 86400000, 0);
        decayFactor = Math.pow(0.5, ageDays / halfLifeDays);
      }
    }
    // alpha 权重（2026-11-07 实测）：0.5~1.0 这一档是对的。
    // 试过压到 0.85~1.0（几乎忽略重要度）→ 20 条换说法测试的 top1 命中从 6 掉到 3，
    // 说明「重要度」这路信号真在帮忙，别再往下压。
    const score =
      idfSum * lengthFactor * (0.5 + alpha * 0.5) * betaFactor * sunkFactor * recencyFactor * decayFactor;
    return { row, score, matched, idfSum, decayFactor };
  });

  scored.sort((a, b) => b.score - a.score || String(b.row.at).localeCompare(String(a.row.at)));
  const top = scored.slice(0, limit);

  // 匹配质量（2026-11-07，B4）：查询里的长词（≥2 字）有几个在返回的这几条里真撞上了。
  // 真命中通常接近 1；「外星人水晶球 塞浦路斯」这种只撞到零散字的是 0.2~0.5。
  // 调用方靠它判断「该不该直说没记过」——分数会被同义词和长度归一搅浑，这个比例更直观。
  const longTokens = tokArr.filter((t) => t.length >= 2);
  const hitLong = new Set();
  for (const h of top) for (const m of h.matched) if (m.length >= 2) hitLong.add(m);
  const longHitRate = longTokens.length ? Math.round((hitLong.size / longTokens.length) * 100) / 100 : 1;

  // 记账：被检索出来的这些，hits +1、last_hit 更新
  // （record: false 时不记 —— 「探测一下有没有」这种查询不该给 hits 灌水）
  if (opts.record !== false) recordHits(top.map((h) => Number(h.row.id)));

  return {
    hits: top.map((h) => ({
      id: Number(h.row.id),
      at: String(h.row.at ?? ''),
      speaker: Number(h.row.speaker ?? 0),
      oneline: String(h.row.oneline ?? ''),
      text: String(h.row.text ?? ''),
      scene: String(h.row.scene ?? ''),
      scope: String(h.row.scope ?? ''),
      // 挂在哪件事上（0 = 没挂事）；关系路靠它做一跳
      eventId: Number(h.row.event_id ?? 0),
      alpha: Number(h.row.alpha ?? 0),
      beta: Number(h.row.beta ?? 0),
      score: Math.round(h.score * 100) / 100,
      // 这条被衰减乘了多少（1 = 没衰，0.5 = 打五折）
      decay: Math.round((h.decayFactor ?? 1) * 1000) / 1000,
      matched: h.matched,
    })),
    meta: {
      query: q,
      tokens: tokArr,
      expandedFrom: [...rawTokens].filter((t) => !tokArr.includes(t)).length ? [...rawTokens] : undefined,
      candidates: rows.length,
      total: N,
      recency,
      windowDays: Number(opts.windowDays) || 0,
      // 0.5.0 时间衰减：0 = 这次没开（要么没这列，要么翻旧账时被关了）
      halfLifeDays: decayOn ? halfLifeDays : 0,
      // 最高分（2026-11-07，B4）：真命中实测 5~7 分，只撞到零散字是 0.2~2.4。
      // 调用方靠它区分「真撞上了」和「只是字面沾边」。
      topScore: scored.length ? Math.round(scored[0].score * 100) / 100 : 0,
      // 长词命中率（0~1）：查询里的长词有几个在结果里真撞上了（见上面注释）
      longHitRate,
      tookMs: Date.now() - t0,
    },
  };
}

/**
 * 关系路（2026-11-07，B1/B2）：从命中的话跳到「同一件事」的其他话
 *
 * 判据原文是「A→B→C 能串起来，不是只命中字面」。
 * 词法检索只能命中**含查询词**的话——同一件事里那些不含查询词的话就永远捞不出来。
 * 例：问「备份那天」时命中了含「备份」的一条，同事件里的「Copy-Item 拿到的是旧快照，
 * 得用 VACUUM INTO」这条不含「备份」，靠字面永远进不来，但它是同一个答案的另一半。
 *
 * **只跳一跳，且限量**：一个事件可能几百条话，不收着点会把上下文撑爆。
 *
 * @param {{ all: Function }} store
 * @param {Array<{ id: number, eventId: number }>} hits
 * @param {{ maxEvents?: number, perEvent?: number }} [opts]
 * @returns {{ items: Array<Record<string, unknown>>, eventCount: number }}
 */
export function relatedByEvent(store, hits, opts = {}) {
  const maxEvents = Math.min(Math.max(Number(opts.maxEvents) || 3, 1), 10);
  const perEvent = Math.min(Math.max(Number(opts.perEvent) || 3, 1), 10);
  const eventIds = [...new Set((hits ?? []).map((h) => Number(h.eventId ?? 0)).filter(Boolean))].slice(
    0,
    maxEvents,
  );
  if (!eventIds.length) return { items: [], eventCount: 0 };

  const hitIds = new Set((hits ?? []).map((h) => Number(h.id)));
  const ph = eventIds.map(() => '?').join(',');
  // 每个事件总共多少条（给「还有 N 条没列」用）
  const totals = new Map(
    store
      .all(
        `SELECT event_id, COUNT(*) AS c FROM memories
          WHERE event_id IN (${ph})
            AND COALESCE(status, 'active') <> 'sunk'
            AND superseded_by IS NULL
          GROUP BY event_id`,
        ...eventIds,
      )
      .map((r) => [Number(r.event_id), Number(r.c)]),
  );
  const rows = store.all(
    `SELECT m.id, m.at, m.speaker, m.text, m.scope, m.event_id, e.name AS event_name
       FROM memories m
       LEFT JOIN events e ON e.id = m.event_id
      WHERE m.event_id IN (${ph})
        AND COALESCE(m.status, 'active') <> 'sunk'
        AND m.superseded_by IS NULL
      ORDER BY m.event_id ASC, COALESCE(m.alpha, 0.5) DESC, m.at DESC`,
    ...eventIds,
  );

  const used = new Map();
  const items = [];
  for (const r of rows) {
    const eid = Number(r.event_id);
    if (hitIds.has(Number(r.id))) continue; // 已经出现过的，不重复给
    const n = used.get(eid) ?? 0;
    if (n >= perEvent) continue;
    used.set(eid, n + 1);
    items.push({
      id: Number(r.id),
      at: String(r.at ?? ''),
      speaker: Number(r.speaker ?? 0),
      text: String(r.text ?? ''),
      scope: String(r.scope ?? ''),
      eventId: eid,
      eventName: String(r.event_name ?? ''),
      eventTotal: totals.get(eid) ?? 0,
      via: `同事件「${String(r.event_name ?? '')}」`,
    });
    if (items.length >= maxEvents * perEvent) break;
  }
  return { items, eventCount: eventIds.length };
}
