/**
 * dsh-report-scheduler — 定时报告 Host half.
 *
 * 提供 /api/dsh-report-scheduler/* 路由，供 Web 设置页「定时报告」面板调用：
 *   读写 config.json、查询调度状态（复用 dispatcher --plan）、
 *   立即运行 / 试跑(--dry) / 重发最近存档 / 手动 tick。
 *
 * 真正的定时触发由 Windows 任务计划程序调用 tick.cmd → dispatcher.mjs 完成，
 * 本插件只负责「看」和「改」，不持有计时器。
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, rm, mkdir, readdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createGitHub, readRepoFile, writeRepoFile } from "./github.mjs";
import { provisionCloud, inspectCloud } from "./provision.mjs";
import { RUNNER_DIR, detectPaths } from "./paths.mjs";
import { ensureRuntime, setupLocal, teardownLocal, localStatus, schtaskCommand, DEFAULT_TASK_NAME, LEGACY_TASK_NAMES, DEFAULT_INTERVAL_MINUTES } from "./setup-local.mjs";

const name = "report-scheduler";
const inject = ["webServer"];

const SCHED_DIR = join(homedir(), ".dsh", "dsh-report-scheduler");
const CONFIG_PATH = join(SCHED_DIR, "config.json");
const SECRETS_PATH = join(SCHED_DIR, "secrets.json");
const STATE_PATH = join(SCHED_DIR, "state.json");
const LOG_PATH = join(SCHED_DIR, "dispatcher.log");
const LEDGER_PATH = join(SCHED_DIR, "ledger.jsonl");
const SYNCED_PATH = join(SCHED_DIR, "cloud-reports-synced.json");
const RUNNER = join(SCHED_DIR, "run-report.mjs");
const DISPATCHER = join(SCHED_DIR, "dispatcher.mjs");
/** 云端连接配置（含 token，本机私有） */
const GH_CONFIG_PATH = join(SCHED_DIR, "github.json");
const CLOUD_TASKS_PATH = "tasks.json";
const CLOUD_LEDGER_PATH = "ledger.jsonl";
const CLOUD_REPORTS_DIR = "reports";
const CLOUD_WORKFLOW_PATH = ".github/workflows/daily-report.yml";

const API = {
  config: "/api/dsh-report-scheduler/config",
  status: "/api/dsh-report-scheduler/status",
  run: "/api/dsh-report-scheduler/run",
  resend: "/api/dsh-report-scheduler/resend",
  dispatch: "/api/dsh-report-scheduler/dispatch",
  cloudStatus: "/api/dsh-report-scheduler/cloud/status",
  cloudConnect: "/api/dsh-report-scheduler/cloud/connect",
  cloudSync: "/api/dsh-report-scheduler/cloud/sync",
  cloudRun: "/api/dsh-report-scheduler/cloud/run",
  cloudDisconnect: "/api/dsh-report-scheduler/cloud/disconnect",
  stats: "/api/dsh-report-scheduler/stats",
  archiveConfig: "/api/dsh-report-scheduler/archive",
  syncReports: "/api/dsh-report-scheduler/sync-reports",
  setup: "/api/dsh-report-scheduler/setup",
  keys: "/api/dsh-report-scheduler/keys",
  cloudProvision: "/api/dsh-report-scheduler/cloud/provision",
};

const MAX_JSON_BODY_BYTES = 256 * 1024;
const MAX_TASKS = 50;
const MAX_PROMPT_CHARS = 8000;
const PROVIDERS = ["none", "serverchan", "pushplus", "wxpusher"];
const SCHEDULE_TYPES = ["daily", "weekly", "interval"];
const TASK_WHERE = ["local", "cloud"];
/** HH:MM，小时 0-23、分钟 0-59。 */
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const originUrl = new URL(origin);
    return originUrl.hostname === "127.0.0.1" || originUrl.hostname === "localhost" || originUrl.hostname === "[::1]";
  } catch {
    return false;
  }
}

