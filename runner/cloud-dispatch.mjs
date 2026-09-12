/**
 * cloud-dispatch.mjs — 云端任务调度器（与本地 dispatcher.mjs 同逻辑，但按云端时区跑）
 *
 * 用法：
 *   node cloud-dispatch.mjs              正常派发（GitHub Actions 每小时整点调用）
 *   node cloud-dispatch.mjs --plan       只打印判定，不执行
 *   node cloud-dispatch.mjs --force <id> 忽略时间立即跑某个任务
 *
 * 数据：
 *   tasks.json        任务定义（面板同步过来）：id/name/enabled/schedule/sources/prompt/queries
 *   cloud-state.json  每个任务上一次跑的档期（用于防重复；由 workflow 提交回仓库）
 *
 * 时区：tasks.json 里的 timezone 决定"几点算到点"，默认 Asia/Shanghai。
 * 注意：云端每小时整点检查一次，所以 time 建议用整点（08:00），:30 这类会被整点后跑到。
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherGitHub, gatherNews, summarize, pushWeChat, normalizeLayout, generateQueries, planFollowUpQueries, mergeNewsItems, computeCost, sumUsage } from './report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = process.env.DISPATCH_TASKS_FILE || join(HERE, 'tasks.json');
const STATE_FILE = process.env.DISPATCH_STATE_FILE || join(HERE, 'cloud-state.json');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 指定时区的"现在"：{ date: 'YYYY-MM-DD', hh, mm, weekday } */
function zonedNow(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday) };
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return undefined;
  return { hh, mm };
}

/**
 * 最近一个已到点的档期（字符串键，形如 2026-09-12T08:00）。
 * 用档期字符串做去重，避免时区换算带来的混乱。
 */
function currentSlot(schedule, now) {
  if (!schedule) return undefined;
  if (schedule.type === 'daily') {
    const t = parseTime(schedule.time);
    if (!t) return undefined;
    const passed = now.hh > t.hh || (now.hh === t.hh && now.mm >= t.mm);
    const date = passed ? now.date : shiftDate(now.date, -1);
    return `${date}T${String(t.hh).padStart(2, '0')}:${String(t.mm).padStart(2, '0')}`;
  }
  if (schedule.type === 'weekly') {
    const t = parseTime(schedule.time);
    const weekday = Number(schedule.weekday);
    if (!t || !(weekday >= 1 && weekday <= 7)) return undefined;
    const target = weekday % 7; // 1..7 → 1..6,0
    let date = now.date;
    let guard = 0;
    for (;;) {
      const d = new Date(`${date}T00:00:00Z`).getUTCDay();
      const sameDay = date === now.date;
      const passed = !sameDay || now.hh > t.hh || (now.hh === t.hh && now.mm >= t.mm);
      if (d === target && passed) break;
      date = shiftDate(date, -1);
      guard += 1;
      if (guard > 8) return undefined;
    }
    return `${date}T${String(t.hh).padStart(2, '0')}:${String(t.mm).padStart(2, '0')}`;
  }
  if (schedule.type === 'interval') {
    const hours = Number(schedule.hours);
    if (!(hours > 0)) return undefined;
    const slotHour = Math.floor(now.hh / hours) * hours;
    const passed = now.hh > slotHour || (now.hh === slotHour && now.mm >= 0);
    const date = passed ? now.date : shiftDate(now.date, -1);
    const hh = passed ? slotHour : Math.floor(23 / hours) * hours;
    return `${date}T${String(hh).padStart(2, '0')}:00`;
  }
  return undefined;
}

function parseArgs(argv) {
  const out = { plan: false, force: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plan') out.plan = true;
    else if (argv[i] === '--force') out.force = argv[++i];
  }
  return out;
}

