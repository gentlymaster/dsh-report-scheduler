#!/usr/bin/env node
/**
 * run-report.mjs — DSH 定时报告：无头生成 → 存档 → 推送手机
 *
 * 用法：
 *   node run-report.mjs --task <id>            跑配置里的任务
 *   node run-report.mjs --prompt "提示词"       临时提示词
 *   node run-report.mjs --resend latest         重发最近一次存档（不重新生成）
 *   node run-report.mjs --resend <文件路径>     重发指定存档
 *   可加 --dry 跳过推送
 *
 * 配置：~/.dsh/dsh-report-scheduler/config.json
 * 存档：~/.dsh/dsh-report-scheduler/reports/YYYY-MM-DD-HHmm-<id>.md
 *
 * 推送健壮性：本机 DNS 间歇性失败，故推送走「系统 DNS → DoH 兜底直连」多轮尝试。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, appendFile, stat, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const HOME_DIR = join(homedir(), '.dsh', 'dsh-report-scheduler');
const CONFIG_PATH = join(HOME_DIR, 'config.json');
const REPORTS_DIR = join(HOME_DIR, 'reports');
const LEDGER_PATH = join(HOME_DIR, 'ledger.jsonl');
/** deepseek-v4-flash 价格（USD/百万 token）与汇率 */
const PRICE = { input: 0.14, output: 0.28, cacheRead: 0.0028 };
const USD_TO_CNY = 7.37;

/** 汇总一次运行里所有模型调用的 usage → token 与人民币花费 */
function summarizeUsage(usage) {
  if (!usage) return undefined;
  const totals = usage.totals ?? usage;
  const tokensIn = Number(totals.uncachedInputTokens ?? totals.prompt_tokens ?? 0);
  const tokensCached = Number(totals.cacheReadTokens ?? totals.prompt_cache_hit_tokens ?? 0);
  const tokensOut = Number(totals.outputTokens ?? totals.completion_tokens ?? 0);
  const usd = (tokensIn * PRICE.input + tokensOut * PRICE.output + tokensCached * PRICE.cacheRead) / 1e6;
  return { tokensIn, tokensCached, tokensOut, usd, cny: usd * USD_TO_CNY };
}

/** 从 DSH 会话记录里找出这次无头运行的真实用量（按时间窗口匹配最新会话） */
async function readSessionUsage(dshHome, startedAtMs) {
  try {
    const root = join(dshHome, 'sessions');
    const candidates = [];
    for (const dir of await readdir(root)) {
      const full = join(root, dir);
      const info = await stat(full).catch(() => undefined);
      if (!info?.isDirectory()) continue;
      for (const sub of await readdir(full).catch(() => [])) {
        const sessionPath = join(full, sub);
        const s = await stat(sessionPath).catch(() => undefined);
        if (s?.isDirectory() && s.mtimeMs >= startedAtMs) candidates.push({ id: sub, mtime: s.mtimeMs });
      }
    }
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => b.mtime - a.mtime);
    const id = candidates[0].id;
    const cachePath = join(dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`);
    const raw = await readFile(cachePath, 'utf8').catch(() => undefined);
    if (!raw) return { sessionId: id, usage: undefined };
    const json = JSON.parse(raw);
    return { sessionId: id, usage: json?.record?.rows?.tokenUsage?.val, cost: json?.record?.rows?.tokenCost?.val };
  } catch {
    return undefined;
  }
}

/** 记一条账（本地账本，统计页会读它） */
async function appendLedger(entry) {
  try {
    await mkdir(HOME_DIR, { recursive: true });
    await appendFile(LEDGER_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* 记账失败不影响主流程 */ }
}

/** 归档到 Obsidian 库（config.archive 配置了才做） */
async function archiveToObsidian(config, sourcePath, filename) {
  const vault = config.archive?.vaultPath;
  if (!vault || config.archive?.enabled === false) return undefined;
  const sub = (config.archive?.subfolder ?? 'AI 简报').trim();
  const dir = join(vault, sub);
  try {
    await mkdir(dir, { recursive: true });
    const target = join(dir, filename);
    await cp(sourcePath, target);
    return target;
  } catch (error) {
    return `失败: ${String(error)}`;
  }
}

const DOH_ENDPOINTS = [
  'https://dns.alidns.com/resolve?name=HOST&type=A',
  'https://doh.pub/dns-query?name=HOST&type=A',
  'https://cloudflare-dns.com/dns-query?name=HOST&type=A',
];

function parseArgs(argv) {
  const out = { task: undefined, prompt: undefined, resend: undefined, dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--resend') out.resend = argv[++i] ?? 'latest';
    else if (a === '--dry') out.dry = true;
  }
  return out;
}

async function loadConfig() {
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return { day: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`, clock: `${p(date.getHours())}${p(date.getMinutes())}` };
}

