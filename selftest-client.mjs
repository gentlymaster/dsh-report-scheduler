/**
 * selftest-client.mjs — 不开浏览器、不重启 DSH，直接渲染面板代码
 *
 * 做法：用极简 React 替身（useState 按顺序喂预设值 + createElement/渲染器）
 * 把 lib/client.js 里的真实面板组件渲染成字符串，然后断言关键 UI 块都在。
 * 目的：改面板后先在这里抓到「少了个卡片 / 变量名写错 / 组件抛异常」。
 *
 * 用法：node selftest-client.mjs
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ── 1. 加载真实面板代码，拿到 ModuleLoader 的 factory ───────────── */
const code = await readFile(join(HERE, 'lib', 'client.js'), 'utf8');
let loaded;
const fakeWindow = { __ModuleLoader__: { load: (mod) => { loaded = mod; } } };
new Function('window', code)(fakeWindow);
if (!loaded?.factory) throw new Error('client.js 没有注册 __ModuleLoader__ 模块');

/* ── 2. 极简 React 替身 ──────────────────────────────────────────── */
function makeReact(queue) {
  let index = 0;
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      const value = index < queue.length ? queue[index] : initial;
      index += 1;
      return [value, () => {}];
    },
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); },
    useEffect() {},
    useRef(value) { return { current: value }; },
  };
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node) + ' ';
  if (Array.isArray(node)) return node.map(render).join('');
  if (typeof node.type === 'function') return render(node.type(node.props));
  if (typeof node.type === 'symbol') return render(node.props?.children);
  return render(node.props?.children);
}

/* ── 3. 预设状态（顺序 = 组件里 useState 的调用顺序） ─────────────── */
const config = {
  dshHome: 'C:\\Users\\demo\\AppData\\Roaming\\dsh-desktop\\harness',
  dshCli: 'C:\\App\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  nodePath: 'C:\\App\\resources\\app\\node_modules\\node\\bin\\node.exe',
  profile: 'headless',
  timeoutMinutes: 12,
  checkIntervalMinutes: 15,
  push: { provider: 'serverchan', token: 'SCTdemo', title: 'DSH 定时报告' },
  archive: { enabled: true, vaultPath: 'C:\\Users\\demo\\Documents\\Obsidian Vault', subfolder: 'AI 简报' },
  cloud: { repoName: 'dsh-cloud-report', branch: 'main', model: 'deepseek-v4-flash', searchProvider: 'tavily', searchDepth: 'advanced', keyStore: 'auto', reportTitle: 'DSH 云端简报', taskName: 'DSH-Report-Dispatcher', useDshCredential: true },
  tasks: [
    { id: 'f-11', name: '氟化工周报', enabled: true, where: 'cloud', schedule: { type: 'weekly', time: '09:00', weekday: 5 }, prompt: '写周报', sources: ['news'] },
    { id: 'f-01', name: '考公信息', enabled: true, where: 'cloud', schedule: { type: 'weekly', time: '08:00', weekday: 1 }, prompt: '写考公信息', sources: ['news'] },
  ],
};

const status = { plan: { now: '2026-09-13 01:00', tasks: [{ id: 'f-11', due: false, reason: '云端任务（由 GitHub 执行）' }] }, state: { tasks: {} }, log: ['TICK 无任务到点'] };
const cloudConnected = { connected: true, owner: 'demo', repo: 'dsh-cloud-report', branch: 'main', tokenMasked: 'github_pa...N8KS', private: true, lastSync: { at: '2026-09-13T01:00:00.000Z', tasks: 3 }, remoteTasks: [{ id: 'f-11' }], pendingSync: [], runs: [], ok: true };
const cloudOff = { connected: false };
const stats = { summary: { today: { runs: 2, ok: 2, failed: 0, tokensIn: 100, tokensOut: 10, tokensCached: 0, cny: 0.01, ms: 1000 }, window: { runs: 5, ok: 5, failed: 0, tokensIn: 500, tokensOut: 50, tokensCached: 0, cny: 0.05, ms: 5000 }, all: { runs: 6, ok: 5, failed: 1, tokensIn: 600, tokensOut: 60, tokensCached: 0, cny: 0.06, ms: 6000 } }, localCount: 2, cloudCount: 4, entries: [] };
const setupState = { platform: 'win32', windows: true, node: 'C:\\App\\...\\node.exe', nodeKind: 'bundled', dshCli: 'C:\\App\\...\\bin.js', dshHome: config.dshHome, appDir: 'C:\\App', bundleVersions: { base: '0.1.2-rc.1' }, profile: 'headless', profileReady: true, runtimeVersion: '3', runtimeInstalled: true, runtimeHave: '3', tickCmd: true, task: { supported: true, exists: true, name: 'DSH-Report-Dispatcher', status: 'Ready', nextRun: '2026-09-13 01:09' }, taskName: 'DSH-Report-Dispatcher' };
const keysState = { ok: true, keys: { deepseekKey: { set: true, masked: '****2a6b' }, searchApiKey: { set: true, masked: '****abcd' }, pushToken: { set: true, masked: '****8Yvi', provider: 'serverchan' }, dshDeepseek: { available: true, masked: '****2a6b' } }, cloud: config.cloud };
const stepLogState = { ok: true, steps: [{ name: '校验 token', ok: true, detail: '已认证：demo' }, { name: '上传运行文件', ok: true, detail: 'report.mjs, cloud-dispatch.mjs' }], keyStoreUsed: 'secrets', repoUrl: 'https://github.com/demo/dsh-cloud-report' };

