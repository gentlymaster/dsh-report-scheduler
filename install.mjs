/**
 * install.mjs — 一键把 dsh-report-scheduler 装进 DSH Desktop（zip 分发用，免手工改文件）
 *
 * 做的事：
 *   1. 找到 DSH_HOME、DSH 应用目录、自带 node 与 dsh CLI
 *   2. 把插件包复制到 ~/.dsh/plugins/dsh-report-scheduler（可用 --target 改）
 *   3. 往 profile 的 package.json 里加：link 依赖 + tweetnacl-sealedbox-js + bundles 条目
 *   4. 在 profile 目录跑一次 pnpm install（走 dsh CLI，不需要用户装 pnpm）
 *   5. 打印下一步（重启 DSH Desktop，然后在设置里配置）
 *
 * 用法：
 *   node install.mjs                       # 默认装进 web profile
 *   node install.mjs --profile headless    # 换 profile
 *   node install.mjs --dry                 # 只打印将要做的改动
 *   node install.mjs --dsh-home "D:\dsh"   # 指定 DSH_HOME
 */
import { readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_NAME = 'dsh-report-scheduler';
const RUNTIME_DEP = 'tweetnacl-sealedbox-js';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const DRY = argv.includes('--dry');
const SKIP_INSTALL = argv.includes('--no-install');
const PROFILE = argValue('--profile', 'web');
const TARGET = resolve(argValue('--target', join(homedir(), '.dsh', 'plugins', PACKAGE_NAME)));
const DSH_HOME = resolve(argValue('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')));

function log(message) { console.log(message); }
function fail(message) { console.error('✗ ' + message); process.exitCode = 1; }

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

log('dsh-report-scheduler 安装器');
log('  DSH_HOME ：' + DSH_HOME);
log('  目标目录 ：' + TARGET);
log('  profile  ：' + PROFILE);
log('');

// 插件包来源：zip 里是 <根>/plugin，从仓库克隆时就是脚本自己所在的目录
const PLUGIN_SRC = (await exists(join(HERE, 'plugin'))) ? join(HERE, 'plugin') : HERE;
log('  插件来源 ：' + PLUGIN_SRC);
log('');

if (!(await exists(join(PLUGIN_SRC, 'package.json')))) {
  fail(`在 ${PLUGIN_SRC} 里找不到 package.json，请把 install.mjs 和插件文件放在一起再运行`);
  process.exit(1);
}

// 1) 环境探测：让插件自己的探测逻辑干活（它会读 .desktop-bin/node.cmd 找应用目录）
process.env.DSH_HOME = DSH_HOME;
const { detectPaths, profileDir } = await import(pathToFileURL(join(PLUGIN_SRC, 'lib', 'paths.mjs')).href);
const paths = await detectPaths();
if (!paths.dshCli) {
  fail('找不到 DSH 安装目录里的 dsh CLI（bin.js）；请确认 DSH Desktop 已装好并在本机运行过至少一次，或用 --dsh-home 指定正确的 DSH_HOME');
  process.exit(1);
}
log('✓ 环境：');
log('    appDir  ：' + (paths.appDir || '(未知)'));
log('    node    ：' + paths.node + '（' + paths.nodeKind + '）');
log('    dsh CLI ：' + paths.dshCli);
log('');

// 2) 复制插件包
if (DRY) {
  log('[dry] 将把插件包复制到 ' + TARGET);
} else {
  await mkdir(dirname(TARGET), { recursive: true });
  await rm(TARGET, { recursive: true, force: true });
  await cp(PLUGIN_SRC, TARGET, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes('.git') });
  log('✓ 已复制插件包 → ' + TARGET);
}

// 3) 改 profile 的 package.json
const pDir = profileDir(DSH_HOME, PROFILE);
const manifestPath = join(pDir, 'package.json');
if (!(await exists(manifestPath))) {
  fail(`找不到 profile 清单 ${manifestPath}\n  提示：先在 DSH Desktop 里打开一次「设置」（web profile 会自动创建），或用 --profile 指定已存在的 profile`);
  process.exit(1);
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];

const linkSpec = 'link:' + TARGET.replace(/\\/g, '/');
const changes = [];
if (manifest.dependencies[PACKAGE_NAME] !== linkSpec) {
  changes.push(`dependencies["${PACKAGE_NAME}"] = "${linkSpec}"`);
  manifest.dependencies[PACKAGE_NAME] = linkSpec;
}
if (!manifest.dependencies[RUNTIME_DEP]) {
  changes.push(`dependencies["${RUNTIME_DEP}"] = "^1.2.0"（写 GitHub Secrets 用，可选）`);
  manifest.dependencies[RUNTIME_DEP] = '^1.2.0';
}
if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
  changes.push(`dsh.profile.bundles += "${PACKAGE_NAME}"`);
  manifest.dsh.profile.bundles.push(PACKAGE_NAME);
}

if (changes.length === 0) {
  log('✓ profile 清单已经配好（无需改动）');
} else {
  log('✓ 将修改 ' + manifestPath + '：');
  for (const change of changes) log('    - ' + change);
  if (DRY) {
    log('[dry] 不写入');
  } else {
    // 注意：必须写成无 BOM 的 UTF-8，带 BOM 会让 profile 解析失败
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    log('✓ 已写入 profile 清单');
  }
}

// 4) pnpm install（走 dsh CLI，用户不需要自己装 pnpm）
if (SKIP_INSTALL) {
  log('· 已指定 --no-install，跳过依赖安装');
} else if (DRY) {
  log('[dry] 将在 ' + pDir + ' 执行：' + paths.node + ' ' + paths.dshCli + ' plugin --profile ' + PROFILE + ' install');
} else {
  log('· 正在安装依赖（首次约 10–60 秒）…');
  const res = await run(paths.node, [paths.dshCli, 'plugin', '--profile', PROFILE, 'install']);
  if (res.code === 0) {
    log('✓ 依赖安装完成');
  } else {
    log('! 依赖安装失败，请手动在该 profile 目录执行 pnpm install');
    log((res.stderr || res.stdout).trim().split('\n').slice(-6).join('\n'));
  }
}

log('');
log('下一步：');
log('  1. 重启 DSH Desktop');
log('  2. 打开 设置 → 定时报告 → 渠道与云端，按 ①推送 → ②密钥 → ③部署云端 → ④本机定时 配完');
log('  3. 回「任务」页新建任务（选本机或云端），到点自动生成并推送');
