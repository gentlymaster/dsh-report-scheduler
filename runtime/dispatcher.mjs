#!/usr/bin/env node
/**
 * dispatcher.mjs — 定时报告派发器
 *
 * 职责：读 config.json 里的任务 → 判断"是否到点且未跑" → 调 run-report.mjs → 记状态
 *
 * 用法：
 *   node dispatcher.mjs                正常派发（供 schtasks 每 15 分钟调用）
 *   node dispatcher.mjs --plan         只打印判定结果，不执行
 *   node dispatcher.mjs --force <id>   忽略时间，立即跑某任务
 *   node dispatcher.mjs --dry          判定照常但子进程加 --dry（不推送）
 *
 * 支持的调度类型（tasks[].schedule）：
 *   { "type": "daily",    "time": "08:00" }              每天 HH:MM
 *   { "type": "weekly",   "weekday": 1, "time": "09:00" } 每周几(1=周一…7=周日) HH:MM
 *   { "type": "interval", "hours": 6 }                   每 N 小时（从 00:00 对齐）
 *   可选：{ "catchUp": false } 关机后不补跑；默认补跑（只补一次，不会堆积）
 *
 * 状态：state.json（lastRun / 最近结果 / 运行中锁）；日志：dispatcher.log
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HOME_DIR = join(homedir(), '.dsh', 'dsh-report-scheduler');
const CONFIG_PATH = join(HOME_DIR, 'config.json');
const STATE_PATH = join(HOME_DIR, 'state.json');
const LOG_PATH = join(HOME_DIR, 'dispatcher.log');
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-report.mjs');

function parseArgs(argv) {
  const out = { plan: false, force: undefined, dry: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--plan') out.plan = true;
    else if (a === '--force') out.force = argv[++i];
    else if (a === '--dry') out.dry = true;
  }
  return out;
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function log(line) {
  await mkdir(HOME_DIR, { recursive: true });
  await appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function parseTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return { h, min };
}

/** 最近一次"应该跑"的时间点（<= now）。返回 undefined 表示调度无效。 */
function lastDueSlot(schedule, now) {
  if (!schedule) return undefined;
  if (schedule.type === 'daily') {
    const t = parseTime(schedule.time);
    if (!t) return undefined;
    const slot = new Date(now);
    slot.setHours(t.h, t.min, 0, 0);
    if (slot > now) slot.setDate(slot.getDate() - 1);
    return slot;
  }
  if (schedule.type === 'weekly') {
    const t = parseTime(schedule.time);
    const weekday = Number(schedule.weekday);
    if (!t || !(weekday >= 1 && weekday <= 7)) return undefined;
    const slot = new Date(now);
    slot.setHours(t.h, t.min, 0, 0);
    const target = weekday % 7; // 1..7 -> 1..6,0（周日在 Date 里是 0）
    while (slot.getDay() !== target || slot > now) slot.setDate(slot.getDate() - 1);
    return slot;
  }
  if (schedule.type === 'interval') {
    const hours = Number(schedule.hours);
    if (!(hours > 0)) return undefined;
    const slot = new Date(now);
    slot.setMinutes(0, 0, 0);
    const steps = Math.floor(slot.getHours() / hours);
    slot.setHours(steps * hours);
    if (slot > now) slot.setHours(slot.getHours() - hours);
    return slot;
  }
  return undefined;
}

function nextDue(schedule, now) {
  const slot = lastDueSlot(schedule, now);
  if (!slot) return undefined;
  if (schedule.type === 'daily') return new Date(slot.getTime() + 24 * 3600 * 1000);
  if (schedule.type === 'weekly') return new Date(slot.getTime() + 7 * 24 * 3600 * 1000);
  if (schedule.type === 'interval') return new Date(slot.getTime() + Number(schedule.hours) * 3600 * 1000);
  return undefined;
}

/** 是否该跑：到点的最近一次槽位晚于上次运行时间。 */
function isDue(task, state, now) {
  const slot = lastDueSlot(task.schedule, now);
  if (!slot) return { due: false, reason: '调度配置无效' };
  const last = state.tasks?.[task.id]?.lastRun;
  if (!last) return { due: true, slot, reason: '从未运行' };
  const lastAt = new Date(last);
  if (lastAt >= slot) return { due: false, slot, reason: `本周期已运行（${lastAt.toLocaleString()}）` };
  if (task.schedule.catchUp === false) return { due: false, slot, reason: '错过且已禁用补跑' };
  return { due: true, slot, reason: `补跑（上次 ${lastAt.toLocaleString()}）` };
}

