/**
 * cloud-report.mjs — 云端定时报告（零依赖，Node 18+ / 腾讯云 SCF 通用）
 *
 * 流程：抓数据 → 调 DeepSeek 总结 → 推送到微信（Server酱）
 * 同一份代码两种跑法：
 *   - GitHub Actions / 本地 / 任何 Node：命令行入口（见文件末尾 import.meta 判断）
 *   - 腾讯云函数 SCF：导出 main_handler(event, context)
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY  必填  模型密钥
 *   SERVERCHAN_KEY    必填  Server酱 SendKey（SCT…）
 *   SEARCH_PROVIDER   可选  tavily | serper | brave（不填=跳过行业资讯）
 *   SEARCH_API_KEY    可选  搜索服务密钥
 *   NEWS_QUERIES      可选  分号分隔的检索词
 *   DEEPSEEK_MODEL    可选  默认 deepseek-v4-flash
 *   GH_TOKEN          可选  GitHub 令牌，仅用于提高 API 限额
 *   REPORT_TITLE      可选  推送标题前缀，默认「DSH 云端简报」
 */

import { pathToFileURL } from "node:url";

const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_QUERIES = ["AI 大模型 最新进展 发布", "化学 材料 实验室自动化 行业新闻"];
const TIMEOUT_MS = 60000;
/** deepseek-v4-flash 价格（USD / 百万 token）与汇率，用于把用量折算成人民币。 */
const PRICE = { input: 0.14, output: 0.28, cacheRead: 0.0028 };
const USD_TO_CNY = 7.37;

/** 由 DeepSeek 的 usage 折算 token 与人民币花费。 */
export function computeCost(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const cached = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0);
  const totalPrompt = Number(usage.prompt_tokens ?? 0);
  const missRaw = Number(usage.prompt_cache_miss_tokens);
  const tokensIn = Number.isFinite(missRaw) && usage.prompt_cache_miss_tokens !== undefined ? missRaw : Math.max(0, totalPrompt - cached);
  const tokensOut = Number(usage.completion_tokens ?? 0);
  const usd = (tokensIn * PRICE.input + tokensOut * PRICE.output + cached * PRICE.cacheRead) / 1e6;
  return { tokensIn, tokensCached: cached, tokensOut, usd, cny: usd * USD_TO_CNY };
}

/** 汇总多次调用的 usage。 */
export function sumUsage(...list) {
  const acc = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 };
  let any = false;
  for (const u of list) {
    if (!u) continue;
    any = true;
    acc.prompt_tokens += Number(u.prompt_tokens ?? 0);
    acc.completion_tokens += Number(u.completion_tokens ?? 0);
    acc.prompt_cache_hit_tokens += Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
    acc.prompt_cache_miss_tokens += Number(u.prompt_cache_miss_tokens ?? 0);
  }
  return any ? acc : undefined;
}

