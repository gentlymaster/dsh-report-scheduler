/**
 * paths.mjs — 本机环境探测（零依赖）
 *
 * 目的：插件装到别人机器上时，自动找到 node、DSH CLI、profile 目录、应用目录，
 * 不需要用户手工填任何路径。
 */
import { access, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 插件根目录（含 runtime/ 与 runner/） */
export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** 本机运行文件（会被安装到 ~/.dsh/dsh-report-scheduler） */
export const RUNTIME_DIR = join(PLUGIN_DIR, 'runtime');
/** 云端运行文件（会被上传到用户的 GitHub 仓库） */
export const RUNNER_DIR = join(PLUGIN_DIR, 'runner');

const WIN = process.platform === 'win32';

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    try {
      await access(candidate);
      return candidate;
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

async function packageVersion(manifestPath) {
  if (!manifestPath) return undefined;
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')).version;
  } catch {
    return undefined;
  }
}

/**
 * 从 $DSH_HOME/.desktop-bin/node.cmd 里抠出 DSH 自带 node 的绝对路径。
 * 这是最可靠的一条线索：node 就在应用目录里的 node_modules/node/bin/ 下。
 */
async function appDirFromDesktopBin(dshHome) {
  const text = await readText(join(dshHome, '.desktop-bin', 'node.cmd'));
  if (!text) return '';
  const match = text.match(/"([^"\r\n]*node(?:\.exe)?)"/i);
  if (!match) return '';
  // <app>/node_modules/node/bin/node.exe → 上溯三级
  return join(dirname(match[1]), '..', '..', '..');
}

/**
 * 猜测 DSH 应用目录（含 node_modules/@deepseek-ai/dsh）。
 * 依次尝试：.desktop-bin 线索 → Electron resourcesPath → 从 node.exe 位置反推 → 常见安装目录。
 */
async function guessAppDir(execPath, homeDir, dshHome) {
  const candidates = [];
  const fromDesktopBin = dshHome ? await appDirFromDesktopBin(dshHome) : '';
  if (fromDesktopBin) candidates.push(fromDesktopBin);

  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resourcesPath) candidates.push(join(resourcesPath, 'app'));

  const base = execPath ? execPath.split(/[\\/]/).pop() ?? '' : '';
  if (/^node(\.exe)?$/i.test(base)) {
    // <app>/node_modules/node/bin/node.exe → 上溯三级
    candidates.push(join(dirname(execPath), '..', '..', '..'));
    candidates.push(join(dirname(execPath), '..', '..', '..', '..'));
  } else if (execPath) {
    // Electron 宿主：<root>/DSH Desktop.exe → <root>/resources/app
    candidates.push(join(dirname(execPath), 'resources', 'app'));
  }
  if (WIN) {
    candidates.push('C:\\Program Files\\DSH Desktop\\resources\\app');
    candidates.push('C:\\Program Files\\dsh-desktop\\resources\\app');
    candidates.push(join(homeDir, 'AppData', 'Local', 'Programs', 'dsh-desktop', 'resources', 'app'));
    candidates.push(join(homeDir, 'AppData', 'Local', 'dsh-desktop', 'resources', 'app'));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(join(candidate, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
      return candidate;
    } catch { /* 试下一个 */ }
  }
  return '';
}

/** 读文本文件，读不到就返回空串。 */
async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 探测本机环境。
 * @returns {Promise<object>}
 */
export async function detectPaths() {
  const home = homedir();
  const dshHome = (process.env.DSH_HOME ?? '').trim() || join(home, '.dsh');
  const appDir = await guessAppDir(process.execPath, home, dshHome);

  const node = await firstExisting([
    appDir && join(appDir, 'node_modules', 'node', 'bin', 'node.exe'),
    appDir && join(appDir, 'node_modules', 'node', 'bin', 'node'),
    process.env.DSH_NODE,
    process.execPath,
    WIN && 'C:\\Program Files\\nodejs\\node.exe',
    WIN && join(home, 'AppData', 'Local', 'Programs', 'nodejs', 'node.exe'),
    !WIN && '/usr/local/bin/node',
    !WIN && '/usr/bin/node',
  ]);

  const dshCli = await firstExisting([
    appDir && join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    process.env.DSH_CLI,
  ]);

  const bundleVersions = {
    base: await packageVersion(appDir ? join(appDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json') : undefined),
    headless: await packageVersion(appDir ? join(appDir, 'node_modules', '@deepseek-ai', 'dsh-headless', 'package.json') : undefined),
    dsh: await packageVersion(appDir ? join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json') : undefined),
  };

  const nodeBase = node ? node.split(/[\\/]/).pop() ?? '' : '';
  /** bundled = DSH 自带的 node.exe；system = 用户自己装的 node；electron = 宿主自身 */
  const nodeKind = !node
    ? 'none'
    : /^node(\.exe)?$/i.test(nodeBase)
      ? (node.includes('node_modules') ? 'bundled' : 'system')
      : 'electron';

  return {
    dshHome,
    appDir,
    node,
    nodeKind,
    dshCli,
    bundleVersions,
    platform: process.platform,
    homeDir: home,
  };
}

/** profile 目录（默认 headless）。 */
export function profileDir(dshHome, profile) {
  return join(dshHome, 'profiles', profile || 'headless');
}
