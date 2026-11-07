// 5 分钟 demo —— 不用装、不用真用几天，就能看到这东西到底在干什么
//
//   node scripts/demo.mjs
//
// 它做三件事：
//   1. 在临时目录建一个**假库**（灌几十条模拟对话），不碰你自己的数据
//   2. 跑 5 个查询：撞得上的 / 换说法的 / 问没记过的 / 带时间词的 / 要跳一跳的
//   3. 把「存了什么、取回了什么、什么时候会说没记过」直接打出来
//
// 想留着自己玩：加 `--keep` 会把假库留在 %TEMP%\mindsea-demo.db，可以拿 sqlite 工具打开看。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMemorySchema } from '../lib/schema.mjs';
import { createStore, searchMemories } from '../lib/query.mjs';

const KEEP = process.argv.includes('--keep');
const DB = join(tmpdir(), 'mindsea-demo.db');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  gray: '\x1b[90m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const SCHEMA = `
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, at TEXT, speaker INTEGER, body TEXT,
  platform INTEGER, emotion TEXT, importance INTEGER, hits INTEGER DEFAULT 0, voiced INTEGER DEFAULT 0,
  unconfirmed INTEGER DEFAULT 0, origin TEXT, text TEXT, occurred TEXT, vector BLOB, digest TEXT,
  old_id TEXT, event_id INTEGER, version_id INTEGER, stage_id INTEGER, s INTEGER, dec INTEGER,
  emotion_old TEXT, place TEXT, category TEXT
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, topic TEXT,
  n INTEGER DEFAULT 0, dec_count INTEGER DEFAULT 0, first_at TEXT, last_at TEXT,
  summary TEXT, status TEXT DEFAULT 'live', last_mention TEXT, category TEXT
);
CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, name TEXT NOT NULL, n INTEGER DEFAULT 0, UNIQUE(event_id, name));
CREATE TABLE stages (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, version_id INTEGER, name TEXT NOT NULL, n INTEGER DEFAULT 0, UNIQUE(event_id, version_id, name));
CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER, event_id INTEGER, obj TEXT, text TEXT, at TEXT);
CREATE TABLE wanders (id TEXT PRIMARY KEY, at TEXT NOT NULL, start_tag TEXT, path TEXT NOT NULL, spoke INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_memories_at ON memories(at);
`;

/** 假对话：一个普通人的生活，四件事。 */
const SEED = [
  ['养猫', '2026-10-20 12:30:00', '想养一只猫，一个人住太安静了', 55],
  ['养猫', '2026-10-21 19:02:00', '去宠物店看了，有只橘猫一直蹭我手，就那种赖上你的感觉', 70],
  ['养猫', '2026-10-21 19:05:00', '决定了，把它带回家，叫豆包', 80],
  ['养猫', '2026-10-28 20:15:00', '豆包今天第一次打疫苗，哭得不行，回来一直趴我腿上', 75],
  ['养猫', '2026-11-02 18:40:00', '猫粮买错了，那个牌子它闻都不闻，白买了两袋', 60],

  ['换工作', '2026-10-25 21:10:00', '最近面试了三家，有点累', 60],
  ['换工作', '2026-10-26 22:30:00', 'B 公司给的条件最好，但通勤要一个多小时', 65],
  ['换工作', '2026-10-27 20:00:00', '决定去 B 公司了，下周一入职', 85],
  ['换工作', '2026-11-03 09:20:00', '新公司第一天，工位靠窗，能看到楼下的树', 70],

  ['学吉他', '2026-10-18 22:45:00', '想学吉他，先买了把入门的，怕自己三分钟热度', 60],
  ['学吉他', '2026-10-22 23:10:00', '和弦按得手指头疼，指腹起了一层茧', 55],
  ['学吉他', '2026-11-05 21:30:00', '终于能完整弹下来一首《晴天》了，弹了三遍', 75],

  ['身体', '2026-10-24 01:20:00', '最近老是熬夜，胃也不太舒服', 65],
  ['身体', '2026-10-30 12:40:00', '开始早上喝小米粥，胃比之前好点了', 60],
];

const QUERIES = [
  { q: '豆包打疫苗', why: '最普通的一种：词直接撞上了' },
  { q: '那只橘猫叫什么名字', why: '换一种说法 —— 句子里没有「豆包」，只有「橘猫」。找到了，但判成「只沾到边」（长词命中率不到 40%）' },
  { q: '我养过狗吗', why: '问一件根本没发生过的事 —— 看它会说什么' },
  { q: '以前 学吉他', why: '带时间词：「以前」会把窗口拉到全库' },
  { q: '入职', why: '要跳一跳：命中之后，把同一件事里没提这个词的话也捞回来' },
];

const VERDICT_TXT = {
  hit: ['✅ 命中', C.green],
  weak: ['🟡 只沾到边', C.yellow],
  empty_window: ['🟡 最近没有、更早有', C.yellow],
  empty_all: ['❌ 全库都没有 —— 这就是「没记过」', C.red],
  empty_unknown: ['⚠️ 探测失败', C.yellow],
};

function build() {
  if (existsSync(DB)) rmSync(DB, { force: true });
  for (const f of [`${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f, { force: true });

  const db = new DatabaseSync(DB);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  ensureMemorySchema(db);

  const evIds = new Map();
  for (const [name] of SEED) {
    if (evIds.has(name)) continue;
    db.prepare('INSERT INTO events (name, n) VALUES (?, 0)').run(name);
    evIds.set(name, db.prepare('SELECT id FROM events WHERE name = ?').get(name).id);
  }

  const ins = db.prepare(
    `INSERT INTO memories (at, speaker, text, event_id, importance, category, place, status, scope)
     VALUES (?, 0, ?, ?, ?, '干活', 'chat', 'active', 'private')`,
  );
  for (const [ev, at, text, imp] of SEED) ins.run(at, text, evIds.get(ev), imp);

  for (const name of evIds.keys()) {
    const r = db.prepare('SELECT COUNT(*) c, MIN(at) a, MAX(at) b FROM memories WHERE event_id = ?').get(evIds.get(name));
    db.prepare('UPDATE events SET n = ?, first_at = ?, last_at = ? WHERE id = ?').run(r.c, r.a, r.b, evIds.get(name));
  }
  db.close();
  return SEED.length;
}