/** 带超时的 fetch。 */
async function http(url, init = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

/** 让每行独立成段：markdown 里单换行会被合并成一行，必须用空行分隔。
 *  但列表项之间、表格行之间要保持紧凑 —— 否则表格会被空行拆散、列表会散成段落。 */
export function normalizeLayout(text) {
  const kindOf = (line) => {
    if (/^\s*\|/.test(line)) return 'table';
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+[.)]\s/.test(line)) return 'list';
    if (/^\s*#{1,6}\s/.test(line)) return 'heading';
    if (/^\s*```/.test(line)) return 'fence';
    return 'prose';
  };
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+$/, ''));
  const out = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const prev = out[out.length - 1];
    if (prev !== undefined) {
      const a = kindOf(prev);
      const b = kindOf(line);
      const tight = a === b && (a === 'table' || a === 'list' || a === 'fence');
      if (!tight) out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 1. GitHub：最近 7 天新建、星数最高的仓库。 */
export async function gatherGitHub(env) {
  // 离线回放：SOURCES_JSON 直接提供数据（本地无 GitHub DNS 时用于测试/复盘）
  if (env.SOURCES_JSON) {
    const parsed = JSON.parse(env.SOURCES_JSON);
    return parsed.github ?? [];
  }
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = `${env.GITHUB_API_BASE || "https://api.github.com"}/search/repositories?q=created:>${since}+stars:>100&sort=stars&order=desc&per_page=6`;
  const headers = { accept: "application/vnd.github+json", "user-agent": "dsh-cloud-report" };
  if (env.GH_TOKEN) headers.authorization = `Bearer ${env.GH_TOKEN}`;
  const res = await http(url, { headers });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const body = await res.json();
  return (body.items ?? [])
    .filter((r) => (r.description ?? "").trim().length >= 8)
    .slice(0, 5)
    .map((r) => ({
      name: r.full_name,
      stars: r.stargazers_count,
      url: r.html_url,
      desc: (r.description ?? "").slice(0, 200),
      lang: r.language ?? "",
    }));
}

/** 2. 行业资讯：走搜索 API（多提供商、多词、可调深度）。 */
export async function gatherNews(env, opts = {}) {
  const provider = (env.SEARCH_PROVIDER ?? "").trim().toLowerCase();
  const key = (env.SEARCH_API_KEY ?? "").trim();
  if (!provider || !key) return { skipped: "未配置 SEARCH_PROVIDER / SEARCH_API_KEY" };
  const queries = Array.isArray(opts.queries)
    ? opts.queries.filter(Boolean)
    : (env.NEWS_QUERIES ?? "").split(";").map((q) => q.trim()).filter(Boolean);
  const list = queries.length > 0 ? queries : DEFAULT_QUERIES;
  const maxQueries = Number(opts.maxQueries) > 0 ? Number(opts.maxQueries) : 8;
  const maxResults = Number(opts.maxResults) > 0 ? Number(opts.maxResults) : 8;
  const depth = opts.depth ?? (env.SEARCH_DEPTH ?? "advanced").trim();
  const out = [];
  for (const query of list.slice(0, maxQueries)) {
    let done = false;
    for (let attempt = 1; attempt <= 2 && !done; attempt += 1) {
    try {
      if (provider === "tavily") {
        const res = await http("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: key, query, max_results: maxResults, topic: "news", days: 7, search_depth: depth }),
        }, 60000);
        if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
        const body = await res.json();
        for (const r of body.results ?? []) out.push({ query, title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 600) });
      } else if (provider === "serper") {
        const res = await http("https://google.serper.dev/search", {
          method: "POST",
          headers: { "content-type": "application/json", "X-API-KEY": key },
          body: JSON.stringify({ q: query, num: maxResults }),
        }, 60000);
        if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
        const body = await res.json();
        for (const r of body.organic ?? []) out.push({ query, title: r.title, url: r.link, snippet: (r.snippet ?? "").slice(0, 600) });
      } else if (provider === "brave") {
        const res = await http(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
          headers: { accept: "application/json", "X-Subscription-Token": key },
        }, 60000);
        if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
        const body = await res.json();
        for (const r of body.web?.results ?? []) out.push({ query, title: r.title, url: r.url, snippet: (r.description ?? "").slice(0, 600) });
      } else {
        throw new Error(`未知 SEARCH_PROVIDER: ${provider}`);
      }
      done = true;
    } catch (error) {
      if (attempt >= 2) log("检索失败（已跳过该词）", query, String(error));
      else await new Promise((r) => setTimeout(r, 1500));
    }
    }
  }
  return { items: out, queries: list.slice(0, maxQueries) };
}

/** 2.5 看第一轮结果找缺口，生成第二轮补充检索词（这就是"多轮联网搜索"）。 */
export async function planFollowUpQueries(env, { name, prompt, headlines }, count = 4) {
  const key = (env.DEEPSEEK_API_KEY ?? "").trim();
  if (!key) return [];
  const model = (env.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL;
  const system = [
    "你在为一篇报告做检索规划。用户会给你任务要求和第一轮已抓到的标题列表。",
    `请判断还缺哪些信息，然后给出 ${count} 个**新的**检索词来补齐缺口。`,
    "要求：中文；不要重复已覆盖的主题；针对任务里明确要求但第一轮结果没覆盖的维度；每个检索词 6–20 字。",
    `只输出 ${count} 行检索词，每行一个，不要编号、不要解释。`,
  ].join("\n");
  const user = [
    `任务名：${name}`,
    `任务要求：${String(prompt).slice(0, 1200)}`,
    "",
    "第一轮已抓到的标题：",
    ...headlines.slice(0, 30).map((t) => `- ${t}`),
  ].join("\n");
  for (const maxTokens of [800, 2400]) {
    try {
      const res = await http(`${DEEPSEEK_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_tokens: maxTokens,
          thinking: { type: "disabled" },
          temperature: 0.3,
        }),
      }, 60000);
      if (!res.ok) continue;
      const body = await res.json();
      const text = body.choices?.[0]?.message?.content ?? "";
      const parsed = text
        .split(/\r?\n/)
        .map((line) => line.replace(/^[\s\-*•\d.、)]+/, "").trim())
        .filter((line) => line.length >= 3 && line.length <= 40)
        .slice(0, count);
      if (parsed.length > 0) return { queries: parsed, usage: body.usage ?? undefined };
    } catch { /* 换更大预算重试 */ }
  }
  return { queries: [], usage: undefined };
}

