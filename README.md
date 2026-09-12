# dsh-report-scheduler（定时报告）

给 DeepSeek Harness 用的定时报告插件：**在 Web 面板里把配置一次配完，然后到点自动生成报告并推送到手机**。

- 面板位置：设置 → 定时报告（四个标签页：任务 / 用量统计 / 渠道与云端 / 派发日志）
- 两种执行位置：
  - **本机**：调用无头 DSH agent（能多轮联网检索、读本地文件），由 Windows 计划任务到点触发
  - **云端**：GitHub Actions 跑（**电脑关机也能收到**），仓库由插件自动创建
- 报告可归档到 Obsidian 库；每次运行的 token 与花费会记进账本，面板直接看

## 装完之后怎么配（全在面板里，不需要改文件）

打开 设置 → 定时报告 → **渠道与云端**：

| 步骤 | 做什么 |
| --- | --- |
| ① 推送渠道 | 选 Server酱 / PushPlus / WxPusher，填 token，保存 |
| ② 云端密钥 | 填 DeepSeek API Key（可勾选「用 DSH 里已配置的 Key」免手填）、搜索服务与 key、模型、检索深度 |
| ③ 部署到云端 | 填 GitHub token → 点 **一键部署云端**：自动建私有仓 → 上传运行文件 → 写 Actions Secrets/变量 → 同步任务表（Secrets 权限不够时自动回退写仓库 `env.json`） |
| ④ 本机定时 | 点 **一键配置本机**：安装运行文件 → 需要时创建 headless profile → 生成 `tick.cmd` → 注册 Windows 计划任务 |

然后去 **任务** 页新建任务：填 id / 名称 / 提示词 / 调度时间，选执行位置（本机或云端）即可。
云端任务改完记得点一次「同步任务到仓库」，或直接用「一键部署云端」（它包含同步）。

## GitHub token 需要的权限

只走本机模式时**不需要** GitHub token。要云端模式，用 fine-grained PAT，勾：

- `Contents: Read and write`（写运行文件、任务表、同步报告）
- `Actions: Read and write`（触发 workflow、读运行记录）
- `Administration: Read and write`（自动创建私有仓；仓库已存在可不勾）
- `Secrets: Read and write`（写密钥；不勾会自动回退把密钥写进仓库 `env.json`，仅私有仓建议）

Token 只保存在本机 `~/.dsh/dsh-report-scheduler/github.json`，密钥保存在 `secrets.json`（POSIX 下 600 权限）。

## 数据与文件位置

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/dsh-report-scheduler/config.json` | 任务、渠道、归档、云端设置 |
| `~/.dsh/dsh-report-scheduler/secrets.json` | DeepSeek / 搜索 key（仅本机） |
| `~/.dsh/dsh-report-scheduler/github.json` | GitHub token 与仓库信息（仅本机） |
| `~/.dsh/dsh-report-scheduler/reports/` | 本机生成的报告存档 |
| `~/.dsh/dsh-report-scheduler/ledger.jsonl` | 本机用量与花费账本 |
| `~/.dsh/dsh-report-scheduler/tick.cmd` | 计划任务入口（插件生成） |
| `~/.dsh/dsh-report-scheduler/run-report.mjs`、`dispatcher.mjs` | 运行文件（插件安装/自动更新，无需手工维护） |

云端仓库里对应有 `tasks.json`、`cloud-state.json`（防重复推送的档期记录）、`ledger.jsonl`、`reports/`。

## 面板接口（宿主侧）

`/api/dsh-report-scheduler/` 下：`config`、`status`、`run`、`resend`、`dispatch`、`stats`、`archive`、`sync-reports`、`setup`、`keys`、`cloud/status|connect|disconnect|sync|run|provision`。
全部只允许 127.0.0.1 回环访问（非回环返回 403），密钥类字段一律脱敏返回。

## 自检

```bash
node selftest.mjs         # 17 项宿主侧接口自检（假 ctx 调真实路由，不需要重启 DSH）
node selftest-client.mjs  # 3 个场景渲染面板（极简 React 替身，不需要浏览器）
node selftest-client.mjs --print   # 顺便把渲染出来的面板文字打出来，肉眼核对
```

打包（在插件目录上一级执行）：`node package-dist.mjs` → `dist/` 里出 zip 与安装说明。

## 依赖

- Node ≥ 22（DSH Desktop 自带 node 也可用）
- 可选依赖 `tweetnacl-sealedbox-js`：用于写 GitHub Actions Secrets；缺失时自动改用仓库 `env.json`
- 本机运行文件与云端运行文件都是**零依赖**的（只用 Node 内置模块 + 全局 fetch）

## License

MIT
