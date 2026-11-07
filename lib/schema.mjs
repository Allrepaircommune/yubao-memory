/**
 * 库结构补全（2026-11-07 建，0.5.0）
 *
 * **为什么需要这一层**：
 * 0.4.0 之后加的那些列（scope / status / kind / pinned / session / superseded_by / chat_key）
 * 当初是**手工 ALTER 上去的**，代码里没有同步。结果：
 *
 *   - 老库（`I:\鱼宝的记忆\sea2.db`）列是全的，因为当年手敲过；
 *   - 但 `scripts/init-db.mjs` 建出来的**新库缺列**，插件一读就 `no such column`；
 *   - 0.5.0 要加的 `decay_at` 也一样，不补这层，坑只会越滚越大。
 *
 * 做法：把「0.4.0 之后加过的所有列」列成一张表，缺哪个补哪个。
 * `ALTER TABLE ... ADD COLUMN` 在 SQLite 上是 O(1) 且幂等，跑一百次和跑一次一样。
 *
 * 调用点：建库（init-db.mjs）、记账（search2.mjs 的 recordHits）——都拿到**可写**连接时顺手补。
 */

/**
 * memories 表 0.4.0 之后加过的列：[列名, 类型/默认值]
 * 老库已有的跳过；新库按这张表补齐。
 */
const MEMORY_COLUMNS = [
  ['scene', 'TEXT'],
  ['summary', 'TEXT'],
  ['oneline', 'TEXT'],
  ['alpha', 'REAL'],
  ['beta', 'REAL'],
  ['last_hit', 'TEXT'],
  ['scope', 'TEXT'],
  ['status', 'TEXT'],
  ['kind', 'TEXT'],
  ['pinned', 'INTEGER DEFAULT 0'],
  ['session', 'TEXT'],
  ['superseded_by', 'INTEGER'],
  ['chat_key', 'TEXT'],
  // 0.5.0：复习回血用的衰减基准（命中时把「已流逝天数」折半，不是重置）
  ['decay_at', 'TEXT'],
  // 0.6.0：我自己听到这句话时的反应（稳/慌/想辩解/想听/高兴/难受/平）。
  // 认知演化的第一步 —— 先有「我当时的反应」，以后才能对比「同类事我变了没有」
  ['my_reaction', 'TEXT'],
];

/** 索引：[名字, ON 的列表达式] —— 建不成就跳过（列可能不在） */
const MEMORY_INDEXES = [
  ['idx_mem_pinned', 'memories(pinned)'],
  ['idx_mem_session', 'memories(session)'],
  ['idx_mem_superseded', 'memories(superseded_by)'],
  ['idx_mem_chatkey', 'memories(chat_key)'],
  ['idx_mem_decay', 'memories(decay_at)'],
];

/**
 * 把 memories 表缺的列和索引补齐。
 *
 * @param {import('node:sqlite').DatabaseSync} db 可写连接
 * @returns {string[]} 这次真加上的列名（已经有的不算）
 */
export function ensureMemorySchema(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(memories)').all().map((c) => String(c.name)));
  const added = [];
  for (const [name, type] of MEMORY_COLUMNS) {
    if (cols.has(name)) continue;
    db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
    added.push(name);
  }
  for (const [name, target] of MEMORY_INDEXES) {
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
    } catch {
      /* 列不在（老库还没补）就算了，下次再来 */
    }
  }
  return added;
}

/**
 * 只读连接上判断有没有某一列（读的时候要用，不能 ALTER）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} column
 * @returns {boolean}
 */
export function hasMemoryColumn(db, column) {
  try {
    return db.prepare('PRAGMA table_info(memories)').all().some((c) => String(c.name) === column);
  } catch {
    return false;
  }
}

export const MEMORY_SCHEMA_COLUMNS = MEMORY_COLUMNS.map(([n]) => n);
