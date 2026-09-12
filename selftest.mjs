/**
 * selftest.mjs — 不重启 DSH 也能测插件宿主侧
 * 用假 ctx/res 调用真实路由处理器，验证所有面板接口。
 *
 * 用法：node selftest.mjs
 */
import { apply } from './lib/index.js';

const routes = [];
apply({ webServer: { register: (route) => routes.push(route) } });
console.log('注册路由：', routes.map((r) => r.path).join('\n  '));

function fakeRes() {
  const state = { status: 0, body: '' };
  const done = {};
  const promise = new Promise((resolve) => { done.resolve = resolve; });
  return {
    state,
    promise,
    writeHead(status) { state.status = status; },
    end(payload) { state.body = payload; done.resolve(state); },
  };
}

function fakeReq({ method = 'GET', url = '/', body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:45924', 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
}

async function call(path, reqOptions) {
  const route = routes.find((r) => r.path === path);
  if (!route) throw new Error('路由不存在: ' + path);
  const res = fakeRes();
  await route.handler(fakeReq(reqOptions), res);
  const out = await res.promise;
  let parsed;
  try { parsed = JSON.parse(out.body); } catch { parsed = out.body; }
  return { status: out.status, body: parsed };
}

const ok = (label, detail) => console.log(`  [PASS] ${label}${detail ? ' — ' + detail : ''}`);
const bad = (label, detail) => { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); process.exitCode = 1; };
const B = '/api/dsh-report-scheduler';

console.log('\n1) GET /config');
const cfg = await call(B + '/config');
if (cfg.status === 200 && cfg.body.ok && Array.isArray(cfg.body.config.tasks)) {
  ok('配置读取', `provider=${cfg.body.config.push.provider}, 任务数=${cfg.body.config.tasks.length}, token长度=${cfg.body.config.push.token.length}`);
} else bad('配置读取', JSON.stringify(cfg).slice(0, 200));

console.log('\n2) POST /config（原样回写，幂等）');
const saved = await call(B + '/config', { method: 'POST', body: { config: cfg.body.config } });
if (saved.status === 200 && saved.body.ok) ok('配置保存', `任务数=${saved.body.config.tasks.length}`);
else bad('配置保存', JSON.stringify(saved).slice(0, 200));

console.log('\n3) POST /config 非法输入（应被清洗而非报错）');
const dirty = await call(B + '/config', {
  method: 'POST',
  body: {
    config: {
      dshHome: 'x'.repeat(600),
      profile: '',
      timeoutMinutes: 999,
      push: { provider: 'hacker', token: 123, title: '' },
      cloud: { repoName: 'bad name!!', searchProvider: '不存在的服务', searchDepth: 'nope', keyStore: 'nope' },
      tasks: [
        { id: 'BAD ID!', name: 'n', prompt: 'p' },
        { id: 'good-id', name: 'ok', prompt: 'hi', where: 'cloud', schedule: { type: 'weekly', weekday: 9, time: '99:99' } },
        { id: 'good-id', name: 'dup', prompt: 'dup' },
      ],
    },
  },
});
if (dirty.status === 200 && dirty.body.config.tasks.length === 1 && dirty.body.config.push.provider === 'none') {
  ok('非法输入被清洗', `保留任务=${dirty.body.config.tasks.map((t) => t.id).join(',')}, weekday=${dirty.body.config.tasks[0].schedule.weekday}, where=${dirty.body.config.tasks[0].where}, provider=${dirty.body.config.push.provider}, repo=${dirty.body.config.cloud.repoName}, search=${dirty.body.config.cloud.searchProvider}/${dirty.body.config.cloud.searchDepth}`);
} else bad('非法输入清洗', JSON.stringify(dirty).slice(0, 300));

console.log('\n4) 还原原配置');
const restore = await call(B + '/config', { method: 'POST', body: { config: cfg.body.config } });
if (restore.body.ok && restore.body.config.tasks.length === cfg.body.config.tasks.length) ok('配置已还原');
else bad('配置还原', JSON.stringify(restore).slice(0, 200));

console.log('\n5) GET /status（内部跑 dispatcher --plan）');
const st = await call(B + '/status');
if (st.status === 200 && st.body.ok && st.body.plan) {
  const plan = st.body.plan.tasks ?? [];
  ok('状态查询', plan.map((t) => `${t.id}:${t.due ? '待运行' : t.reason}`).join(' | '));
} else bad('状态查询', JSON.stringify(st).slice(0, 300));

console.log('\n6) 非 loopback 请求应 403');
const route = routes.find((r) => r.path === B + '/config');
const deniedRes = fakeRes();
const remoteReq = fakeReq({});
remoteReq.socket.remoteAddress = '10.0.0.5';
await route.handler(remoteReq, deniedRes);
const deniedOut = await deniedRes.promise;
if (deniedOut.status === 403) ok('远程访问被拒', 'HTTP 403');
else bad('远程访问被拒', 'HTTP ' + deniedOut.status);

console.log('\n7) POST /run 方法不符应 405');
const wrongMethod = await call(B + '/run', { method: 'GET' });
if (wrongMethod.status === 405) ok('方法校验', 'HTTP 405');
else bad('方法校验', JSON.stringify(wrongMethod).slice(0, 200));