/** 合并两轮结果并按 URL 去重。 */
export function mergeNewsItems(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = (item.url ?? item.title ?? "").trim();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** 3. 总结：调 DeepSeek chat completions。taskPrompt 由任务定义提供（可空）。 */
export async function summarize(env, sources, taskPrompt = "") {
  const key = (env.DEEPSEEK_API_KEY ?? "").trim();
  if (!key) throw new Error("缺少 DEEPSEEK_API_KEY");
  const model = (env.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL;
  const hasTask = taskPrompt.trim().length > 0;
  const baseRules = [
    "你是一份简报的编辑，读者很忙、注意力有限。",
    "硬性约束：只依据给定数据，不要编造；数据里没有的内容就不写；来源必须给出完整 http(s) URL，直接写在括号里，不要用 markdown 链接语法。",
    "不要开场白、不要「总结如下」这类句子、不要在结尾寒暄。",
  ];
  // 有任务提示词时：结构完全交给任务；没有时：用默认模板
  const structure = hasTask
    ? [
        "输出结构以「任务要求」为准，它优先于任何默认模板：任务要求里需要表格就用表格、需要标题层级就用标题层级、要求的分模块必须齐全。",
        "",
        "=== 任务要求 ===",
        taskPrompt.trim(),
        "=== 任务要求结束 ===",
      ]
    : [
        "按下面的默认模板输出：",
        "第一段（GitHub 项目，最多 5 行，每行以 \"- \" 开头）：- 项目名（star 数）：一句话它做什么",
        "第二段（行业资讯，最多 5 行，每行以 \"- \" 开头）：- 一句话结论（来源：完整URL）",
        "最后一行：数据口径：<一句话说明数据来源与统计方式>",
        "不要加粗标题、不要表格。",
      ];
  const system = [...baseRules, "", ...structure].join("\n");
  const user = [
    "以下是刚抓取的数据（JSON）：",
    JSON.stringify(sources).slice(0, 60000),
    "",
    hasTask ? "请按上面的任务要求输出。" : "请输出今天的简报。",
  ].join("\n");
  // 输入很大时思考必然吃光预算，直接走无思考；输入小则先带思考（质量更好）
  const bigInput = user.length > 20000;
  const attempts = bigInput
    ? [{ maxTokens: 7000, thinking: "disabled" }]
    : [
        { maxTokens: 8000, thinking: "enabled" },
        { maxTokens: 6000, thinking: "disabled" },
      ];
  let lastUsage = null;
  for (const attempt of attempts) {
    const res = await http(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: attempt.maxTokens,
        thinking: { type: attempt.thinking },
        temperature: 0.3,
      }),
    }, 180000);
    const text = await res.text();
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    lastUsage = body.usage ?? null;
    const content = body.choices?.[0]?.message?.content ?? "";
    if (content.trim()) {
      return { content: content.trim(), usage: { ...lastUsage, thinking: attempt.thinking } };
    }
    log(`总结返回空内容（thinking=${attempt.thinking}, max_tokens=${attempt.maxTokens}），降级重试`);
  }
  throw new Error("模型返回空内容（已重试带思考与不带思考两种模式）");
}

