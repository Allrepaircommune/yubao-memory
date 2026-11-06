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

/** 识海库路径（跟 query.mjs 的 DEFAULT_DB_PATH 一致） */
const DB_PATH = 'I:\\鱼宝的记忆\\sea2.db';

/**
 * 记账：哪些记忆被检索命中了（2026-11-07 加）
 *
 * 为什么需要：老爸定的「半年没提就归档」要靠它判——没有命中记录就判不了。
 * 现在 hits 字段全是 1、last_hit 全空，等于没记账。
 *
 * 为什么单独开连接：query.mjs 的铁律是"只读"，不能为了记账破例；
 * 这里自己开一个短连接，写完就关，失败了也不影响检索结果。
 *
 * @param {Array<number>} ids
 */
export function recordHits(ids) {
  const list = (ids ?? []).filter((x) => Number.isFinite(Number(x)));
  if (!list.length) return;
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
    // 存本地时间（库里的 at 全是北京时间，别混进 UTC —— 2026-11-07 踩过）
    const at = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const stmt = db.prepare(
      'UPDATE memories SET hits = COALESCE(hits, 0) + 1, last_hit = ? WHERE id = ?',
    );
    db.exec('BEGIN');
    for (const id of list) stmt.run(at, Number(id));
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
  if (opts.windowDays && Number(opts.windowDays) > 0) {
    where.push('at >= ?');
    const d = new Date(Date.now() - Number(opts.windowDays) * 86400000);
    params.push(d.toISOString().slice(0, 19).replace('T', ' '));
  }

  const rows = store.all(
    `SELECT id, at, speaker, text, scene, event_id, s, dec, alpha, beta, scope, status,
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
  const idf = (t) => {
    const d = df.get(t) ?? 0;
    return Math.log((N + 1) / (d + 1));
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
    const score = idfSum * lengthFactor * (0.5 + alpha * 0.5) * betaFactor * sunkFactor;
    return { row, score, matched, idfSum };
  });

  scored.sort((a, b) => b.score - a.score || String(b.row.at).localeCompare(String(a.row.at)));
  const top = scored.slice(0, limit);

  // 记账：被检索出来的这些，hits +1、last_hit 更新
  recordHits(top.map((h) => Number(h.row.id)));

  return {
    hits: top.map((h) => ({
      id: Number(h.row.id),
      at: String(h.row.at ?? ''),
      speaker: Number(h.row.speaker ?? 0),
      oneline: String(h.row.oneline ?? ''),
      text: String(h.row.text ?? ''),
      scene: String(h.row.scene ?? ''),
      scope: String(h.row.scope ?? ''),
      alpha: Number(h.row.alpha ?? 0),
      beta: Number(h.row.beta ?? 0),
      score: Math.round(h.score * 100) / 100,
      matched: h.matched,
    })),
    meta: {
      query: q,
      tokens: tokArr,
      expandedFrom: [...rawTokens].filter((t) => !tokArr.includes(t)).length ? [...rawTokens] : undefined,
      candidates: rows.length,
      total: N,
      tookMs: Date.now() - t0,
    },
  };
}