console.log('\n8) GET /cloud/status（只看结构，连接与否都算正常）');
const cs = await call(B + '/cloud/status');
if (cs.status === 200 && cs.body.ok && typeof cs.body.cloud?.connected === 'boolean') {
  ok('云端状态', cs.body.cloud.connected ? `已连接 ${cs.body.cloud.owner}/${cs.body.cloud.repo}` : 'connected=false');
} else bad('云端状态', JSON.stringify(cs).slice(0, 250));

console.log('\n9) POST /cloud/sync（已连接→synced；未连接→400）');
const sy = await call(B + '/cloud/sync', { method: 'POST', body: {} });
if (sy.status === 200 && typeof sy.body.synced === 'number') ok('同步可用', `synced=${sy.body.synced}`);
else if (sy.status === 400) ok('未连接时同步被拒', sy.body.error);
else bad('同步', JSON.stringify(sy).slice(0, 250));

console.log('\n10) POST /cloud/connect 缺 token 应 400（不会触发云端运行）');
const cc = await call(B + '/cloud/connect', { method: 'POST', body: {} });
if (cc.status === 400) ok('缺 token 被拒', cc.body.error);
else bad('缺 token', JSON.stringify(cc).slice(0, 250));

console.log('\n11) GET /stats 用量统计');
const st2 = await call(B + '/stats', { url: B + '/stats?days=30' });
if (st2.status === 200 && st2.body.ok && st2.body.summary?.all) {
  const all = st2.body.summary.all;
  ok('用量统计', `条数=${all.runs}（本机 ${st2.body.localCount} / 云端 ${st2.body.cloudCount}）tokens=${all.tokensIn}+${all.tokensOut} 花费=¥${all.cny}`);
} else bad('用量统计', JSON.stringify(st2).slice(0, 300));

console.log('\n12) GET /archive Obsidian 归档配置');
const ar = await call(B + '/archive');
if (ar.status === 200 && ar.body.ok && typeof ar.body.archive === 'object') {
  ok('归档配置读取', `enabled=${ar.body.archive.enabled} vault=${ar.body.archive.vaultPath || '(未设置)'} sub=${ar.body.archive.subfolder}`);
} else bad('归档配置', JSON.stringify(ar).slice(0, 250));

console.log('\n13) GET /setup 本机配置状态（只读，不注册任务）');
const su = await call(B + '/setup');
if (su.status === 200 && su.body.ok && su.body.local) {
  const l = su.body.local;
  ok('本机状态', `node=${l.nodeKind} dshCli=${l.dshCli ? '有' : '无'} profile=${l.profileReady} 运行文件=${l.runtimeInstalled ? 'v' + l.runtimeVersion : '未安装'} 计划任务=${l.task?.exists ? l.task.name : '未注册'}`);
} else bad('本机状态', JSON.stringify(su).slice(0, 300));

console.log('\n14) POST /setup action=run（任务未注册时应明确拒绝）');
if (!su.body?.local?.task?.exists) {
  const runRes = await call(B + '/setup', { method: 'POST', body: { action: 'run' } });
  if (runRes.status === 200 && typeof runRes.body.ok === 'boolean') ok('任务未注册时触发被明确拒绝', String(runRes.body.detail).slice(0, 120));
  else bad('任务未注册时触发', JSON.stringify(runRes).slice(0, 200));
} else {
  ok('任务已注册，跳过该分支');
}

console.log('\n15) GET /keys 密钥状态（必须脱敏）');
const ks = await call(B + '/keys');
const ksText = JSON.stringify(ks.body);
const pushToken = cfg.body.config.push.token ?? '';
const leaked = pushToken.length > 8 && ksText.includes(pushToken);
if (ks.status === 200 && ks.body.ok && ks.body.keys && !leaked) {
  ok('密钥状态读取', `deepseek=${ks.body.keys.deepseekKey.set} search=${ks.body.keys.searchApiKey.set} push=${ks.body.keys.pushToken.set} dsh凭据=${ks.body.keys.dshDeepseek?.available} cloud.search=${ks.body.cloud.searchProvider}`);
} else bad('密钥状态或脱敏', ksText.slice(0, 300));

console.log('\n16) POST /keys 保存云端设置（再读回应一致）');
const ksSave = await call(B + '/keys', { method: 'POST', body: { cloud: { ...ks.body.cloud, reportTitle: '自检标题' } } });
const ksBack = await call(B + '/keys');
if (ksSave.status === 200 && ksBack.body.cloud.reportTitle === '自检标题') {
  ok('云端设置保存', `searchProvider=${ksBack.body.cloud.searchProvider}, model=${ksBack.body.cloud.model}`);
} else bad('云端设置保存', JSON.stringify(ksSave.body).slice(0, 250));
await call(B + '/keys', { method: 'POST', body: { cloud: { ...ks.body.cloud } } });

console.log('\n17) POST /cloud/provision 缺密钥应 400（不触网建仓）');
const pv = await call(B + '/cloud/provision', { method: 'POST', body: { cloud: { ...ks.body.cloud, repoName: 'dsh-cloud-report', useDshCredential: false } } });
if (pv.status === 400) ok('缺 token/密钥被拒', pv.body.error);
else if (pv.status === 200) ok('已存在凭据 → 直接执行了部署', `keys=${pv.body.keyStoreUsed}, 上传=${pv.body.uploaded?.length} 个文件`);
else bad('provision 校验', JSON.stringify(pv).slice(0, 250));

console.log('\n== 宿主侧自检完成 ==');