/** 3.5 任务没给检索词时，让模型按任务描述生成检索词（否则会用通用默认词，跑偏主题）。 */
export async function generateQueries(env, { name, prompt }, count = 4) {
  const key = (env.DEEPSEEK_API_KEY ?? "").trim();
  if (!key) return [];
  const model = (env.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL;
  const system = [
    "你是检索词生成器。根据任务描述，生成用于新闻搜索的检索词。",
    `输出 ${count} 行，每行一个检索词，不要编号、不要引号、不要解释。`,
    "要求：中文；包含任务的关键实体与行业名；覆盖任务要求的核心维度；每个检索词 6–20 字。",
  ].join("\n");
  const user = `任务名：${name}\n任务要求：${String(prompt).slice(0, 1500)}`;

  // 推理模型的 reasoning token 也算在 max_tokens 内，预算太小会导致正文为空 → 关掉思考 + 留足余量重试
  for (const attempt of [{ maxTokens: 800, thinking: "disabled" }, { maxTokens: 3000, thinking: "disabled" }]) {
    try {
      const res = await http(`${DEEPSEEK_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: attempt.maxTokens,
          thinking: { type: attempt.thinking },
          temperature: 0.2,
        }),
      }, 60000);
      if (!res.ok) continue;
      const body = await res.json();
      const text = body.choices?.[0]?.message?.content ?? "";
      const parsed = text
        .split(/\r?\n/)
        .map((line) => line.replace(/^[\s\-*•\d.、)]+/, "").trim())
        .filter((line) => line.length >= 3 && line.length <= 40)
        .slice(0, count);
      if (parsed.length > 0) return { queries: parsed, usage: body.usage ?? undefined };
    } catch { /* 换更大的预算再试 */ }
  }
  return { queries: [], usage: undefined };
}

/** 4. 推送：Server酱 / PushPlus / WxPusher（PUSH_PROVIDER + PUSH_TOKEN，兼容旧的 SERVERCHAN_KEY），失败重试 3 次。 */
export async function pushWeChat(env, title, desp) {
  if ((env.SKIP_PUSH ?? "") === "1") return { ok: true, detail: "SKIP_PUSH=1，跳过推送（测试用）" };
  const provider = (env.PUSH_PROVIDER ?? (env.SERVERCHAN_KEY ? "serverchan" : "")).trim().toLowerCase();
  const token = (env.PUSH_TOKEN ?? env.SERVERCHAN_KEY ?? "").trim();
  if (!provider || !token) throw new Error("缺少推送渠道配置（PUSH_PROVIDER / PUSH_TOKEN）");
  const spec = {
    serverchan: { url: `https://sctapi.ftqq.com/${token}.send`, body: { title, desp }, okText: '"code":0' },
    pushplus: { url: "https://www.pushplus.plus/send", body: { token, title, content: desp, template: "markdown" }, okText: '"code":200' },
    wxpusher: { url: "https://wxpusher.zjiecode.com/api/send/message", body: { appToken: token, content: desp, summary: title, contentType: 1 }, okText: '"code":1000' },
  }[provider];
  if (!spec) throw new Error(`未知推送渠道 ${provider}`);
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await http(spec.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spec.body),
      });
      const text = await res.text();
      if (res.ok && text.includes(spec.okText)) return { ok: true, detail: `${provider} ${text.slice(0, 200)}` };
      lastError = `HTTP ${res.status} ${text.slice(0, 200)}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
  return { ok: false, detail: lastError };
}

/** 主流程：抓数据 → 总结 → 推送。 */
export async function runReport(env = process.env) {
  const started = Date.now();
  const steps = {};
  let report = "";

  // 单个数据源失败不应拖垮整份简报
  let gh = [];
  try {
    gh = await gatherGitHub(env);
    steps.github = { ok: true, count: gh.length };
  } catch (error) {
    steps.github = { ok: false, error: String(error).slice(0, 200) };
  }

  const news = await gatherNews(env);
  const newsItems = news.items ?? [];
  steps.news = news.skipped ? { ok: false, skipped: news.skipped } : { ok: true, count: newsItems.length };

  const nothingAtAll = !steps.github.ok && newsItems.length === 0;
  if (nothingAtAll) {
    steps.error = "所有数据源均无数据";
    report = `本次抓取失败：GitHub（${steps.github.error}）；行业资讯（${news.skipped ?? "0 条"}）。`;
  } else {
    try {
      const s = await summarize(env, {
        github: gh,
        news: newsItems,
        githubError: steps.github.ok ? null : steps.github.error,
        newsSkipped: news.skipped ?? null,
      });
      steps.summarize = { ok: true, model: env.DEEPSEEK_MODEL || DEFAULT_MODEL, usage: s.usage };
      report = s.content;
    } catch (error) {
      steps.error = String(error);
      report = `简报生成失败：${String(error)}`;
    }
  }

  const day = new Date().toISOString().slice(0, 10);
  const title = `${env.REPORT_TITLE || "DSH 云端简报"} ${day}`;
  report = normalizeLayout(report);
  const pushed = await pushWeChat(env, title, report);
  steps.push = pushed;

  const result = { ok: !steps.error && pushed.ok, ms: Date.now() - started, title, report, steps };
  log("结果", JSON.stringify({ ok: result.ok, ms: result.ms, push: pushed.ok }));
  return result;
}

/** 腾讯云函数 SCF 入口。 */
export async function main_handler(event, context) {
  const result = await runReport(process.env);
  log("报告正文：\n" + result.report);
  return { statusCode: result.ok ? 200 : 500, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
}

/** 命令行入口（GitHub Actions / 本地直接跑）。 */
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runReport(process.env)
    .then((result) => {
      console.log("\n===== 简报 =====");
      console.log(result.report);
      console.log("===== 步骤明细 =====");
      console.log(JSON.stringify(result.steps, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((error) => {
      console.error("运行时异常:", error);
      process.exitCode = 2;
    });
}
