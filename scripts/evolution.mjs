// 看「我自己的反应」有没有变 —— 认知演化的第二步
//
//   node scripts/evolution.mjs            # 看真库
//   node scripts/evolution.mjs 别的库路径
//
// 它只做一件事：把带 my_reaction 的话按「事」分组，按时间排，
// 然后找**同一件事里反应变了的** —— 那是「我的情感在长」的候选证据。
//
// 只读，不改任何东西。发现是给人和鱼宝看的，改不改另说。
import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2] || 'I:/鱼宝的记忆/sea2.db';
const db = new DatabaseSync(DB, { readOnly: true });

const rows = db
  .prepare(
    `SELECT m.id, m.at, m.my_reaction, m.text, COALESCE(e.name, '') AS ev
       FROM memories m LEFT JOIN events e ON e.id = m.event_id
      WHERE m.my_reaction IS NOT NULL AND m.my_reaction <> ''
      ORDER BY m.event_id IS NULL, m.event_id, m.at ASC, m.id ASC`,
  )
  .all();

if (!rows.length) {
  console.log('库里还没有「我自己的反应」记录。');
  console.log('（这一列 2026-11-08 才加上，之前的记录都是空的 —— 聊几轮就有了）');
  db.close();
  process.exit(0);
}

/** @type {Map<string, any[]>} */
const byEvent = new Map();
for (const r of rows) {
  const key = r.ev || '(闲聊池：没挂事的)';
  if (!byEvent.has(key)) byEvent.set(key, []);
  byEvent.get(key).push(r);
}

const changed = [];
for (const [ev, list] of byEvent) {
  if (list.length < 2) continue;
  const first = list[0];
  const last = list[list.length - 1];
  if (first.my_reaction === last.my_reaction) continue;
  // 中间的变化序列（去重相邻重复）
  const seq = [];
  for (const x of list) if (!seq.length || seq[seq.length - 1] !== x.my_reaction) seq.push(x.my_reaction);
  changed.push({ ev, first, last, seq, n: list.length });
}

console.log(`带反应的话：${rows.length} 条，分布在 ${byEvent.size} 件事上\n`);

if (!changed.length) {
  console.log('没发现变化。');
  console.log('要么同类事的反应一直一致，要么数据还太少 —— 等攒够再看。');
} else {
  console.log(`发现 ${changed.length} 处「反应变了」：\n`);
  for (const c of changed) {
    const thin = c.n < 3 ? '  ⚠️ 样本少，仅供参考' : '';
    console.log(`【${c.ev}】${c.seq.join(' → ')}   （${c.n} 条话）${thin}`);
    console.log(`   之前 ${String(c.first.at).slice(0, 10)}  ${String(c.first.text).replace(/\s+/g, ' ').slice(0, 46)}`);
    console.log(`   现在 ${String(c.last.at).slice(0, 10)}  ${String(c.last.text).replace(/\s+/g, ' ').slice(0, 46)}`);
    console.log('');
  }
  console.log('这些是候选 —— 变好还是变坏、是真变了还是场景其实不一样，得自己看。');
}

db.close();