/** 读取 URL 查询参数。 */
function queryValue(req, key) {
  try {
    return new URL(req.url ?? "", "http://127.0.0.1").searchParams.get(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function handle(ctx, fn) {  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

async function readText(path, fallback) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readText(path, ""));
  } catch {
    return fallback;
  }
}

/** 默认配置：首次打开面板时给出可用骨架。 */
function defaultConfig() {
  return {
    dshHome: process.env.DSH_HOME ?? "",
    dshCli: "",
    nodePath: "",
    profile: "headless",
    timeoutMinutes: 12,
    checkIntervalMinutes: 15,
    push: { provider: "none", token: "", title: "DSH 定时报告" },
    archive: { enabled: false, vaultPath: "", subfolder: "AI 简报", dshTarget: "" },
    cloud: defaultCloud(),
    tasks: [],
  };
}

/** 云端运行环境设置（密钥不在这里，见 secrets.json）。 */
function defaultCloud() {
  return {
    repoName: "dsh-cloud-report",
    branch: "main",
    model: "deepseek-v4-flash",
    searchProvider: "tavily",
    searchDepth: "advanced",
    keyStore: "auto",
    reportTitle: "DSH 云端简报",
    taskName: DEFAULT_TASK_NAME,
    useDshCredential: false,
  };
}

const SEARCH_PROVIDERS = ["", "tavily", "serper", "brave"];
const SEARCH_DEPTHS = ["basic", "advanced", "fast", "ultra-fast"];
const KEY_STORES = ["auto", "secrets", "file"];

function clampText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** 校验并规范化配置；非法字段回落到安全默认，不抛错。 */
function normalizeConfig(input) {
  const base = defaultConfig();
  const source = typeof input === "object" && input !== null ? input : {};
  const push = typeof source.push === "object" && source.push !== null ? source.push : {};
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];
  const seen = new Set();
  const normalizedTasks = [];
  for (const raw of tasks.slice(0, MAX_TASKS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const id = clampText(raw.id, 64).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const schedule = typeof raw.schedule === "object" && raw.schedule !== null ? raw.schedule : {};
    const type = SCHEDULE_TYPES.includes(schedule.type) ? schedule.type : "daily";
    const normalizedSchedule = { type };
    if (type === "daily") normalizedSchedule.time = TIME_RE.test(schedule.time) ? schedule.time : "08:00";
    if (type === "weekly") {
      normalizedSchedule.time = TIME_RE.test(schedule.time) ? schedule.time : "09:00";
      const weekday = Number(schedule.weekday);
      normalizedSchedule.weekday = weekday >= 1 && weekday <= 7 ? weekday : 1;
    }
    if (type === "interval") {
      const hours = Number(schedule.hours);
      normalizedSchedule.hours = hours > 0 && hours <= 24 ? hours : 6;
    }
    if (schedule.catchUp === false) normalizedSchedule.catchUp = false;
    normalizedTasks.push({
      id,
      name: clampText(raw.name, 120) || id,
      enabled: raw.enabled !== false,
      where: TASK_WHERE.includes(raw.where) ? raw.where : "local",
      schedule: normalizedSchedule,
      prompt: clampText(raw.prompt, MAX_PROMPT_CHARS),
      ...(Array.isArray(raw.sources) ? { sources: raw.sources.filter((s) => s === "github" || s === "news") } : {}),
      ...(Array.isArray(raw.queries) ? { queries: raw.queries.map((q) => clampText(q, 120)).filter(Boolean).slice(0, 5) } : {}),
    });
  }
  return {
    dshHome: clampText(source.dshHome, 512) || base.dshHome,
    dshCli: clampText(source.dshCli, 512),
    nodePath: clampText(source.nodePath, 512),
    profile: clampText(source.profile, 64) || "headless",
    timeoutMinutes: Number(source.timeoutMinutes) > 0 && Number(source.timeoutMinutes) <= 60 ? Number(source.timeoutMinutes) : 12,
    checkIntervalMinutes: Number(source.checkIntervalMinutes) > 0 ? Number(source.checkIntervalMinutes) : 15,
    push: {
      provider: PROVIDERS.includes(push.provider) ? push.provider : "none",
      token: clampText(push.token, 256),
      title: clampText(push.title, 120) || "DSH 定时报告",
    },
    archive: (() => {
      const raw = typeof source.archive === "object" && source.archive !== null ? source.archive : {};
      return {
        enabled: raw.enabled === true,
        vaultPath: clampText(raw.vaultPath, 512),
        subfolder: clampText(raw.subfolder, 120) || "AI 简报",
      };
    })(),
    cloud: (() => {
      const raw = typeof source.cloud === "object" && source.cloud !== null ? source.cloud : {};
      const d = defaultCloud();
      const provider = typeof raw.searchProvider === "string" ? raw.searchProvider.trim().toLowerCase() : undefined;
      const depth = typeof raw.searchDepth === "string" ? raw.searchDepth.trim().toLowerCase() : undefined;
      const keyStore = clampText(raw.keyStore, 12).toLowerCase();
      return {
        repoName: clampText(raw.repoName, 100).replace(/[^A-Za-z0-9._-]/g, "") || d.repoName,
        branch: clampText(raw.branch, 60) || d.branch,
        model: clampText(raw.model, 60) || d.model,
        searchProvider: provider === undefined ? d.searchProvider : (SEARCH_PROVIDERS.includes(provider) ? provider : d.searchProvider),
        searchDepth: depth === undefined ? d.searchDepth : (SEARCH_DEPTHS.includes(depth) ? depth : d.searchDepth),
        keyStore: KEY_STORES.includes(keyStore) ? keyStore : d.keyStore,
        reportTitle: clampText(raw.reportTitle, 120) || d.reportTitle,
        taskName: (() => {
          const stored = clampText(raw.taskName, 120);
          if (!stored || LEGACY_TASK_NAMES.includes(stored)) return d.taskName;
          return stored;
        })(),
        useDshCredential: raw.useDshCredential === true,
      };
    })(),
    tasks: normalizedTasks,
  };
}

/* ── 密钥（只落本机，永不回传明文） ─────────────────────────────────── */

/** 读取本机保存的云端密钥。 */
async function loadSecrets() {
  const raw = await loadJson(SECRETS_PATH, {});
  return {
    deepseekKey: typeof raw?.deepseekKey === "string" ? raw.deepseekKey : "",
    searchApiKey: typeof raw?.searchApiKey === "string" ? raw.searchApiKey : "",
  };
}

/** 保存云端密钥（POSIX 下顺手收紧权限）。 */
async function saveSecrets(next) {
  await mkdir(SCHED_DIR, { recursive: true });
  await writeFile(SECRETS_PATH, JSON.stringify(next, null, 2), "utf8");
  try {
    await chmod(SECRETS_PATH, 0o600);
  } catch { /* Windows 上不支持，忽略 */ }
  return next;
}

/** 脱敏：只回传是否有值 + 尾 4 位。 */
function maskSecret(value) {
  const text = String(value ?? "");
  if (text.length === 0) return undefined;
  if (text.length <= 8) return "****";
  return `****${text.slice(-4)}`;
}

/**
 * 读取 DSH 自己的凭据文件里的 DEEPSEEK_API_KEY。
 * 仅在用户明确勾选时使用（面板上的开关），不静默读取。
 */
async function readDshCredential(dshHome) {
  const candidates = [
    join(dshHome || homedir(), ".credentials.yaml"),
    join(dshHome || homedir(), "credentials.yaml"),
  ];
  for (const path of candidates) {
    const text = await readText(path, "");
    if (!text) continue;
    const match = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

/** 面板用的密钥/设置状态（不含明文）。 */
async function keysReport(config) {
  const secrets = await loadSecrets();
  const paths = await detectPaths();
  const dshKey = await readDshCredential(paths.dshHome);
  return {
    ok: true,
    keys: {
      deepseekKey: { set: secrets.deepseekKey.length > 0, masked: maskSecret(secrets.deepseekKey) },
      searchApiKey: { set: secrets.searchApiKey.length > 0, masked: maskSecret(secrets.searchApiKey) },
      pushToken: { set: (config.push?.token ?? "").length > 0, masked: maskSecret(config.push?.token), provider: config.push?.provider },
      dshDeepseek: { available: dshKey.length > 0, masked: maskSecret(dshKey) },
    },
    cloud: config.cloud ?? defaultCloud(),
    detected: { node: paths.node, nodeKind: paths.nodeKind, dshCli: paths.dshCli, dshHome: paths.dshHome, appDir: paths.appDir },
    paths: { secrets: SECRETS_PATH, config: CONFIG_PATH, dir: SCHED_DIR },
  };
}

/** 跑一个 node 子进程并回收输出。 */
function runNode(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error), parsed: undefined });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = undefined;
      }
      resolve({ code, stdout, stderr, parsed });
    });
  });
}