/** 无头跑一次提示词；stdout 就是模型最终答复。 */
function runHeadless({ dshCli, dshHome, profile, prompt, timeoutMinutes, nodePath }) {
  if (!dshCli) {
    return Promise.resolve({ ok: false, answer: '', stderr: '', ms: 0, error: '还没设置 DSH CLI 路径（面板「渠道与云端」里点一次「一键配置本机」即可自动填好）' });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(nodePath || process.execPath, [dshCli, '--profile', profile, prompt], {
      env: { ...process.env, DSH_HOME: dshHome },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, answer: stdout.trim(), stderr, ms: Date.now() - started, error: `超时 ${timeoutMinutes} 分钟` });
    }, timeoutMinutes * 60 * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, answer: '', stderr, ms: Date.now() - started, error: String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const answer = stdout.trim();
      resolve({ ok: code === 0 && answer.length > 0, answer, stderr, ms: Date.now() - started, error: code === 0 ? (answer ? undefined : '无输出') : `退出码 ${code}` });
    });
  });
}

/** 零依赖 HTTP（只用 node:http/https，不装任何包）：可选 ip 参数强制直连。 */
function httpsJson(url, { method = 'GET', headers = {}, body, ip, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = mod({
      method,
      host: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
      // 注意：Node 20+ 的 autoSelectFamily 会用 options.all=true 调用 lookup，
      // 那种情况必须回数组，否则报 "Invalid IP address: undefined"
      ...(ip ? { lookup: (_h, options, cb) => (options && options.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)) } : {}),
      ...(target.protocol === 'https:' ? { servername: target.hostname } : {}),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function dohResolve(host) {
  for (const tpl of DOH_ENDPOINTS) {
    try {
      const res = await httpsJson(tpl.replace('HOST', host), { headers: { accept: 'application/dns-json' }, timeoutMs: 8000 });
      if (!res.ok) continue;
      const body = JSON.parse(res.text);
      const ips = (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
      if (ips.length > 0) return ips;
    } catch { /* 换下一个 DoH 端点 */ }
  }
  return undefined;
}

/** 三渠道推送，带 DNS 兜底与重试。 */
async function push(config, content) {
  const { provider, token, title } = config.push ?? {};
  if (!provider || provider === 'none') return { ok: false, detail: '未配置推送渠道' };
  if (!token) return { ok: false, detail: `渠道 ${provider} 缺少 token` };

  const spec = {
    serverchan: { host: 'sctapi.ftqq.com', path: (t) => `/${t}.send`, body: ({ title: ti, content: c }) => ({ title: ti, desp: c }) },
    pushplus: { host: 'www.pushplus.plus', path: () => '/send', body: ({ title: ti, content: c, token: tk }) => ({ token: tk, title: ti, content: c, template: 'markdown' }) },
    wxpusher: { host: 'wxpusher.zjiecode.com', path: () => '/api/send/message', body: ({ title: ti, content: c, token: tk }) => ({ appToken: tk, content: c, summary: ti, contentType: 1 }) },
  }[provider];
  if (!spec) return { ok: false, detail: `未知渠道 ${provider}` };

  const url = `https://${spec.host}${spec.path(token)}`;
  const payload = JSON.stringify(spec.body({ title, content, token }));
  const tries = [{ label: '系统DNS', ip: undefined }];
  const ips = await dohResolve(spec.host);
  if (ips) for (const ip of ips.slice(0, 2)) tries.push({ label: `DoH:${ip}`, ip });

  for (let round = 1; round <= 2; round += 1) {
    for (const t of tries) {
      try {
        const res = await httpsJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, ip: t.ip });
        const text = res.text.slice(0, 300);
        if (res.ok) return { ok: true, detail: `${t.label} HTTP ${res.status} ${text}` };
        if (round === 2) return { ok: false, detail: `${t.label} HTTP ${res.status} ${text}` };
      } catch (error) {
        if (round === 2 && t === tries[tries.length - 1]) {
          return { ok: false, detail: `${t.label} ${error.cause?.code ?? error.message}` };
        }
      }
    }
  }
  return { ok: false, detail: '所有尝试失败' };
}

async function resolveResend(target) {
  if (target !== 'latest') return target;
  const files = (await readdir(REPORTS_DIR)).filter((f) => f.endsWith('.md')).sort();
  if (files.length === 0) throw new Error('reports 目录里没有存档');
  return join(REPORTS_DIR, files[files.length - 1]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();

  // 重发模式：不重新生成，只推送已有存档
  if (args.resend) {
    const path = await resolveResend(args.resend);
    const raw = await readFile(path, 'utf8');
    const report = raw.split('## 报告')[1]?.trim() ?? raw;
    const result = args.dry ? { ok: false, detail: '--dry 跳过推送' } : await push(config, report);
    console.log(JSON.stringify({ mode: 'resend', file: path, chars: report.length, pushed: result }, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  let id = 'adhoc';
  let prompt = args.prompt;
  if (!prompt) {
    if (!args.task) {
      console.error('用法：--task <id> | --prompt "..." | --resend latest [--dry]');
      process.exit(2);
    }
    const task = (config.tasks ?? []).find((t) => t.id === args.task);
    if (!task) {
      console.error(`config.json 里没有 id=${args.task} 的任务`);
      process.exit(2);
    }
    id = task.id;
    prompt = task.prompt;
  }

  const startedAtMs = Date.now();
  const run = await runHeadless({
    dshCli: config.dshCli,
    dshHome: config.dshHome,
    profile: config.profile ?? 'headless',
    prompt,
    timeoutMinutes: config.timeoutMinutes ?? 12,
    nodePath: config.nodePath,
  });

  // 用量与花费：从 DSH 会话记录里取这次运行的真实 token
  const sessionInfo = await readSessionUsage(config.dshHome, startedAtMs - 5000);
  const cost = summarizeUsage(sessionInfo?.usage);
  const usageEntry = {
    at: new Date().toISOString(),
    task: id,
    name: (config.tasks ?? []).find((t) => t.id === id)?.name ?? id,
    where: 'local',
    model: 'deepseek-v4-flash',
    ms: run.ms,
    ok: run.ok,
    sessionId: sessionInfo?.sessionId ?? null,
    usage: sessionInfo?.usage ?? null,
    cost,
  };

  const summary = { id, ok: run.ok, ms: run.ms, error: run.error, answerChars: run.answer.length, pushed: null, archive: null, cost, sessionId: sessionInfo?.sessionId ?? null };

  if (!run.ok) {
    const detail = [run.error, run.stderr.trim().split('\n').slice(-3).join(' | ')].filter(Boolean).join(' — ');
    summary.pushed = await push({ ...config, push: { ...config.push, title: `${config.push?.title ?? 'DSH 报告'}：生成失败` } }, `任务 ${id} 生成失败。\n\n原因：${detail}`);
    await appendLedger({ ...usageEntry, error: detail.slice(0, 300) });
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  const { day, clock } = stamp();
  await mkdir(REPORTS_DIR, { recursive: true });
  summary.archive = join(REPORTS_DIR, `${day}-${clock}-${id}.md`);
  await writeFile(summary.archive, `# ${config.push?.title ?? 'DSH 报告'} — ${id}\n\n生成时间：${day} ${clock}\n\n## 提示词\n\n${prompt}\n\n## 报告\n\n${run.answer}\n`, 'utf8');

  summary.pushed = args.dry ? { ok: false, detail: '--dry 跳过推送' } : await push(config, run.answer);
  summary.obsidian = args.dry ? undefined : await archiveToObsidian(config, summary.archive, `${day}-${id}.md`);
  await appendLedger(usageEntry);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(run.ok ? 0 : 1);
}

/** 只有被直接执行时才跑 main（被 import 做测试时不跑）。 */
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(String(error));
    process.exit(3);
  });
}

export { httpsJson, dohResolve, push, runHeadless, summarizeUsage };