async function runTask(task, env, timezone) {
  const started = Date.now();
  const steps = {};
  const sources = Array.isArray(task.sources) && task.sources.length > 0 ? task.sources : ['github', 'news'];

  let gh = [];
  if (sources.includes('github')) {
    try {
      gh = await gatherGitHub(env);
      steps.github = { ok: true, count: gh.length };
    } catch (error) {
      steps.github = { ok: false, error: String(error).slice(0, 200) };
    }
  }

  let newsItems = [];
  let usageQueries;
  let usageFollowUp;
  if (sources.includes('news')) {
    // 没填检索词 → 让模型按任务描述生成，避免用通用默认词跑偏主题
    let queries = Array.isArray(task.queries) ? task.queries.filter(Boolean) : [];
    if (queries.length === 0) {
      const generated = await generateQueries(env, { name: task.name ?? task.id, prompt: task.prompt ?? '' });
      queries = generated.queries ?? [];
      usageQueries = generated.usage;
      if (queries.length > 0) steps.queriesGenerated = queries;
    }
    const baseEnv = queries.length > 0 ? { ...env, NEWS_QUERIES: queries.join(';') } : env;

    // 第一轮：广撒网
    const round1 = await gatherNews(baseEnv, { maxQueries: 8, maxResults: 8 });
    if (round1.skipped) {
      steps.news = { ok: false, skipped: round1.skipped };
    } else {
      let items = round1.items ?? [];
      steps.newsRound1 = { ok: true, queries: (round1.queries ?? []).length, count: items.length };

      // 第二轮：让模型看第一轮的标题，指出缺口并补搜（多轮联网检索）
      const followUp = await planFollowUpQueries(env, {
        name: task.name ?? task.id,
        prompt: task.prompt ?? '',
        headlines: items.map((i) => i.title),
      });
      usageFollowUp = followUp.usage;
      const followUpQueries = followUp.queries ?? [];
      if (followUpQueries.length > 0) {
        steps.queriesFollowUp = followUpQueries;
        const round2 = await gatherNews({ ...env, NEWS_QUERIES: followUpQueries.join(';') }, { maxQueries: followUpQueries.length, maxResults: 8 });
        items = mergeNewsItems(items, round2.items ?? []);
        steps.newsRound2 = { ok: true, queries: followUpQueries.length, added: (round2.items ?? []).length };
      }
      newsItems = items;
      steps.news = { ok: true, count: newsItems.length };
    }
  }

  let report;
  if (!steps.github?.ok && gh.length === 0 && newsItems.length === 0) {
    report = `本次抓取失败：GitHub（${steps.github?.error ?? '未启用'}）；行业资讯（${steps.news?.skipped ?? `${newsItems.length} 条`}）。`;
    steps.error = '所有数据源均无数据';
  } else {
    try {
      const s = await summarize(env, { github: gh, news: newsItems, task: task.name }, task.prompt ?? '');
      steps.summarize = { ok: true, model: env.DEEPSEEK_MODEL || 'deepseek-v4-flash', usage: s.usage };
      report = s.content;
    } catch (error) {
      steps.error = String(error);
      report = `简报生成失败：${String(error)}`;
    }
  }

  const stamp = zonedNow(timezone).date;
  const title = `${task.name || task.id} ${stamp}`;
  const body = normalizeLayout(report);
  const pushed = await pushWeChat(env, title, body);
  steps.push = pushed;

  // 用量与花费（把三次模型调用的 usage 合并）
  const usage = sumUsage(usageQueries, usageFollowUp, steps.summarize?.usage);
  const cost = computeCost(usage);
  const entry = {
    at: new Date().toISOString(),
    task: task.id,
    name: task.name ?? task.id,
    where: 'cloud',
    model: env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    ms: Date.now() - started,
    ok: !steps.error && pushed.ok,
    newsCount: newsItems.length,
    githubCount: gh.length,
    usage,
    cost,
  };
  steps.cost = cost;

  // 报告存档（仓库 reports/<日期>-<任务>.md，带 Obsidian frontmatter）
  const reportPath = join('reports', `${stamp}-${task.id}.md`);
  const front = [
    '---',
    `date: ${stamp}`,
    `task: ${task.id}`,
    `task_name: ${task.name ?? task.id}`,
    'where: cloud',
    `model: ${entry.model}`,
    `tokens_in: ${cost?.tokensIn ?? 0}`,
    `tokens_cached: ${cost?.tokensCached ?? 0}`,
    `tokens_out: ${cost?.tokensOut ?? 0}`,
    `cost_cny: ${cost ? cost.cny.toFixed(4) : 0}`,
    `news_count: ${newsItems.length}`,
    `tags: [AI简报, ${task.id}]`,
    '---',
    '',
  ].join('\n');

  return { ok: entry.ok, ms: entry.ms, title, report: body, steps, entry, reportPath, reportFile: front + body + '\n' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await readJson(TASKS_FILE, { tasks: [] });
  const state = await readJson(STATE_FILE, { tasks: {} });
  state.tasks ??= {};
  const timezone = cfg.timezone || 'Asia/Shanghai';
  const now = zonedNow(timezone);
  const tasks = cfg.tasks ?? [];
  const results = [];

  if (args.plan) {
    for (const task of tasks) {
      const slot = currentSlot(task.schedule, now);
      const last = state.tasks[task.id]?.slot;
      results.push({
        id: task.id,
        name: task.name,
        enabled: task.enabled !== false,
        schedule: task.schedule,
        due: task.enabled !== false && slot !== undefined && last !== slot,
        slot,
        lastSlot: last ?? null,
      });
    }
    console.log(JSON.stringify({ mode: 'plan', timezone, now, tasks: results }, null, 2));
    return;
  }

  let ran = 0;
  for (const task of tasks) {
    const slot = currentSlot(task.schedule, now);
    if (slot === undefined) {
      log(`跳过 ${task.id}：调度配置无效`);
      continue;
    }
    const forced = args.force === task.id;
    if (!forced) {
      if (task.enabled === false) continue;
      if (state.tasks[task.id]?.slot === slot) continue; // 本档期已跑
    }
    if (!process.env.DEEPSEEK_API_KEY || (!process.env.PUSH_TOKEN && !process.env.SERVERCHAN_KEY)) {
      log('缺少 DEEPSEEK_API_KEY 或推送 token，无法执行（可在面板「渠道与云端」一键部署里补齐）');
      process.exitCode = 2;
      return;
    }
    log(`执行任务 ${task.id}（档期 ${slot}${forced ? '，强制' : ''}）`);
    const result = await runTask(task, process.env, timezone);
    state.tasks[task.id] = { slot, lastRun: new Date().toISOString(), ok: result.ok, title: result.title };
    ran += 1;

    // 报告存档 + 用量账本（会被 workflow 一起提交回仓库）
    try {
      await mkdir(join(HERE, 'reports'), { recursive: true });
      await writeFile(join(HERE, result.reportPath), result.reportFile, 'utf8');
      await appendFile(join(HERE, 'ledger.jsonl'), `${JSON.stringify(result.entry)}\n`, 'utf8');
    } catch (error) {
      log('存档/记账失败（不影响推送）', String(error));
    }

    console.log('\n===== ' + result.title + ' =====');
    console.log(result.report);
    console.log(JSON.stringify(result.steps, null, 2));
    if (result.entry?.cost) {
      log(`用量：输入 ${result.entry.cost.tokensIn}（缓存 ${result.entry.cost.tokensCached}）输出 ${result.entry.cost.tokensOut} → ¥${result.entry.cost.cny.toFixed(4)}`);
    }
  }

  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  log(`完成：执行 ${ran} 个任务`);
}

main().catch((error) => {
  console.error('派发异常:', error);
  process.exitCode = 1;
});