function logTail(maxLines) {
  return readText(LOG_PATH, "").then((text) => text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-maxLines));
}

/* ── 云端（GitHub Actions）相关 ───────────────────────────────────────── */

/** 读取本机保存的云端连接配置。 */
async function loadGhConfig() {
  return loadJson(GH_CONFIG_PATH, undefined);
}

/** 从任务列表里挑出云端任务，转成仓库 tasks.json 的结构。 */
function cloudTasksFrom(config) {
  return (config.tasks ?? [])
    .filter((t) => t.where === "cloud")
    .map((t) => ({
      id: t.id,
      name: t.name,
      enabled: t.enabled !== false,
      schedule: t.schedule,
      sources: Array.isArray(t.sources) && t.sources.length > 0 ? t.sources : ["github", "news"],
      ...(Array.isArray(t.queries) && t.queries.length > 0 ? { queries: t.queries } : {}),
      prompt: t.prompt,
    }));
}

function maskToken(token) {
  const value = String(token ?? "");
  if (value.length <= 12) return "****";
  return `${value.slice(0, 9)}…${value.slice(-4)}`;
}

/** 组装云端状态：连接信息 + 仓库任务 + 最近运行。 */
async function cloudStatusReport() {
  const gh = await loadGhConfig();
  if (!gh?.token) return { connected: false };
  const client = createGitHub(gh.token);
  const base = { connected: true, owner: gh.owner, repo: gh.repo, branch: gh.branch ?? "main", tokenMasked: maskToken(gh.token), lastSync: gh.lastSync ?? null };
  try {
    const repoInfo = await client.api(`/repos/${gh.owner}/${gh.repo}`);
    base.private = repoInfo.private === true;
    base.repoUrl = repoInfo.html_url;
    const remote = await readRepoFile(client, gh.owner, gh.repo, CLOUD_TASKS_PATH, base.branch);
    if (remote) {
      const parsed = JSON.parse(remote.content);
      base.remoteTasks = (parsed.tasks ?? []).map((t) => ({ id: t.id, name: t.name, enabled: t.enabled !== false, schedule: t.schedule }));
      base.remoteTimezone = parsed.timezone ?? "Asia/Shanghai";
      base.remoteUpdatedAt = gh.lastSync?.at ?? null;
    } else {
      base.remoteTasks = [];
    }
    // 面板里有、仓库里没有的云任务 → 提示先同步
    const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
    const wantIds = cloudTasksFrom(config).map((t) => t.id);
    base.pendingSync = wantIds.filter((id) => !(base.remoteTasks ?? []).some((r) => r.id === id));
    base.panelCloudTasks = wantIds;
    const runs = await client.api(`/repos/${gh.owner}/${gh.repo}/actions/runs?per_page=5`);
    base.runs = (runs.workflow_runs ?? []).map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, createdAt: r.created_at, event: r.event, url: r.html_url }));
    base.ok = true;
  } catch (error) {
    base.ok = false;
    base.error = String(error).slice(0, 300);
  }
  return base;
}

