# dsh-cloud-report

定时生成技术简报并推送到手机微信：**GitHub 趋势 + 行业资讯 → DeepSeek 总结 → Server酱推送**。
零依赖（只用 Node 内置 fetch），同一份代码同时支持 GitHub Actions 与腾讯云函数 SCF。

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ | 模型密钥（`sk-…`） |
| `SERVERCHAN_KEY` | ✅ | Server酱 SendKey（`SCT…`） |
| `SEARCH_PROVIDER` | 可选 | `tavily` / `serper` / `brave`，不填则跳过行业资讯 |
| `SEARCH_API_KEY` | 可选 | 对应搜索服务的密钥 |
| `NEWS_QUERIES` | 可选 | 分号分隔的检索词，默认 AI + 化学/材料两组 |
| `DEEPSEEK_MODEL` | 可选 | 默认 `deepseek-v4-flash` |
| `REPORT_TITLE` | 可选 | 推送标题前缀，默认「DSH 云端简报」 |
| `GH_TOKEN` | 可选 | 提高 GitHub API 限额（Actions 里用内置 `GITHUB_TOKEN`） |
| `SOURCES_JSON` | 调试 | 直接喂数据、跳过抓取，用于离线复盘 |

本地单次运行（不推送可临时把 `SERVERCHAN_KEY` 留空，会走到失败分支）：

```bash
node report.mjs
```

---

## 部署 A：GitHub Actions（推荐）

1. 新建**私有**仓库 `dsh-cloud-report`（私有才不会把简报内容与日志公开）。
2. 把本目录全部文件推上去（`report.mjs`、`scf-index.cjs`、`package.json`、`.github/workflows/daily-report.yml`）。
3. 仓库 **Settings → Secrets and variables → Actions**：
   - Secrets 加 `DEEPSEEK_API_KEY`、`SERVERCHAN_KEY`、`SEARCH_API_KEY`
   - Variables（可选）加 `SEARCH_PROVIDER=tavily`、`NEWS_QUERIES`、`REPORT_TITLE`
4. 到 **Actions → daily-report → Run workflow** 手动触发一次，确认微信收到。
5. 定时已生效：`cron: '0 0 * * *'` = UTC 00:00 = **北京时间 08:00**。

> 私有仓库免费额度 2000 分钟/月；本任务单次约 1 分钟，每天 1 次 ≈ 30 分钟/月。

---

## 部署 B：腾讯云函数 SCF

1. 控制台新建函数：**Node.js 18** 运行时，类型「事件函数」。
2. 上传代码：把 `scf-report.zip`（含 `report.mjs` + `scf-index.cjs` + `package.json`）直接上传。
3. **执行方法**填：`scf-index.main_handler`。
4. 环境变量加：`DEEPSEEK_API_KEY`、`SERVERCHAN_KEY`、`SEARCH_PROVIDER`、`SEARCH_API_KEY`。
5. 超时时间设 **120 秒**（联网抓取 + 模型调用约 10–30 秒，留余量）。
6. 触发器 → 新建**定时触发器**：Cron 表达式 `0 0 8 * * * *`（7 段：秒 分 时 日 月 周 年，北京时间 08:00）。
7. 点「测试」跑一次，确认微信收到。

> 注意：SCF 定时触发器使用**北京时间**；GitHub Actions 的 cron 使用 **UTC**。这就是两边写法不同的原因。

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 微信收到「简报生成失败：GitHub API HTTP 403」 | GitHub 未认证限额用尽，给 `GH_TOKEN` 赋值即可 |
| 只有 GitHub 项目、没有行业资讯 | 没配 `SEARCH_PROVIDER` / `SEARCH_API_KEY`，属预期 |
| 收到两条简报 | **本地计划任务和云端同时在跑**，关掉其中一个 |
| 推送成功但内容很浅 | 云端是精简版（固定数据源）；要深度检索得用本机 DSH agent 版 |
