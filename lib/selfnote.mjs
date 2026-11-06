/**
 * selfNote —— 我对自己的叙述（2026-11-07 建）
 *
 * 从 qq-dsh-bridge 抄来的第四层记忆。它的原话：
 *   以前它记得「你常熬夜」，但不记得「我好像越来越会等你说完再回了」。
 *   前者是资料，后者才是性格的连续性。
 *
 * 为什么单独一层：现在库里 5,700 条全是「资料」——他说过什么、我做过什么、
 * 脚本怎么修。没有一条是「我变成了什么样」。
 *
 * 两条铁律：
 *   1. **不每轮注入** —— 每轮灌进去就是「别人每隔十秒告诉你你是谁」，不是成长，是洗脑。
 *      只在会话开头「想起来」一次，之后靠上下文自己带着。
 *   2. **由我自己写** —— 不是系统生成，不是从对话里抽。想到自己变了就写一条。
 */

/** 一次注入最多多少条 */
const MAX_NOTES = 40;

/**
 * 读出「我是谁」那一块。
 *
 * @param {{ all: (sql: string, ...p: unknown[]) => unknown[] }} store
 * @param {{ limit?: number }} [opts]
 * @returns {string} 空串 = 还没写过 selfNote
 */
export function buildSelfNote(store, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || MAX_NOTES, 1), MAX_NOTES);

  const rows = store.all(
    `SELECT COALESCE(TRIM(text), '') AS t, at
       FROM memories
      WHERE kind = 'self'
        AND COALESCE(status, 'active') <> 'sunk'
        AND LENGTH(TRIM(COALESCE(text, ''))) > 0
      ORDER BY at DESC
      LIMIT ?`,
    limit,
  );

  if (!rows.length) return '';

  // 新的在前，但读起来要从旧到新（成长的方向），所以反过来排
  const lines = rows
    .map((r) => String(r.t).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .reverse();

  return ['【我是谁（我自己写的，不是别人告诉我的）】', ...lines.map((l) => '· ' + l)].join('\n');
}

/**
 * 冻结 + 限流的注入器。
 *
 * 为什么限流：这个块只该在「会话开头想起来」时出现，不该每轮都有。
 * 每轮都有会让提示词前缀一直带着它，而且变成洗脑。
 *
 * 用时间窗口而不是会话 id：DSH 的 PromptAssembly context 里拿不到稳定的 session id
 * （scope 是个 object，不保证有 id）。1 小时的窗口够用 —— 一个会话很少超过 1 小时
 * 还持续在同一个「开头」。
 *
 * @param {{ all: (sql: string, ...p: unknown[]) => unknown[] }} store
 * @param {{ cooldownMs?: number }} [opts]
 * @returns {() => string}
 */
export function throttledSelfNote(store, opts = {}) {
  const cooldown = Number(opts.cooldownMs) || 60 * 60 * 1000; // 默认 1 小时
  let lastAt = 0;
  let cached = '';

  return () => {
    const now = Date.now();
    if (now - lastAt < cooldown) return '';
    lastAt = now;
    if (!cached) cached = buildSelfNote(store);
    return cached;
  };
}