/* ── 用量账本与报告归档 ─────────────────────────────────────────────── */

/** 解析 JSONL（坏行跳过）。 */
function parseJsonl(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 汇总一组账本条目。 */
function aggregate(entries) {
  const acc = { runs: entries.length, ok: 0, failed: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0, cny: 0, ms: 0 };
  for (const e of entries) {
    if (e.ok === false) acc.failed += 1;
    else acc.ok += 1;
    acc.tokensIn += Number(e.cost?.tokensIn ?? 0);
    acc.tokensCached += Number(e.cost?.tokensCached ?? 0);
    acc.tokensOut += Number(e.cost?.tokensOut ?? 0);
    acc.cny += Number(e.cost?.cny ?? 0);
    acc.ms += Number(e.ms ?? 0);
  }
  acc.cny = Number(acc.cny.toFixed(4));
  return acc;
}

/** 读取本机 + 云端的账本，返回合并后的统计。 */
async function statsReport(days) {
  const local = parseJsonl(await readText(LEDGER_PATH, ''));
  let cloud = [];
  let cloudError;
  const gh = await loadGhConfig();
  if (gh?.token) {
    try {
      const client = createGitHub(gh.token);
      const remote = await readRepoFile(client, gh.owner, gh.repo, CLOUD_LEDGER_PATH, gh.branch ?? 'main');
      if (remote) cloud = parseJsonl(remote.content);
    } catch (error) {
      cloudError = String(error).slice(0, 200);
    }
  }
  const entries = [...local, ...cloud].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  const cutoff = Date.now() - days * 86400000;
  const windowed = entries.filter((e) => Date.parse(e.at ?? '') >= cutoff);
  const todayKey = new Date().toISOString().slice(0, 10);
  const byDay = {};
  const byTask = {};
  for (const e of entries) {
    const day = String(e.at ?? '').slice(0, 10);
    byDay[day] ??= { runs: 0, cny: 0, tokensIn: 0, tokensOut: 0 };
    byDay[day].runs += 1;
    byDay[day].cny = Number((byDay[day].cny + Number(e.cost?.cny ?? 0)).toFixed(4));
    byDay[day].tokensIn += Number(e.cost?.tokensIn ?? 0);
    byDay[day].tokensOut += Number(e.cost?.tokensOut ?? 0);
    const key = `${e.task ?? 'unknown'}|${e.where ?? 'local'}`;
    byTask[key] ??= { task: e.task, where: e.where, runs: 0, cny: 0 };
    byTask[key].runs += 1;
    byTask[key].cny = Number((byTask[key].cny + Number(e.cost?.cny ?? 0)).toFixed(4));
  }
  return {
    ok: true,
    localCount: local.length,
    cloudCount: cloud.length,
    cloudError,
    days,
    summary: {
      today: aggregate(entries.filter((e) => String(e.at ?? '').startsWith(todayKey))),
      window: aggregate(windowed),
      all: aggregate(entries),
    },
    byDay,
    byTask,
    entries: entries.slice(0, 300),
  };
}

/** 把云端 reports/ 里还没同步过的报告写进 Obsidian 库。 */
async function syncCloudReportsToVault(config) {
  const gh = await loadGhConfig();
  if (!gh?.token) return { ok: false, error: '尚未连接云端' };
  const archive = config.archive ?? {};
  if (!archive.vaultPath) return { ok: false, error: '还没配置 Obsidian 库路径' };
  const sub = (archive.subfolder ?? 'AI 简报').trim();
  const vaultDir = join(archive.vaultPath, sub);
  const synced = await loadJson(SYNCED_PATH, { files: [] });
  const syncedSet = new Set(synced.files ?? []);
  const client = createGitHub(gh.token);
  const listing = await client.api(`/repos/${gh.owner}/${gh.repo}/contents/${CLOUD_REPORTS_DIR}?ref=${gh.branch ?? 'main'}`);
  const files = Array.isArray(listing) ? listing.filter((f) => f.type === 'file' && f.name.endsWith('.md')) : [];
  await mkdir(vaultDir, { recursive: true });
  const written = [];
  for (const file of files) {
    if (syncedSet.has(file.name)) continue;
    const detail = await client.api(`/repos/${gh.owner}/${gh.repo}/contents/${CLOUD_REPORTS_DIR}/${file.name}?ref=${gh.branch ?? 'main'}`);
    const content = Buffer.from(detail.content ?? '', 'base64').toString('utf8');
    await writeFile(join(vaultDir, file.name), content, 'utf8');
    syncedSet.add(file.name);
    written.push(file.name);
  }
  await writeFile(SYNCED_PATH, JSON.stringify({ files: [...syncedSet] }, null, 2), 'utf8');
  return { ok: true, vaultDir, written, total: files.length };
}

function makeRoutes(ctx) {  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "forbidden: loopback-only" });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: "method not allowed: " + req.method });
      return false;
    }
    return true;
  };

  return [
    {
      kind: "exact",
      path: API.config,
      handler: handle(ctx, async (req, res) => {
        const method = req.method ?? "GET";
        if (method === "GET") {
          if (!guard(req, res, "GET")) return;
          const stored = await loadJson(CONFIG_PATH, undefined);
          writeJson(res, 200, { ok: true, config: stored === undefined ? defaultConfig() : normalizeConfig(stored), paths: { dir: SCHED_DIR, runner: RUNNER, dispatcher: DISPATCHER } });
          return;
        }
        if (method === "POST") {
          if (!guard(req, res, "POST")) return;
          const body = await readJsonBody(req);
          if (body === undefined || typeof body.config !== "object" || body.config === null) {
            writeJson(res, 400, { error: "invalid JSON body (config required)" });
            return;
          }
          const config = normalizeConfig(body.config);
          await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
          writeJson(res, 200, { ok: true, config });
          return;
        }
        writeJson(res, 405, { error: "method not allowed: " + method });
      }),
    },
    {
      kind: "exact",
      path: API.status,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const [planRun, state, log] = await Promise.all([
          runNode([DISPATCHER, "--plan"], 30000),
          loadJson(STATE_PATH, { tasks: {} }),
          logTail(40),
        ]);
        writeJson(res, 200, {
          ok: true,
          plan: planRun.parsed ?? null,
          planError: planRun.parsed ? null : (planRun.stderr || `exit ${planRun.code}`).slice(0, 500),
          state,
          log,
        });
      }),
    },
    {
      kind: "exact",
      path: API.run,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
        const args = [RUNNER];
        if (typeof body.prompt === "string" && body.prompt.trim().length > 0) {
          args.push("--prompt", clampText(body.prompt, MAX_PROMPT_CHARS));
        } else if (typeof body.id === "string" && body.id.trim().length > 0) {
          const task = config.tasks.find((t) => t.id === body.id.trim());
          if (!task) {
            writeJson(res, 404, { error: "task not found: " + body.id });
            return;
          }
          if (task.prompt.trim().length === 0) {
            writeJson(res, 400, { error: "该任务没有提示词，请先编辑保存" });
            return;
          }
          args.push("--task", task.id);
        } else {
          writeJson(res, 400, { error: "id or prompt required" });
          return;
        }
        if (body.dry === true) args.push("--dry");
        const run = await runNode(args, (config.timeoutMinutes + 3) * 60 * 1000);
        writeJson(res, 200, { ok: run.code === 0, exitCode: run.code, result: run.parsed ?? null, stderr: run.stderr.slice(-800) });
      }),
    },
    {
      kind: "exact",
      path: API.resend,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
        const run = await runNode([RUNNER, "--resend", "latest"], 120000);
        writeJson(res, 200, { ok: run.code === 0, exitCode: run.code, result: run.parsed ?? null, stderr: run.stderr.slice(-800), provider: config.push.provider });
      }),
    },
    {
      kind: "exact",
      path: API.dispatch,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        const dry = body?.dry === true;
        const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
        const args = [DISPATCHER];
        if (dry) args.push("--dry");
        const run = await runNode(args, (config.timeoutMinutes + 3) * 60 * 1000 + 30000);
        writeJson(res, 200, { ok: run.code === 0, exitCode: run.code, result: run.parsed ?? null, stderr: run.stderr.slice(-800) });
      }),
    },

    // ── 云端：状态 ──────────────────────────────────────────────
    {
      kind: "exact",
      path: API.cloudStatus,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "GET")) return;
        writeJson(res, 200, { ok: true, cloud: await cloudStatusReport() });
      }),
    },

    // ── 云端：连接（保存 token 并校验） ──────────────────────────
    {
      kind: "exact",
      path: API.cloudConnect,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        const token = typeof body?.token === "string" ? body.token.trim() : "";
        if (!token) {
          writeJson(res, 400, { error: "缺少 token" });
          return;
        }
        const repo = clampText(body.repo, 120).trim() || "dsh-cloud-report";
        const branch = clampText(body.branch, 60).trim() || "main";
        const client = createGitHub(token);
        let owner;
        try {
          const me = await client.api("/user");
          owner = me.login;
          await client.api(`/repos/${owner}/${repo}`);
        } catch (error) {
          writeJson(res, 400, { error: `token 或仓库校验失败：${String(error).slice(0, 200)}` });
          return;
        }
        const next = { token, owner, repo, branch, connectedAt: new Date().toISOString() };
        await writeFile(GH_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
        writeJson(res, 200, { ok: true, cloud: await cloudStatusReport() });
      }),
    },

    // ── 云端：断开 ──────────────────────────────────────────────
    {
      kind: "exact",
      path: API.cloudDisconnect,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        await rm(GH_CONFIG_PATH, { force: true });
        writeJson(res, 200, { ok: true, cloud: { connected: false } });
      }),
    },

    // ── 云端：把本地面板里的云端任务同步到仓库 ──────────────────
    {
      kind: "exact",
      path: API.cloudSync,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const gh = await loadGhConfig();
        if (!gh?.token) {
          writeJson(res, 400, { error: "尚未连接云端（先填 token 并连接）" });
          return;
        }
        const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
        const payload = { version: 1, timezone: "Asia/Shanghai", tasks: cloudTasksFrom(config) };
        const client = createGitHub(gh.token);
        try {
          await writeRepoFile(client, gh.owner, gh.repo, CLOUD_TASKS_PATH, gh.branch ?? "main", `${JSON.stringify(payload, null, 2)}\n`, `chore: 同步云端任务（${payload.tasks.length} 个）`);
        } catch (error) {
          writeJson(res, 400, { error: `同步失败：${String(error).slice(0, 250)}` });
          return;
        }
        const next = { ...gh, lastSync: { at: new Date().toISOString(), tasks: payload.tasks.length } };
        await writeFile(GH_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
        writeJson(res, 200, { ok: true, synced: payload.tasks.length, cloud: await cloudStatusReport() });
      }),
    },

    // ── 云端：触发一次运行（可选强制某个任务） ──────────────────
    {
      kind: "exact",
      path: API.cloudRun,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const gh = await loadGhConfig();
        if (!gh?.token) {
          writeJson(res, 400, { error: "尚未连接云端" });
          return;
        }
        const body = await readJsonBody(req);
        const forceId = typeof body?.id === "string" ? body.id.trim() : "";
        const branch = gh.branch ?? "main";
        const client = createGitHub(gh.token);
        try {
          // 指定任务时，先确认仓库里真的有它，否则强制运行会静默跑 0 个任务
          if (forceId) {
            const remote = await readRepoFile(client, gh.owner, gh.repo, CLOUD_TASKS_PATH, branch);
            const remoteIds = remote ? (JSON.parse(remote.content).tasks ?? []).map((t) => t.id) : [];
            if (!remoteIds.includes(forceId)) {
              writeJson(res, 400, { error: `任务 ${forceId} 还没同步到仓库，请先点「同步任务到仓库」再运行` });
              return;
            }
          }
          const workflows = await client.api(`/repos/${gh.owner}/${gh.repo}/actions/workflows`);
          const target = (workflows.workflows ?? []).find((w) => w.path.includes("daily-report")) ?? (workflows.workflows ?? [])[0];
          if (!target) throw new Error("仓库里没有可用的 workflow");
          await client.api(`/repos/${gh.owner}/${gh.repo}/actions/workflows/${target.id}/dispatches`, {
            method: "POST",
            body: { ref: branch, ...(forceId ? { inputs: { force: forceId } } : {}) },
          });
          writeJson(res, 200, { ok: true, workflow: target.name ?? target.path, forced: forceId || null });
        } catch (error) {
          writeJson(res, 400, { error: `触发失败：${String(error).slice(0, 250)}` });
        }
      }),
    },

    // ── 用量统计 ────────────────────────────────────────────────
    {
      kind: "exact",
      path: API.stats,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const days = Number(queryValue(req, "days") ?? 30);
        writeJson(res, 200, await statsReport(Number.isFinite(days) && days > 0 ? days : 30));
      }),
    },

    // ── 报告归档（Obsidian）配置 ────────────────────────────────
    {
      kind: "exact",
      path: API.archiveConfig,
      handler: handle(ctx, async (req, res) => {
        const method = req.method ?? "GET";
        if (method === "GET") {
          if (!guard(req, res, "GET")) return;
          const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
          writeJson(res, 200, { ok: true, archive: config.archive ?? {} });
          return;
        }
        if (method === "POST") {
          if (!guard(req, res, "POST")) return;
          const body = await readJsonBody(req);
          if (body === undefined || typeof body.archive !== "object" || body.archive === null) {
            writeJson(res, 400, { error: "invalid JSON body (archive required)" });
            return;
          }
          const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
          const next = normalizeConfig({ ...config, archive: { ...config.archive, ...body.archive } });
          await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
          writeJson(res, 200, { ok: true, archive: next.archive });
          return;
        }
        writeJson(res, 405, { error: "method not allowed: " + method });
      }),
    },

    // ── 把云端报告同步进 Obsidian 库 ────────────────────────────
    {
      kind: "exact",
      path: API.syncReports,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
        try {
          writeJson(res, 200, await syncCloudReportsToVault(config));
        } catch (error) {
          writeJson(res, 400, { error: `同步失败：${String(error).slice(0, 250)}` });
        }
      }),
    },

    // ── 本机一键配置：运行文件 + 无头 profile + 计划任务 ─────────
    {
      kind: "exact",
      path: API.setup,
      handler: handle(ctx, async (req, res) => {
        const method = req.method ?? "GET";
        const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
        if (method === "GET") {
          if (!guard(req, res, "GET")) return;
          writeJson(res, 200, { ok: true, local: await localStatus({ schedDir: SCHED_DIR, profile: config.profile, taskName: config.cloud?.taskName }) });
          return;
        }
        if (method !== "POST") {
          writeJson(res, 405, { error: "method not allowed: " + method });
          return;
        }
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        const action = typeof body?.action === "string" ? body.action : "install";

        if (action === "remove") {
          const result = await teardownLocal({ schedDir: SCHED_DIR, taskName: config.cloud?.taskName ?? DEFAULT_TASK_NAME, keepFiles: body?.keepFiles !== false });
          writeJson(res, 200, { ...result, local: await localStatus({ schedDir: SCHED_DIR, profile: config.profile, taskName: config.cloud?.taskName }) });
          return;
        }

        if (action === "run") {
          const run = await schtaskCommand("run", { taskName: config.cloud?.taskName ?? DEFAULT_TASK_NAME });
          writeJson(res, 200, { ok: run.ok, detail: run.detail ?? run.error });
          return;
        }

        const interval = Number(body?.intervalMinutes) > 0 ? Math.min(Number(body.intervalMinutes), 120) : (config.checkIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
        const result = await setupLocal({
          schedDir: SCHED_DIR,
          profile: config.profile,
          taskName: config.cloud?.taskName ?? DEFAULT_TASK_NAME,
          intervalMinutes: interval,
          registerTask: body?.registerTask !== false,
        });
        // 把探测到的路径写回配置，之后本地运行不再需要用户填任何路径
        if (result.paths) {
          const next = normalizeConfig({
            ...config,
            dshHome: result.paths.dshHome || config.dshHome,
            dshCli: result.paths.dshCli || config.dshCli,
            nodePath: result.paths.node || config.nodePath,
            checkIntervalMinutes: interval,
          });
          await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
        }
        writeJson(res, 200, { ...result, local: await localStatus({ schedDir: SCHED_DIR, profile: config.profile, taskName: config.cloud?.taskName }) });
      }),
    },

    // ── 云端密钥与设置（返回时全部脱敏） ────────────────────────
    {
      kind: "exact",
      path: API.keys,
      handler: handle(ctx, async (req, res) => {
        const method = req.method ?? "GET";
        const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
        if (method === "GET") {
          if (!guard(req, res, "GET")) return;
          writeJson(res, 200, await keysReport(config));
          return;
        }
        if (method !== "POST") {
          writeJson(res, 405, { error: "method not allowed: " + method });
          return;
        }
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const secrets = await loadSecrets();
        const clear = Array.isArray(body.clear) ? body.clear : [];
        const next = {
          deepseekKey: clear.includes("deepseekKey") ? "" : (typeof body.deepseekKey === "string" && body.deepseekKey.trim().length > 0 ? body.deepseekKey.trim() : secrets.deepseekKey),
          searchApiKey: clear.includes("searchApiKey") ? "" : (typeof body.searchApiKey === "string" && body.searchApiKey.trim().length > 0 ? body.searchApiKey.trim() : secrets.searchApiKey),
        };
        await saveSecrets(next);
        // 云端设置（非密钥）写进 config.json
        let savedConfig = config;
        if (typeof body.cloud === "object" && body.cloud !== null) {
          savedConfig = normalizeConfig({ ...config, cloud: { ...config.cloud, ...body.cloud } });
          await writeFile(CONFIG_PATH, JSON.stringify(savedConfig, null, 2), "utf8");
        }
        writeJson(res, 200, await keysReport(savedConfig));
      }),
    },

    // ── 一键部署云端（建仓 + 上传运行文件 + 写密钥/变量 + 同步任务） ──
    {
      kind: "exact",
      path: API.cloudProvision,
      handler: handle(ctx, async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const config = normalizeConfig(await loadJson(CONFIG_PATH, defaultConfig()));
        const secrets = await loadSecrets();
        const gh = await loadGhConfig();

        const token = (typeof body.token === "string" && body.token.trim()) || gh?.token || "";
        if (!token) {
          writeJson(res, 400, { error: "缺少 GitHub token：请先在「渠道与云端」里填入并保存" });
          return;
        }
        const cloud = normalizeConfig({ ...config, cloud: { ...config.cloud, ...(typeof body.cloud === "object" && body.cloud !== null ? body.cloud : {}) } }).cloud;

        // 密钥：优先用面板刚提交的，其次本机已保存的，最后（用户明确勾选时）用 DSH 凭据里的
        const paths = await detectPaths();
        const useDshKey = body.useDshCredential === true || cloud.useDshCredential === true;
        const deepseekKey = (typeof body.deepseekKey === "string" && body.deepseekKey.trim())
          || secrets.deepseekKey
          || (useDshKey ? await readDshCredential(paths.dshHome) : "");
        const searchApiKey = (typeof body.searchApiKey === "string" && body.searchApiKey.trim()) || secrets.searchApiKey;
        const pushToken = (typeof body.pushToken === "string" && body.pushToken.trim()) || config.push?.token || "";
        const pushProvider = config.push?.provider && config.push.provider !== "none" ? config.push.provider : "";

        if (!deepseekKey) {
          writeJson(res, 400, { error: "缺少 DeepSeek API Key：云端生成报告必须要它" });
          return;
        }

        // 顺手把密钥存到本机，下次不用重填
        if (deepseekKey !== secrets.deepseekKey || searchApiKey !== secrets.searchApiKey) {
          await saveSecrets({ deepseekKey, searchApiKey });
        }

        const result = await provisionCloud({
          token,
          repoName: cloud.repoName,
          branch: cloud.branch,
          keyStore: cloud.keyStore,
          runnerDir: RUNNER_DIR,
          secrets: {
            DEEPSEEK_API_KEY: deepseekKey,
            SEARCH_API_KEY: searchApiKey,
            PUSH_TOKEN: pushToken,
            ...(pushProvider === "serverchan" ? { SERVERCHAN_KEY: pushToken } : {}),
          },
          vars: {
            PUSH_PROVIDER: pushProvider,
            SEARCH_PROVIDER: cloud.searchProvider,
            SEARCH_DEPTH: cloud.searchDepth,
            REPORT_TITLE: cloud.reportTitle,
            DEEPSEEK_MODEL: cloud.model,
          },
          tasksPayload: { version: 1, timezone: "Asia/Shanghai", tasks: cloudTasksFrom(config) },
          dispatch: body.dispatch === true,
        });

        if (result.ok) {
          const next = { token, owner: result.owner, repo: result.repo, branch: result.branch, connectedAt: gh?.connectedAt ?? new Date().toISOString(), lastSync: { at: new Date().toISOString(), tasks: cloudTasksFrom(config).length }, provisionedAt: new Date().toISOString(), keyStoreUsed: result.keyStoreUsed };
          await writeFile(GH_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
          await writeFile(CONFIG_PATH, JSON.stringify(normalizeConfig({ ...config, cloud }), null, 2), "utf8");
        }
        writeJson(res, result.ok ? 200 : 400, { ...result, cloud: result.ok ? await cloudStatusReport() : undefined });
      }),
    },
  ];
}