/** 组件里 useState 的顺序（改动组件时同步这里）。 */
function buildQueue(overrides = {}) {
  const base = {
    config,
    status,
    cloud: cloudConnected,
    stats,
    archive: config.archive,
    setup: setupState,
    keys: keysState,
    keysDraft: { deepseekKey: '', searchApiKey: '' },
    stepLog: stepLogState,
    ghToken: '',
    ghRepo: 'dsh-cloud-report',
    draft: null,
    busy: '',
    tab: 'config',
    startedAt: 0,
    nowTick: 0,
    msg: '',
    err: '',
  };
  return Object.values({ ...base, ...overrides });
}

/** 渲染一次面板并返回文本。 */
function renderPanel(overrides = {}) {
  const React = makeReact(buildQueue(overrides));
  const mod = loaded.factory((id) => {
    if (id === 'react') return React;
    throw new Error('面板请求了未提供的模块: ' + id);
  });
  let Component;
  mod.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (_meta, component) => { Component = component; },
    },
  });
  if (typeof Component !== 'function') throw new Error('组件没有注册到 settings.section');
  return render(React.createElement(Component, {}));
}

/* ── 4. 三个场景断言 ─────────────────────────────────────────────── */
const scenarios = [
  {
    label: '场景 A：渠道与云端（已连接云端）',
    overrides: {},
    must: [
      ['① 推送渠道', ['① 推送渠道', 'Server酱', '保存渠道']],
      ['② 云端密钥与搜索', ['② 云端密钥与搜索', 'DeepSeek Key', '搜索 Key', 'Tavily', '检索深度', '用 DSH 里已配置的 DeepSeek Key']],
      ['③ 已连接视图', ['③ 部署到云端', 'demo/dsh-cloud-report', '重新部署/更新运行文件', '同步任务到仓库', '云端运行一次']],
      ['④ 本机定时', ['④ 本机定时', '一键配置本机', '立即 tick', '移除计划任务', 'DSH-Report-Dispatcher']],
      ['⑤ 归档', ['⑤ 报告归档', '同步云端报告到库']],
      ['部署步骤面板', ['部署步骤', 'GitHub Actions Secrets']],
    ],
  },
  {
    label: '场景 B：渠道与云端（未连接云端）',
    overrides: { cloud: cloudOff, stepLog: null },
    must: [
      ['③ 一键部署入口', ['一键部署云端', '只连接', 'Contents 读写', 'env.json']],
      ['② 密钥仍可见', ['② 云端密钥与搜索', '保存密钥']],
    ],
  },
  {
    label: '场景 C：任务页',
    overrides: { tab: 'tasks', stepLog: null },
    must: [
      ['任务列表', ['氟化工周报', '考公信息', '云端运行', '编辑']],
      ['新建与调度', ['+ 新建任务', '手动 tick']],
    ],
  },
];

let failures = 0;
for (const scenario of scenarios) {
  console.log(`\n${scenario.label}`);
  const text = renderPanel(scenario.overrides);
  for (const [label, needles] of scenario.must) {
    const missing = needles.filter((n) => !text.includes(n));
    if (missing.length === 0) console.log(`  [PASS] ${label}`);
    else { console.log(`  [FAIL] ${label} — 缺少：${missing.join('、')}`); failures += 1; }
  }
  const dirty = ['undefined', '[object Object]', 'NaN'].filter((f) => text.includes(f));
  if (dirty.length === 0) console.log('  [PASS] 渲染无脏值（undefined / NaN）');
  else { console.log(`  [FAIL] 渲染出现脏值：${dirty.join('、')}`); failures += 1; }
  console.log(`  渲染字符数：${text.length}`);
  if (process.argv.includes('--print')) {
    console.log('  ── 渲染文本 ──');
    console.log('  ' + text.replace(/\s+/g, ' ').trim());
  }
}

console.log('');
if (failures > 0) {
  console.log(`== 面板自检失败（${failures} 项）==`);
  process.exitCode = 1;
} else {
  console.log('== 面板自检通过：三个场景的卡片、按钮与状态全部渲染正常 ==');
}