function short(text, n = 44) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function main() {
  console.log(`\n${C.cyan}${C.bold}🐟 潮间带 · 5 分钟 demo${C.reset}`);
  console.log(`${C.dim}用假数据跑一遍完整链路：存 → 取 → 说「没记过」。不碰你自己的库。${C.reset}\n`);

  const n = build();
  console.log(`${C.dim}[建库] ${n} 条话 / 4 件事 → ${DB}${C.reset}`);

  const store = createStore(DB);
  let i = 0;
  for (const { q, why } of QUERIES) {
    i++;
    console.log(`\n${C.gray}${'─'.repeat(60)}${C.reset}`);
    console.log(`${C.bold}${i}/${QUERIES.length}  「${q}」${C.reset}`);
    console.log(`${C.dim}${why}${C.reset}`);

    let r;
    try {
      r = searchMemories(store, { q, pool: 'chat', limit: 5, expandEvents: 2, expandPerEvent: 2 });
    } catch (e) {
      console.log(`  ${C.red}出错了：${e.message}${C.reset}`);
      continue;
    }

    const [label, color] = VERDICT_TXT[r.verdict] ?? [r.verdict, C.gray];
    console.log(`  ${color}${label}${C.reset}${r.timeHint ? `  ${C.dim}（时间词：${r.timeHint}）${C.reset}` : ''}`);

    for (const w of r.words ?? []) {
      console.log(`    ${C.gray}${String(w.id).padStart(3)}${C.reset}  ${short(w.text)}`);
    }

    if (r.related?.length) {
      console.log(`  ${C.cyan}↳ 跳一跳（同一件事里没提这个词的）：${C.reset}`);
      for (const x of r.related) {
        console.log(`    ${C.gray}${String(x.id).padStart(3)}${C.reset}  ${C.dim}[${x.eventName}]${C.reset} ${short(x.text)}`);
      }
    }

    if (r.note) console.log(`  ${C.dim}${r.note}${C.reset}`);
  }

  // 结尾：把「它到底怎么想的」摊开
  console.log(`\n${C.gray}${'─'.repeat(60)}${C.reset}`);
  const total = store.get('SELECT COUNT(*) c FROM memories').c;
  const evs = store.get('SELECT COUNT(*) c FROM events').c;
  console.log(`${C.bold}库里现在：${C.reset}${total} 条话 / ${evs} 件事`);
  console.log(`${C.dim}上面五个查询里，第四个问的是一件根本没发生的事 ——`);
  console.log(`「全库都没有」和「暂时没找到」是两种不同的回答，这一个能分开，是整套东西里最难做的一层。${C.reset}`);

  if (KEEP) console.log(`\n${C.dim}假库留着了：${DB}${C.reset}`);
  store.close();
}

main();