/**
 * 插件加载时的自检（不阻塞启动）：
 *   1. 把插件自带的运行文件安装/更新到 ~/.dsh/dsh-report-scheduler
 *   2. 自动探测并补全 node / DSH CLI / DSH_HOME 路径，用户不用手填
 */
async function bootstrap() {
  try {
    await ensureRuntime(SCHED_DIR);
  } catch { /* 安装失败不影响面板打开 */ }
  try {
    const stored = await loadJson(CONFIG_PATH, undefined);
    const config = normalizeConfig(stored ?? defaultConfig());
    const paths = await detectPaths();
    const next = normalizeConfig({
      ...config,
      dshHome: config.dshHome || paths.dshHome || "",
      dshCli: config.dshCli || paths.dshCli || "",
      nodePath: config.nodePath || paths.node || "",
    });
    const changed = next.dshHome !== config.dshHome || next.dshCli !== config.dshCli || next.nodePath !== config.nodePath || stored === undefined;
    if (changed) {
      await mkdir(SCHED_DIR, { recursive: true });
      await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
    }
  } catch { /* 探测失败就在面板里让用户一键配置本机 */ }
}

/** Register the settings-page API routes. */
function apply(ctx) {
  const routes = makeRoutes(ctx);
  for (const route of routes) ctx.webServer.register(route);
  bootstrap();
}

export { API, apply, inject, name, normalizeConfig };