function runTask(task, dry, timeoutMinutes) {
  return new Promise((resolve) => {
    const args = [RUNNER, '--task', task.id];
    if (dry) args.push('--dry');
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), (timeoutMinutes + 3) * 60 * 1000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, detail: String(error), stdout, stderr }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { /* 保留原文 */ }
      const ok = code === 0 && (dry ? true : (parsed?.pushed?.ok ?? true));
      resolve({ ok, code, detail: parsed?.pushed?.detail, stdout, stderr });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadJson(CONFIG_PATH, { tasks: [] });
  const state = await loadJson(STATE_PATH, { tasks: {} });
  state.tasks ??= {};
  const now = new Date();
  const timeoutMinutes = config.timeoutMinutes ?? 12;
  const tasks = config.tasks ?? [];
  const results = [];

  // --force <id>：忽略时间直接跑
  if (args.force) {
    const task = tasks.find((t) => t.id === args.force);
    if (!task) {
      console.error(`没有 id=${args.force} 的任务`);
      process.exit(2);
    }
    const run = await runTask(task, args.dry, timeoutMinutes);
    await log(`FORCE ${task.id} ok=${run.ok} ${run.detail ?? ''}`);
    console.log(JSON.stringify({ mode: 'force', task: task.id, ...run }, null, 2));
    process.exit(run.ok ? 0 : 1);
  }

  // --plan：只看判定，不执行
  if (args.plan) {
    for (const task of tasks) {
      const d = isDue(task, state, now);
      const isCloud = task.where === 'cloud';
      results.push({
        id: task.id,
        name: task.name,
        enabled: task.enabled !== false,
        where: task.where ?? 'local',
        schedule: task.schedule,
        due: !isCloud && task.enabled !== false && d.due,
        reason: isCloud ? '云端任务（由 GitHub 执行）' : task.enabled === false ? '已禁用' : d.reason,
        lastRun: state.tasks[task.id]?.lastRun ?? null,
        nextDue: isCloud ? '见云端（每小时整点检查）' : nextDue(task.schedule, now)?.toLocaleString() ?? '—',
      });
    }
    console.log(JSON.stringify({ mode: 'plan', now: now.toLocaleString(), tasks: results }, null, 2));
    process.exit(0);
  }

  // 正常派发
  for (const task of tasks) {
    if (task.enabled === false) continue;
    // 云端任务由 GitHub Actions 执行，本地跳过（避免两边重复推送）
    if (task.where === 'cloud') {
      results.push({ id: task.id, skipped: '云端任务（由 GitHub 执行）' });
      continue;
    }
    // 防重入：上一轮还在跑就跳过
    const running = state.tasks[task.id]?.runningSince;
    if (running && now.getTime() - new Date(running).getTime() < (timeoutMinutes + 3) * 60 * 1000) {
      results.push({ id: task.id, skipped: '正在运行中' });
      continue;
    }
    const d = isDue(task, state, now);
    if (!d.due) continue;

    state.tasks[task.id] = { ...state.tasks[task.id], runningSince: now.toISOString() };
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');

    const run = await runTask(task, args.dry, timeoutMinutes);
    if (args.dry) {
      // 试跑不占用档期：只记 dry 痕迹，不写 lastRun，保证正式运行仍会执行
      state.tasks[task.id] = {
        ...state.tasks[task.id],
        lastDryRun: new Date().toISOString(),
        lastDryOk: run.ok,
        detail: run.detail ?? null,
        runningSince: null,
      };
    } else {
      state.tasks[task.id] = {
        lastRun: new Date().toISOString(),
        slot: d.slot.toISOString(),
        ok: run.ok,
        detail: run.detail ?? null,
        runningSince: null,
      };
    }
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    await log(`RUN ${task.id} ok=${run.ok} slot=${d.slot.toISOString()} ${run.detail ?? ''}`);
    results.push({ id: task.id, ran: true, ok: run.ok, detail: run.detail ?? null, slot: d.slot.toLocaleString() });
  }

  if (results.length === 0) await log('TICK 无任务到点');
  console.log(JSON.stringify({ mode: 'dispatch', ran: results.length, results }, null, 2));
  process.exit(0);
}

main().catch(async (error) => {
  await log(`ERROR ${String(error)}`);
  console.error(String(error));
  process.exit(3);
});
