#!/usr/bin/env node
/**
 * 一条命令装进 DSH profile（D1）。
 *
 *   node scripts/install.mjs
 *   node scripts/install.mjs --profile "C:\Users\你\.dsh\profiles\desktop"
 *   node scripts/install.mjs --profile ... --db "D:\memory\sea2.db" --dry-run
 *
 * 它做四件事：
 *   1. 找到（或接受指定的）DSH profile 目录
 *   2. 把本包 link 进 profile 的 node_modules（Windows 用 junction，其它用 symlink）
 *   3. 把 dsh-mindsea 写进 profile package.json 的 dsh.profile.bundles
 *   4. 库不存在就建一个空的
 *
 * 不改 profile 里别的东西；改之前先把 package.json 备份成 .bak-<时间戳>。
 * 全程只碰文件，不起任何服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG_NAME = 'dsh-mindsea';

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const wantProfile = flag('profile');
const wantDb = flag('db');
const dryRun = has('dry-run');

const log = (...a) => console.log(...a);
const ok = (s) => log(`  ✓ ${s}`);
const warn = (s) => log(`  ! ${s}`);
const bad = (s) => log(`  ✗ ${s}`);

// ── 1. 找 profile ───────────────────────────────────────────────────────────
function findProfiles() {
  const root = path.join(os.homedir(), '.dsh', 'profiles');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
    .filter((p) => {
      const pkg = path.join(p, 'package.json');
      if (!fs.existsSync(pkg)) return false;
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        return Boolean(j?.dsh?.profile?.bundles);
      } catch {
        return false;
      }
    });
}

log(`\n安装 ${PKG_NAME}`);
log(`  包目录: ${PKG_DIR}\n`);

let profile = wantProfile;
if (!profile) {
  const found = findProfiles();
  if (found.length === 0) {
    bad('没找到任何 DSH profile（默认在 ~/.dsh/profiles/ 下，且 package.json 里要有 dsh.profile.bundles）');
    log('\n用 --profile <目录> 直接指定：');
    log('  node scripts/install.mjs --profile "C:\\Users\\你\\.dsh\\profiles\\desktop"');
    process.exit(1);
  }
  if (found.length === 1) {
    profile = found[0];
    log(`找到唯一的 profile: ${profile}`);
  } else {
    warn(`找到 ${found.length} 个 profile，请用 --profile 指定一个：`);
    for (const p of found) log(`    ${p}`);
    process.exit(1);
  }
}

profile = path.resolve(profile);
const profilePkg = path.join(profile, 'package.json');
if (!fs.existsSync(profilePkg)) {
  bad(`这个目录里没有 package.json：${profile}`);
  process.exit(1);
}

// ── 2. link 进 node_modules ─────────────────────────────────────────────────
const nm = path.join(profile, 'node_modules');
const linkPath = path.join(nm, PKG_NAME);
log(`\n[1/4] link 插件`);
log(`  ${linkPath}`);
log(`    -> ${PKG_DIR}`);

if (dryRun) {
  log('  (--dry-run，不真做)');
} else {
  fs.mkdirSync(nm, { recursive: true });
  let existed = false;
  try {
    const st = fs.lstatSync(linkPath);
    existed = true;
    if (st.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else if (st.isDirectory()) {
      warn(`${linkPath} 是一个真实目录（不是 link），不覆盖；如果你之前 npm install 过，先删掉它`);
      existed = 'dir';
    }
  } catch {
    /* 不存在，正常 */
  }
  if (existed !== 'dir') {
    fs.symlinkSync(PKG_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    ok(existed ? 'link 已重建' : 'link 已创建');
  }
}

// ── 3. 写进 bundles ────────────────────────────────────────────────────────
log(`\n[2/4] 写进 profile 的 dsh.profile.bundles`);
const pkgText = fs.readFileSync(profilePkg, 'utf8');
const profileJson = JSON.parse(pkgText);
const bundles = profileJson?.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) {
  bad('profile package.json 里没有 dsh.profile.bundles 数组');
  process.exit(1);
}

if (bundles.includes(PKG_NAME)) {
  ok('已经在 bundles 里了，不重复加');
} else if (dryRun) {
  log(`  (--dry-run) 会把 "${PKG_NAME}" 追加到 bundles 末尾`);
} else {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(profilePkg, `${profilePkg}.bak-${stamp}`);
  bundles.push(PKG_NAME);
  fs.writeFileSync(profilePkg, `${JSON.stringify(profileJson, null, 2)}\n`, 'utf8');
  ok(`已追加（原文件备份成 package.json.bak-${stamp}）`);
}

// ── 4. 建库 ────────────────────────────────────────────────────────────────
log(`\n[3/4] 记忆库`);
const dbPath = wantDb ? path.resolve(wantDb) : path.join(PKG_DIR, '..', 'sea2.db');
if (fs.existsSync(dbPath)) {
  const size = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2);
  ok(`已存在，不动它：${dbPath}（${size} MB）`);
} else if (dryRun) {
  log(`  (--dry-run) 会在 ${dbPath} 建一个空库`);
} else {
  const init = path.join(PKG_DIR, 'scripts', 'init-db.mjs');
  if (!fs.existsSync(init)) {
    bad(`找不到建库脚本：${init}`);
  } else {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, ['--experimental-sqlite', init, dbPath], { stdio: 'inherit' });
    if (r.status === 0) ok(`空库已建：${dbPath}`);
    else bad(`建库失败（退出码 ${r.status}）`);
  }
}

// ── 4. 写进 cordis.patch.yml ───────────────────────────────────────────────
// 2026-11-07 加：以前收尾会让用户「手动确认 yml 里有这一段」——那就是最高的那级门槛。
// 现在能自动写就自动写，写不了（格式不认识 / 文件不在）才退回打印让人贴。
log(`\n[4/4] 写进 cordis.patch.yml`);
const patchPath = path.join(profile, 'cordis.patch.yml');
const yamlBlock = (p) =>
  `\n- id: mindsea\n  name: ${PKG_NAME}\n  config:\n    dbPath: '${p.replace(/\\/g, '/')}'\n    autoCapture: true\n`;
let patchState = 'missing';

if (fs.existsSync(patchPath)) {
  const text = fs.readFileSync(patchPath, 'utf8');
  if (/\bid:\s*mindsea\b/.test(text)) {
    patchState = 'exists';
    ok('已经有 mindsea 段，不重复写');
    if (!/dbPath\s*:/.test(text)) warn('但没看到 dbPath —— 库不在默认位置的话，得手动补一行');
  } else if (!/^\s*-\s+id\s*:/m.test(text)) {
    // 不是「- id:」数组格式（可能是 group / isolate 之类的结构），不敢瞎追加
    patchState = 'unknown';
    warn('这个 yml 不是「- id:」数组格式，不自动改。把下面这段手动贴进去：');
    log(yamlBlock(dbPath));
  } else if (dryRun) {
    patchState = 'dry';
    log('  (--dry-run) 会把 mindsea 段追加到末尾');
  } else {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(patchPath, `${patchPath}.bak-${stamp}`);
    fs.writeFileSync(patchPath, `${text.trimEnd()}\n${yamlBlock(dbPath)}`, 'utf8');
    patchState = 'added';
    ok(`已追加（原文件备份成 cordis.patch.yml.bak-${stamp}）`);
  }
} else {
  warn(`没找到 ${patchPath} —— 需要你自己建一个，里面写：`);
  log(yamlBlock(dbPath));
}

// ── 收尾 ───────────────────────────────────────────────────────────────────
log(`\n完成。`);
if (patchState === 'added' || patchState === 'exists' || patchState === 'dry') {
  log(`还剩一步：重启 DSH（或者用 plugin_manager 把 include:mindsea 关一次再开）`);
  log(`重启后侧边栏会出现「潮间带」入口。`);
} else {
  log(`还剩两步：①把上面那段贴进 cordis.patch.yml ②重启 DSH`);
}
log('');
