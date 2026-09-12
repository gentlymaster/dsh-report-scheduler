window.__ModuleLoader__.load({
	id: "dsh-report-scheduler",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		const h = React.createElement;
		const API_BASE = "/api/dsh-report-scheduler";
		/** 面板版本号：用于确认浏览器是否加载到了新代码。 */
		const PANEL_VERSION = "v0.7-setup";

		async function request(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new Error("网络请求失败: " + String(error && error.message ? error.message : error));
			}
			let body;
			try {
				body = await response.json();
			} catch {
				throw new Error("HTTP " + response.status + ": 响应不是 JSON");
			}
			if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "HTTP " + response.status);
			return body;
		}

		const api = {
			getConfig: () => request(API_BASE + "/config"),
			saveConfig: (config) => request(API_BASE + "/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config }) }),
			status: () => request(API_BASE + "/status"),
			run: (payload) => request(API_BASE + "/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
			resend: () => request(API_BASE + "/resend", { method: "POST" }),
			dispatch: (dry) => request(API_BASE + "/dispatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dry }) }),
			cloudStatus: () => request(API_BASE + "/cloud/status"),
			cloudConnect: (payload) => request(API_BASE + "/cloud/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
			cloudSync: () => request(API_BASE + "/cloud/sync", { method: "POST" }),
			cloudRun: (payload) => request(API_BASE + "/cloud/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) }),
			cloudDisconnect: () => request(API_BASE + "/cloud/disconnect", { method: "POST" }),
			stats: (days) => request(API_BASE + "/stats?days=" + (days ?? 30)),
			archiveGet: () => request(API_BASE + "/archive"),
			archiveSave: (archive) => request(API_BASE + "/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive }) }),
			syncReports: () => request(API_BASE + "/sync-reports", { method: "POST" }),
			setup: () => request(API_BASE + "/setup"),
			setupAction: (payload) => request(API_BASE + "/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? { action: "install" }) }),
			keys: () => request(API_BASE + "/keys"),
			saveKeys: (payload) => request(API_BASE + "/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
			provision: (payload) => request(API_BASE + "/cloud/provision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
		};

		const s = {
			wrap: { display: "flex", flexDirection: "column", gap: "14px", fontSize: "13px" },
			card: { border: "1px solid var(--dsh-border, rgba(128,128,128,0.28))", borderRadius: "8px", padding: "12px 14px" },
			h: { margin: "0 0 8px", fontSize: "14px", fontWeight: 600 },
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			label: { opacity: 0.75, minWidth: "64px" },
			input: { padding: "5px 8px", borderRadius: "5px", border: "1px solid var(--dsh-border, rgba(128,128,128,0.4))", background: "transparent", color: "inherit", fontSize: "13px" },
			textarea: { width: "100%", minHeight: "90px", padding: "7px 9px", borderRadius: "5px", border: "1px solid var(--dsh-border, rgba(128,128,128,0.4))", background: "transparent", color: "inherit", fontSize: "12px", fontFamily: "inherit", boxSizing: "border-box" },
			select: { padding: "5px 8px", borderRadius: "5px", border: "1px solid var(--dsh-border, rgba(128,128,128,0.4))", background: "transparent", color: "inherit", fontSize: "13px" },
			btn: { padding: "5px 10px", borderRadius: "5px", border: "1px solid var(--dsh-border, rgba(128,128,128,0.5))", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12px" },
			btnPrimary: { padding: "5px 10px", borderRadius: "5px", border: "1px solid var(--dsh-accent, #4b8bf5)", background: "var(--dsh-accent, #4b8bf5)", color: "#fff", cursor: "pointer", fontSize: "12px" },
			taskRow: { display: "flex", gap: "10px", alignItems: "flex-start", padding: "8px 0", borderTop: "1px solid var(--dsh-border, rgba(128,128,128,0.2))" },
			meta: { opacity: 0.65, fontSize: "12px", lineHeight: "1.5" },
			ok: { color: "#2e9e5b" },
			bad: { color: "#d9483b" },
			pre: { margin: "6px 0 0", padding: "8px 10px", borderRadius: "6px", background: "rgba(128,128,128,0.10)", fontSize: "11.5px", lineHeight: "1.5", maxHeight: "200px", overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" },
			msg: { padding: "6px 10px", borderRadius: "6px", background: "rgba(128,128,128,0.12)", fontSize: "12px" },
			msgErr: { padding: "6px 10px", borderRadius: "6px", background: "rgba(217,72,59,0.14)", fontSize: "12px" },
			pill: { padding: "1px 7px", borderRadius: "999px", border: "1px solid var(--dsh-border, rgba(128,128,128,0.45))", fontSize: "11px", opacity: 0.9 },
			progress: { display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", borderRadius: "6px", background: "rgba(75,139,245,0.16)", fontSize: "12px" },
			spin: { display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", border: "2px solid rgba(128,128,128,0.35)", borderTopColor: "var(--dsh-accent, #4b8bf5)", animation: "dsh-rs-spin 0.8s linear infinite" },
			ver: { padding: "1px 6px", borderRadius: "4px", background: "rgba(128,128,128,0.18)", fontSize: "10.5px", opacity: 0.85 },
			cloudPill: { borderColor: "var(--dsh-accent, #4b8bf5)", color: "var(--dsh-accent, #4b8bf5)", opacity: 1 },
			tabs: { display: "flex", gap: "6px", borderBottom: "1px solid var(--dsh-border, rgba(128,128,128,0.25))", paddingBottom: "2px" },
			tab: { padding: "6px 14px", borderRadius: "6px 6px 0 0", border: "1px solid transparent", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12.5px", opacity: 0.65 },
			tabActive: { background: "rgba(128,128,128,0.14)", borderColor: "var(--dsh-border, rgba(128,128,128,0.35))", opacity: 1, fontWeight: 600 },
			stat: { flex: "1 1 200px", border: "1px solid var(--dsh-border, rgba(128,128,128,0.25))", borderRadius: "8px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "2px" },
			table: { width: "100%", borderCollapse: "collapse", marginTop: "10px", fontSize: "12px" },
			th: { textAlign: "left", padding: "5px 6px", borderBottom: "1px solid var(--dsh-border, rgba(128,128,128,0.35))", opacity: 0.75, fontWeight: 500, whiteSpace: "nowrap" },
			td: { padding: "4px 6px", borderBottom: "1px solid var(--dsh-border, rgba(128,128,128,0.15))", whiteSpace: "nowrap" },
		};

		function scheduleSummary(schedule) {
			if (!schedule) return "—";
			if (schedule.type === "daily") return "每天 " + schedule.time;
			if (schedule.type === "weekly") return "每周" + ["一", "二", "三", "四", "五", "六", "日"][schedule.weekday - 1] + " " + schedule.time;
			if (schedule.type === "interval") return "每 " + schedule.hours + " 小时";
			return String(schedule.type);
		}

		function emptyTask() {
			return { id: "", name: "", enabled: true, where: "local", schedule: { type: "daily", time: "08:00" }, prompt: "", sources: ["github", "news"] };
		}

		function ReportSchedulerPanel() {
			const [config, setConfig] = React.useState(null);
			const [status, setStatus] = React.useState(null);
			const [cloud, setCloud] = React.useState(null);
			const [stats, setStats] = React.useState(null);
			const [archive, setArchive] = React.useState(null);
			const [setup, setSetup] = React.useState(null);
			const [keys, setKeys] = React.useState(null);
			const [keysDraft, setKeysDraft] = React.useState({ deepseekKey: "", searchApiKey: "" });
			const [stepLog, setStepLog] = React.useState(null);
			const [ghToken, setGhToken] = React.useState("");
			const [ghRepo, setGhRepo] = React.useState("dsh-cloud-report");
			const [draft, setDraft] = React.useState(null);
			const [busy, setBusy] = React.useState("");
			const [tab, setTab] = React.useState("tasks");
			const [startedAt, setStartedAt] = React.useState(0);
			const [nowTick, setNowTick] = React.useState(0);
			const [msg, setMsg] = React.useState("");
			const [err, setErr] = React.useState("");

			const refresh = React.useCallback(async (quiet) => {
				if (!quiet) setErr("");
				try {
					const [cfg, st, cl] = await Promise.all([
						api.getConfig(),
						api.status(),
						api.cloudStatus().catch((error) => ({ cloud: { connected: false, error: String(error && error.message ? error.message : error) } })),
					]);
					setConfig(cfg.config);
					setStatus(st);
					setCloud(cl.cloud);
					if (!quiet) setMsg("");
					return cfg.config;
				} catch (error) {
					setErr(String(error && error.message ? error.message : error));
					return null;
				}
			}, []);

			React.useEffect(() => { refresh(true); }, [refresh]);

			// 运行中每秒刷新秒表，让「点了以后确实在跑」看得见
			React.useEffect(() => {
				if (busy === "") return undefined;
				const timer = setInterval(() => setNowTick(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [busy]);

			// 切到统计/归档页时按需加载（避免每次刷新都打 GitHub）
			React.useEffect(() => {
				if (tab === "stats" && stats === null) {
					withBusy("加载用量统计", async () => { setStats(await api.stats(30)); return undefined; });
				}
				if (tab === "config" && archive === null) {
					withBusy("加载归档配置", async () => { const r = await api.archiveGet(); setArchive(r.archive); return undefined; });
				}
			}, [tab, stats, archive]);

			// 渠道与云端页：按需加载本机状态与密钥状态（脱敏）
			React.useEffect(() => {
				if (tab !== "config" || setup !== null) return;
				api.setup().then((r) => setSetup(r.local)).catch(() => setSetup({ windows: false }));
				api.keys().then((r) => setKeys(r)).catch(() => undefined);
			}, [tab, setup]);

			const planById = {};
			for (const item of (status && status.plan && status.plan.tasks) || []) planById[item.id] = item;

			const elapsed = busy === "" ? 0 : Math.max(0, Math.round((nowTick - startedAt) / 1000));

			async function withBusy(label, fn) {
				setBusy(label);
				setStartedAt(Date.now());
				setNowTick(Date.now());
				setErr("");
				setMsg("");
				try {
					const result = await fn();
					if (typeof result === "string") setMsg(result);
					await refresh(true);
				} catch (error) {
					setErr(String(error && error.message ? error.message : error));
				} finally {
					setBusy("");
				}
			}

			function updateDraft(patch) {
				setDraft((current) => ({ ...(current ?? emptyTask()), ...patch }));
			}

			function updateDraftSchedule(patch) {
				setDraft((current) => {
					const base = current ?? emptyTask();
					return { ...base, schedule: { ...(base.schedule ?? {}), ...patch } };
				});
			}

			function saveTask() {
				if (!draft) return;
				const id = String(draft.id || "").trim();
				if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
					setErr("任务 id 只能用小写字母、数字和连字符，例如 ai-trends-daily");
					return;
				}
				if (!String(draft.prompt || "").trim()) {
					setErr("提示词不能为空");
					return;
				}
				const others = (config.tasks ?? []).filter((t) => t.id !== id);
				withBusy("保存任务", async () => {
					await api.saveConfig({ ...config, tasks: [...others, { ...draft, id }] });
					setDraft(null);
					return "任务已保存：" + id;
				});
			}

			function deleteTask(id) {
				withBusy("删除任务", async () => {
					await api.saveConfig({ ...config, tasks: (config.tasks ?? []).filter((t) => t.id !== id) });
					return "已删除任务：" + id;
				});
			}

			function toggleTask(id, enabled) {
				withBusy("切换启用状态", async () => {
					await api.saveConfig({ ...config, tasks: (config.tasks ?? []).map((t) => (t.id === id ? { ...t, enabled } : t)) });
				});
			}

			function savePush(patch) {
				withBusy("保存渠道配置", async () => {
					await api.saveConfig({ ...config, push: { ...config.push, ...patch } });
					return "推送配置已保存";
				});
			}

			function connectCloud() {
				if (!ghToken.trim()) {
					setErr("请先粘贴 GitHub token");
					return;
				}
				withBusy("连接云端", async () => {
					const r = await api.cloudConnect({ token: ghToken.trim(), repo: ghRepo.trim() || "dsh-cloud-report" });
					setGhToken("");
					return `已连接云端：${r.cloud.owner}/${r.cloud.repo}`;
				});
			}

			/** 保存云端密钥与设置（返回全部脱敏）。 */
			function saveKeys(patch, clear) {
				withBusy("保存密钥与设置", async () => {
					const r = await api.saveKeys({ ...patch, ...(clear ? { clear } : {}) });
					setKeys(r);
					return "已保存（密钥只写在本机，不会回传给浏览器）";
				});
			}

			/** 一键部署云端：建仓 → 上传运行文件 → 写密钥/变量 → 同步任务。 */
			function provisionCloud(extra) {
				const payload = {
					token: ghToken.trim() || undefined,
					deepseekKey: keysDraft.deepseekKey.trim() || undefined,
					searchApiKey: keysDraft.searchApiKey.trim() || undefined,
					pushToken: (config.push.token ?? "").trim() || undefined,
					cloud: config.cloud,
					...extra,
				};
				withBusy("一键部署云端（30–60 秒）", async () => {
					setStepLog(null);
					const r = await api.provision(payload);
					setStepLog(r);
					setKeys(await api.keys());
					return r.keyStoreUsed === "file"
						? "部署完成，但密钥写进了仓库 env.json（私有仓才建议）"
						: "部署完成：" + (r.repoUrl ?? r.repo);
				});
			}

			/** 一键配置本机：运行文件 + 无头 profile + 计划任务。 */
			function setupLocalNow(extra) {
				withBusy("一键配置本机（首次约 1 分钟）", async () => {
					setStepLog(null);
					const r = await api.setupAction({ action: "install", intervalMinutes: config.checkIntervalMinutes ?? 15, ...extra });
					setStepLog(r);
					setSetup(r.local);
					return r.ok ? "本机配置完成，计划任务已注册" : "本机配置未完成：" + (r.error ?? "");
				});
			}

			function syncCloud() {
				withBusy("同步云端任务", async () => {
					const r = await api.cloudSync();
					return `已同步 ${r.synced} 个云端任务到仓库`;
				});
			}

			function runCloud() {
				withBusy("触发云端运行", async () => {
					const r = await api.cloudRun({});
					return `已触发云端 workflow：${r.workflow}`;
				});
			}

			function disconnectCloud() {
				withBusy("断开云端", async () => {
					await api.cloudDisconnect();
					return "已断开云端连接（仓库里的东西没动）";
				});
			}

			if (config === null) {
				return h("div", { style: s.wrap }, h("div", { style: s.msg }, err ? "加载失败：" + err : "加载中…"));
			}

			const planNow = status && status.plan ? status.plan.now : "";
			const tasks = config.tasks ?? [];

			return h(
				"div",
				{ style: s.wrap, className: "dsh-rs" },

				h("style", { key: "css" }, "@keyframes dsh-rs-spin{to{transform:rotate(360deg)}} .dsh-rs button:disabled{opacity:.45;cursor:default}"),

				// 头部
				h(
					"div",
					{ style: { ...s.row, justifyContent: "space-between" } },
					h(
						"div",
						{ style: s.row },
						h("strong", null, "定时报告"),
						h("span", { style: s.ver }, PANEL_VERSION),
						h("span", { style: s.meta }, planNow ? "调度判定时间：" + planNow : "")
					),
					h("button", { style: s.btn, disabled: busy !== "", onClick: () => withBusy("刷新", async () => "已刷新") }, "刷新")
				),

				// 标签页
				h(
					"div",
					{ style: s.tabs },
					[
						["tasks", "任务（" + tasks.length + "）"],
						["stats", "用量统计"],
						["config", "渠道与云端"],
						["logs", "派发日志"],
					].map(([id, label]) => h("button", { key: id, style: tab === id ? { ...s.tab, ...s.tabActive } : s.tab, onClick: () => setTab(id) }, label))
				),

				// 运行中：明确的进度反馈（含秒表）
				busy !== "" &&
					h(
						"div",
						{ style: s.progress },
						h("span", { style: s.spin }),
						h("span", null, "正在执行：" + busy + " — 已用 " + elapsed + " 秒"),
						h("span", { style: s.meta }, "（联网生成通常 1–5 分钟，期间请勿重复点击）")
					),
				err !== "" && h("div", { style: s.msgErr }, err),
				msg !== "" && h("div", { style: s.msg }, msg),

				// 推送渠道（渠道与云端页）
				tab === "config" &&
				h(
					"div",
					{ style: s.card },
					h("p", { style: s.h }, "① 推送渠道（报告发到哪里）"),
					h(
						"div",
						{ style: s.row },
						h("span", { style: s.label }, "渠道"),
						h(
							"select",
							{ style: s.select, value: config.push.provider, onChange: (e) => setConfig({ ...config, push: { ...config.push, provider: e.target.value } }) },
							h("option", { value: "none" }, "不推送"),
							h("option", { value: "serverchan" }, "Server酱（微信）"),
							h("option", { value: "pushplus" }, "PushPlus（微信）"),
							h("option", { value: "wxpusher" }, "WxPusher")
						),
						h("span", { style: s.label }, "Token"),
						h("input", { style: { ...s.input, width: "260px" }, type: "password", value: config.push.token, placeholder: "SCT… / 32 位 token", onChange: (e) => setConfig({ ...config, push: { ...config.push, token: e.target.value } }) }),
						h("span", { style: s.label }, "标题"),
						h("input", { style: { ...s.input, width: "150px" }, value: config.push.title, onChange: (e) => setConfig({ ...config, push: { ...config.push, title: e.target.value } }) }),
						h("button", { style: s.btnPrimary, disabled: busy !== "", onClick: () => savePush({}) }, "保存渠道")
					),
					h("p", { style: { ...s.meta, marginTop: "6px", marginBottom: 0 } }, "Token 明文保存在本机 ~/.dsh/dsh-report-scheduler/config.json，不会随报告外发。本机与云端共用这一个渠道配置。")
				),

				// ② 云端密钥与搜索（渠道与云端页）
				tab === "config" &&
				h(
					"div",
					{ style: s.card },
					h("p", { style: s.h }, "② 云端密钥与搜索（云端跑报告要用）"),
					h(
						"div",
						{ style: s.row },
						h("span", { style: s.label }, "DeepSeek Key"),
						h("input", {
							style: { ...s.input, width: "300px" },
							type: "password",
							value: keysDraft.deepseekKey,
							placeholder: keys && keys.keys.deepseekKey.set ? "已保存 " + keys.keys.deepseekKey.masked + "（留空=不改）" : "sk-…（必填，云端生成报告要用）",
							onChange: (e) => setKeysDraft({ ...keysDraft, deepseekKey: e.target.value }),
						}),
						h("span", { style: s.label }, "搜索 Key"),
						h("input", {
							style: { ...s.input, width: "260px" },
							type: "password",
							value: keysDraft.searchApiKey,
							placeholder: keys && keys.keys.searchApiKey.set ? "已保存 " + keys.keys.searchApiKey.masked + "（留空=不改）" : "Tavily / Serper / Brave 的 key",
							onChange: (e) => setKeysDraft({ ...keysDraft, searchApiKey: e.target.value }),
						}),
						h("button", {
							style: s.btnPrimary,
							disabled: busy !== "",
							onClick: () => saveKeys({ deepseekKey: keysDraft.deepseekKey, searchApiKey: keysDraft.searchApiKey }),
						}, "保存密钥")
					),
					h(
						"div",
						{ style: { ...s.row, marginTop: "8px" } },
						h("span", { style: s.label }, "搜索服务"),
						h(
							"select",
							{ style: s.select, value: config.cloud.searchProvider ?? "tavily", onChange: (e) => setConfig({ ...config, cloud: { ...config.cloud, searchProvider: e.target.value } }) },
							h("option", { value: "tavily" }, "Tavily（推荐）"),
							h("option", { value: "serper" }, "Serper"),
							h("option", { value: "brave" }, "Brave"),
							h("option", { value: "" }, "不搜索（只用 GitHub 趋势）")
						),
						h("span", { style: s.label }, "检索深度"),
						h(
							"select",
							{ style: s.select, value: config.cloud.searchDepth ?? "advanced", onChange: (e) => setConfig({ ...config, cloud: { ...config.cloud, searchDepth: e.target.value } }) },
							h("option", { value: "basic" }, "basic（便宜）"),
							h("option", { value: "advanced" }, "advanced（更全，1 次=2 credits）")
						),
						h("span", { style: s.label }, "模型"),
						h("input", { style: { ...s.input, width: "180px" }, value: config.cloud.model ?? "deepseek-v4-flash", onChange: (e) => setConfig({ ...config, cloud: { ...config.cloud, model: e.target.value } }) }),
						h("span", { style: s.label }, "简报标题"),
						h("input", { style: { ...s.input, width: "160px" }, value: config.cloud.reportTitle ?? "DSH 云端简报", onChange: (e) => setConfig({ ...config, cloud: { ...config.cloud, reportTitle: e.target.value } }) }),
						h(
							"select",
							{ style: s.select, value: config.cloud.keyStore ?? "auto", onChange: (e) => setConfig({ ...config, cloud: { ...config.cloud, keyStore: e.target.value } }) },
							h("option", { value: "auto" }, "密钥：自动（优先 Secrets）"),
							h("option", { value: "secrets" }, "密钥：只写 Actions Secrets"),
							h("option", { value: "file" }, "密钥：写仓库 env.json")
						),
						h("button", { style: s.btn, disabled: busy !== "", onClick: () => saveKeys({ cloud: config.cloud }) }, "保存设置")
					),
					h("p", { style: { ...s.meta, marginTop: "6px", marginBottom: 0 } },
						"密钥只存在本机 secrets.json，点「一键部署」时才推送到你自己的仓库。搜索服务可留空——那云端只汇总 GitHub 趋势。"
					),
					keys && keys.keys.dshDeepseek && keys.keys.dshDeepseek.available &&
						h(
							"label",
							{ style: { ...s.row, gap: "4px", marginTop: "6px" } },
							h("input", {
								type: "checkbox",
								checked: config.cloud.useDshCredential === true,
								onChange: (e) => {
									const next = { ...config, cloud: { ...config.cloud, useDshCredential: e.target.checked } };
									setConfig(next);
									saveKeys({ cloud: next.cloud });
								},
							}),
							"用 DSH 里已配置的 DeepSeek Key（" + keys.keys.dshDeepseek.masked + "）—— 免去再粘一次"
						),
					keys === null && h("p", { style: s.meta }, "正在读取本机密钥状态…")
				),

				// 部署步骤日志（渠道与云端页）
				tab === "config" && stepLog &&
				h(
					"div",
					{ style: s.card },
					h(
						"div",
						{ style: { ...s.row, justifyContent: "space-between" } },
						h("p", { style: { ...s.h, margin: 0 } }, stepLog.ok === false ? "部署中止" : "部署步骤"),
						h("button", { style: s.btn, onClick: () => setStepLog(null) }, "关闭")
					),
					stepLog.error && h("div", { style: s.msgErr }, stepLog.error),
					h(
						"div",
						{ style: { marginTop: "6px" } },
						(stepLog.steps ?? []).map((x, i) =>
							h("div", { key: i, style: x.ok ? s.meta : { ...s.meta, ...s.bad } }, (x.ok ? "✓ " : "✗ ") + x.name + (x.detail ? " — " + x.detail : ""))
						)
					),
					stepLog.keyStoreUsed && h("p", { style: { ...s.meta, marginTop: "6px", marginBottom: 0 } }, "密钥落地方式：" + (stepLog.keyStoreUsed === "secrets" ? "GitHub Actions Secrets" : stepLog.keyStoreUsed === "file" ? "仓库 env.json（私有仓才建议）" : "未写入"))
				),

				// 任务列表（任务页）
				tab === "tasks" &&
				h(
					"div",
					{ style: s.card },
					h(
						"div",
						{ style: { ...s.row, justifyContent: "space-between" } },
						h("p", { style: { ...s.h, margin: 0 } }, "任务（" + tasks.length + "）"),
						h(
							"div",
							{ style: s.row },
							h("button", { style: s.btn, disabled: busy !== "", title: "按当前时间判定并执行到点的本机任务", onClick: () => withBusy("手动 tick", async () => { const r = await api.dispatch(false); return "手动 tick：" + JSON.stringify(r.result && r.result.results ? r.result.results : r.result); }) }, "手动 tick"),
							h("button", { style: s.btnPrimary, disabled: busy !== "", onClick: () => setDraft(emptyTask()) }, "+ 新建任务")
						)
					),
					tasks.length === 0 && h("p", { style: s.meta }, "还没有任务。点「+ 新建任务」开始。"),
					tasks.map((task) => {
						const plan = planById[task.id] ?? {};
						const st = (status && status.state && status.state.tasks && status.state.tasks[task.id]) || {};
						const running = busy !== "" && busy.indexOf(task.name) >= 0;
						return h(
							"div",
							{ key: task.id, style: s.taskRow },
							h("input", { type: "checkbox", checked: task.enabled !== false, disabled: busy !== "", onChange: (e) => toggleTask(task.id, e.target.checked) }),
							h(
								"div",
								{ style: { flex: 1, minWidth: "280px" } },
								h(
									"div",
									{ style: { fontWeight: 600 } },
									task.name,
									" ",
									h("span", { style: s.pill }, task.id),
									" ",
									h("span", { style: task.where === "cloud" ? { ...s.pill, ...s.cloudPill } : s.pill }, task.where === "cloud" ? "云端" : "本机")
								),
								h("div", { style: s.meta }, scheduleSummary(task.schedule) + (task.schedule && task.schedule.catchUp === false ? "（不补跑）" : "")),
								h("div", { style: s.meta }, "下次：" + (plan.nextDue ?? "—")),
								h(
									"div",
									{ style: st.ok === false ? s.bad : s.meta },
									st.lastRun ? "上次：" + new Date(st.lastRun).toLocaleString() + (st.ok === false ? " 失败" : " 成功") + (st.detail ? " · " + String(st.detail).slice(0, 120) : "") : "上次：尚未运行"
								),
								plan.reason && h("div", { style: s.meta }, "状态：" + plan.reason)
							),
							h(
								"div",
								{ style: { ...s.row, flexWrap: "nowrap" } },
								running && h("span", { style: s.pill }, "运行中…"),
								h("button", { style: s.btn, disabled: busy !== "", onClick: () => setDraft({ ...task, schedule: { ...task.schedule } }) }, "编辑"),
								task.where === "cloud"
									? h("button", {
											style: s.btnPrimary,
											disabled: busy !== "" || !(cloud && cloud.connected) || (cloud && Array.isArray(cloud.pendingSync) && cloud.pendingSync.includes(task.id)),
											title: !(cloud && cloud.connected)
												? "先在下方连接云端"
												: cloud && Array.isArray(cloud.pendingSync) && cloud.pendingSync.includes(task.id)
													? "该任务还没同步到仓库，请先点「同步任务到仓库」"
													: "",
											onClick: () => withBusy("云端运行：" + task.name, async () => { const r = await api.cloudRun({ id: task.id }); return "已触发云端运行：" + (r.workflow ?? "workflow"); }),
										}, "云端运行")
									: h(
											React.Fragment,
											null,
											h("button", { style: s.btn, disabled: busy !== "", onClick: () => withBusy("试跑：" + task.name, async () => { const r = await api.run({ id: task.id, dry: true }); return "试跑（不推送）：" + (r.result ? "生成 " + r.result.answerChars + " 字，耗时 " + Math.round(r.result.ms / 1000) + "s" : JSON.stringify(r)); }) }, "试跑"),
											h("button", { style: s.btnPrimary, disabled: busy !== "", onClick: () => withBusy("运行并推送：" + task.name, async () => { const r = await api.run({ id: task.id }); return "已运行并推送：" + (r.result && r.result.pushed ? r.result.pushed.detail : JSON.stringify(r)); }) }, "立即运行")
										),
								h("button", { style: s.btn, disabled: busy !== "", onClick: () => deleteTask(task.id) }, "删除")
							)
						);
					})
				),

				// 编辑表单（任务页）
				tab === "tasks" &&
				draft &&
					h(
						"div",
						{ style: s.card },
						h("p", { style: s.h }, tasks.some((t) => t.id === draft.id) ? "编辑任务：" + draft.id : "新建任务"),
						h(
							"div",
							{ style: s.row },
							h("span", { style: s.label }, "id"),
							h("input", { style: { ...s.input, width: "200px" }, value: draft.id, placeholder: "ai-trends-daily", disabled: tasks.some((t) => t.id === draft.id), onChange: (e) => updateDraft({ id: e.target.value }) }),
							h("span", { style: s.label }, "名称"),
							h("input", { style: { ...s.input, width: "220px" }, value: draft.name, placeholder: "AI 涨星日报", onChange: (e) => updateDraft({ name: e.target.value }) }),
							h("label", { style: { ...s.row, gap: "4px" } }, h("input", { type: "checkbox", checked: draft.enabled !== false, onChange: (e) => updateDraft({ enabled: e.target.checked }) }), "启用")
						),
						h(
							"div",
							{ style: { ...s.row, marginTop: "8px" } },
							h("span", { style: s.label }, "执行位置"),
							h(
								"select",
								{ style: s.select, value: draft.where ?? "local", onChange: (e) => updateDraft({ where: e.target.value }) },
								h("option", { value: "local" }, "本机（无头 DSH agent，能多轮检索/读本地文件）"),
								h("option", { value: "cloud" }, "云端（GitHub Actions，关机也能跑）")
							),
							draft.where === "cloud" &&
								h(
									React.Fragment,
									null,
									h("span", { style: s.label }, "数据源"),
									h("label", { style: { ...s.row, gap: "4px" } }, h("input", { type: "checkbox", checked: (draft.sources ?? []).includes("github"), onChange: (e) => updateDraft({ sources: e.target.checked ? [...new Set([...(draft.sources ?? []), "github"])] : (draft.sources ?? []).filter((x) => x !== "github") }) }), "GitHub 趋势"),
									h("label", { style: { ...s.row, gap: "4px" } }, h("input", { type: "checkbox", checked: (draft.sources ?? []).includes("news"), onChange: (e) => updateDraft({ sources: e.target.checked ? [...new Set([...(draft.sources ?? []), "news"])] : (draft.sources ?? []).filter((x) => x !== "news") }) }), "行业资讯（Tavily）")
								)
						),
						draft.where === "cloud" &&
							h(
								"div",
								{ style: { ...s.row, marginTop: "8px" } },
								h("span", { style: s.label }, "检索词"),
								h("input", {
									style: { ...s.input, width: "520px" },
									value: (draft.queries ?? []).join(";"),
									placeholder: "AI 大模型 最新进展;化学 材料 实验室自动化",
									onChange: (e) => updateDraft({ queries: e.target.value.split(";").map((x) => x.trim()).filter(Boolean) }),
								}),
								h("span", { style: s.meta }, "分号分隔；留空用默认两组")
							),
						h(
							"div",
							{ style: { ...s.row, marginTop: "8px" } },
							h("span", { style: s.label }, "调度"),
							h(
								"select",
								{ style: s.select, value: draft.schedule.type, onChange: (e) => updateDraftSchedule({ type: e.target.value }) },
								h("option", { value: "daily" }, "每天"),
								h("option", { value: "weekly" }, "每周"),
								h("option", { value: "interval" }, "每隔 N 小时")
							),
							draft.schedule.type === "weekly" &&
								h(
									"select",
									{ style: s.select, value: String(draft.schedule.weekday ?? 1), onChange: (e) => updateDraftSchedule({ weekday: Number(e.target.value) }) },
									["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((label, index) => h("option", { key: label, value: String(index + 1) }, label))
								),
							(draft.schedule.type === "daily" || draft.schedule.type === "weekly") &&
								h("input", { style: { ...s.input, width: "90px" }, value: draft.schedule.time ?? "08:00", placeholder: "08:00", onChange: (e) => updateDraftSchedule({ time: e.target.value }) }),
							draft.schedule.type === "interval" &&
								h("input", { style: { ...s.input, width: "80px" }, type: "number", min: "1", max: "24", value: draft.schedule.hours ?? 6, onChange: (e) => updateDraftSchedule({ hours: Number(e.target.value) }) }),
							h("label", { style: { ...s.row, gap: "4px" } }, h("input", { type: "checkbox", checked: draft.schedule.catchUp !== false, onChange: (e) => updateDraftSchedule({ catchUp: e.target.checked }) }), "关机后补跑")
						),
						h("p", { style: { ...s.meta, marginTop: "10px", marginBottom: "4px" } }, "提示词（到点由无头 agent 执行，可要求联网检索）"),
						h("textarea", { style: s.textarea, value: draft.prompt, onChange: (e) => updateDraft({ prompt: e.target.value }) }),
						h(
							"div",
							{ style: { ...s.row, marginTop: "8px" } },
							h("button", { style: s.btnPrimary, disabled: busy !== "", onClick: saveTask }, "保存任务"),
							h("button", { style: s.btn, disabled: busy !== "", onClick: () => setDraft(null) }, "取消")
						)
					),

				// ③ 部署到云端（渠道与云端页）
				tab === "config" &&
				h(
					"div",
					{ style: s.card },
					h("p", { style: s.h }, "③ 部署到云端（GitHub Actions，关机也能跑）"),
					!cloud || !cloud.connected
						? h(
								React.Fragment,
								null,
								h(
									"div",
									{ style: s.row },
									h("span", { style: s.label }, "Token"),
									h("input", { style: { ...s.input, width: "320px" }, type: "password", value: ghToken, placeholder: "github_pat_… / ghp_…", onChange: (e) => setGhToken(e.target.value) }),
									h("span", { style: s.label }, "仓库"),
									h("input", { style: { ...s.input, width: "200px" }, value: ghRepo, onChange: (e) => setGhRepo(e.target.value) }),
									h("button", { style: s.btn, disabled: busy !== "", onClick: connectCloud }, "只连接"),
									h("button", { style: s.btnPrimary, disabled: busy !== "", onClick: () => provisionCloud({ dispatch: false }) }, "一键部署云端")
								),
								h("p", { style: { ...s.meta, marginTop: "6px", marginBottom: 0 } },
									"点「一键部署云端」会自动：仓库不存在就创建私有仓 → 上传云端运行文件 → 写入密钥与变量 → 同步任务表。token 只存本机 ~/.dsh/dsh-report-scheduler/github.json。",
									" 需要的权限：Contents 读写、Actions 读写、Administration 读写（建私有仓用；仓库已存在时可省）。Secrets 写权限没有的话，会自动回退把密钥写进仓库 env.json。"
								),
								cloud && cloud.error && h("div", { style: s.msgErr }, "上次状态查询失败：" + cloud.error)
							)
						: h(
								React.Fragment,
								null,
								h(
									"div",
									{ style: s.row, justifyContent: "space-between" },
									h(
										"div",
										{ style: s.row },
										h("span", { style: s.pill }, `${cloud.owner}/${cloud.repo}`),
										h("span", { style: s.meta }, `${cloud.private ? "私有" : "公开"} · 分支 ${cloud.branch} · token ${cloud.tokenMasked}`),
										h("span", { style: s.meta }, cloud.lastSync ? `上次同步：${new Date(cloud.lastSync.at).toLocaleString()}（${cloud.lastSync.tasks} 个任务）` : "尚未同步过"),
										cloud.remoteTasks && h("span", { style: s.meta }, `仓库里现有 ${cloud.remoteTasks.length} 个云端任务`)
									),
									h(
										"div",
										{ style: s.row },
										h("button", { style: s.btnPrimary, disabled: busy !== "", onClick: () => provisionCloud({ dispatch: false }) }, "重新部署/更新运行文件"),
										h("button", { style: s.btn, disabled: busy !== "", onClick: syncCloud }, "同步任务到仓库"),
										h("button", { style: s.btn, disabled: busy !== "", onClick: runCloud }, "云端运行一次"),
										h("button", { style: s.btn, disabled: busy !== "", onClick: disconnectCloud }, "断开")
									)
								),
								cloud.runs && cloud.runs.length > 0 &&
									h(
										"div",
										{ style: { marginTop: "8px" } },
										h("span", { style: s.meta }, "最近运行："),
										cloud.runs.map((r) =>
											h(
												"span",
												{ key: r.id, style: { ...s.meta, marginLeft: "8px" } },
												`${r.conclusion ?? r.status}（${new Date(r.createdAt).toLocaleString()}，${r.event}）`
											)
										)
									),
								cloud.pendingSync && cloud.pendingSync.length > 0 &&
									h("div", { style: { ...s.msgErr, marginTop: "8px" } }, `有 ${cloud.pendingSync.length} 个云端任务还没同步到仓库：${cloud.pendingSync.join("、")} —— 先点「同步任务到仓库」，云端才会认识它`),
								cloud.ok === false && h("div", { style: s.msgErr }, "云端查询失败：" + cloud.error)
							)
				),

				// ④ 本机定时（渠道与云端页）
				tab === "config" &&
				h(
					"div",
					{ style: s.card },
					h("p", { style: s.h }, "④ 本机定时（Windows 计划任务，电脑开着才跑）"),
					setup === null
						? h("p", { style: s.meta }, "正在探测本机环境…")
						: h(
								React.Fragment,
								null,
								h(
									"div",
									{ style: s.row },
									h("span", { style: setup.node ? s.pill : { ...s.pill, ...s.bad } }, setup.node ? "node ✓" : "node ✗"),
									h("span", { style: setup.dshCli ? s.pill : { ...s.pill, ...s.bad } }, setup.dshCli ? "DSH CLI ✓" : "DSH CLI ✗"),
									h("span", { style: setup.profileReady ? s.pill : s.pill }, setup.profileReady ? "无头 profile ✓" : "无头 profile 未创建"),
									h("span", { style: setup.runtimeInstalled ? s.pill : s.pill }, setup.runtimeInstalled ? "运行文件 ✓ v" + setup.runtimeVersion : "运行文件待安装"),
									h("span", { style: setup.task && setup.task.exists ? { ...s.pill, ...s.cloudPill } : s.pill }, setup.task && setup.task.exists ? "计划任务 ✓ " + setup.taskName : "计划任务未注册")
								),
								h(
									"div",
									{ style: { ...s.row, marginTop: "8px" } },
									h("span", { style: s.label }, "tick 间隔(分)"),
									h("input", { style: { ...s.input, width: "70px" }, type: "number", min: "5", max: "120", value: config.checkIntervalMinutes ?? 15, onChange: (e) => setConfig({ ...config, checkIntervalMinutes: Number(e.target.value) }) }),
									h("button", { style: s.btnPrimary, disabled: busy !== "" || !setup.windows, onClick: () => setupLocalNow({ registerTask: true }) }, "一键配置本机"),
									h("button", { style: s.btn, disabled: busy !== "" || !(setup.task && setup.task.exists), onClick: () => withBusy("手动跑一次计划任务", async () => { const r = await api.setupAction({ action: "run" }); return r.ok ? "已触发计划任务，稍后看派发日志" : "触发失败：" + (r.detail ?? ""); }) }, "立即 tick"),
									h("button", { style: s.btn, disabled: busy !== "" || !(setup.task && setup.task.exists), onClick: () => withBusy("移除计划任务", async () => { const r = await api.setupAction({ action: "remove", keepFiles: true }); setSetup(r.local); return "已移除计划任务（运行文件保留）"; }) }, "移除计划任务")
								),
								h("p", { style: { ...s.meta, marginTop: "6px", marginBottom: 0 } },
									"「一键配置本机」会：安装运行文件 → 需要时创建 headless profile（首次约 1 分钟）→ 生成 tick.cmd → 注册计划任务。之后本机任务到点自动生成并推送，无需打开 DSH。",
									setup.task && setup.task.exists && setup.task.nextRun ? " 下次运行：" + setup.task.nextRun : ""
								),
								setup.node && h("p", { style: { ...s.meta, marginTop: "4px", marginBottom: 0 } }, `node：${setup.node}（${setup.nodeKind}）　DSH_HOME：${setup.dshHome}`),
								!setup.windows && h("div", { style: s.msgErr }, "当前系统不是 Windows：本机定时请用系统 cron 调 dispatcher.mjs，或用云端模式。")
							)
				),

				// 报告归档（渠道与云端页）
				tab === "config" && archive &&
				h(
					"div",
					{ style: s.card },
					h("p", { style: s.h }, "⑤ 报告归档（Obsidian，可选）"),
					h(
						"div",
						{ style: s.row },
						h("label", { style: { ...s.row, gap: "4px" } }, h("input", { type: "checkbox", checked: archive.enabled === true, onChange: (e) => setArchive({ ...archive, enabled: e.target.checked }) }), "启用"),
						h("span", { style: s.label }, "库路径"),
						h("input", { style: { ...s.input, width: "380px" }, value: archive.vaultPath ?? "", placeholder: "C:\\Users\\gentl\\Documents\\Obsidian Vault", onChange: (e) => setArchive({ ...archive, vaultPath: e.target.value }) }),
						h("span", { style: s.label }, "子目录"),
						h("input", { style: { ...s.input, width: "130px" }, value: archive.subfolder ?? "AI 简报", onChange: (e) => setArchive({ ...archive, subfolder: e.target.value }) }),
						h("button", { style: s.btnPrimary, disabled: busy !== "", onClick: () => withBusy("保存归档配置", async () => { const r = await api.archiveSave(archive); setArchive(r.archive); return "归档配置已保存"; }) }, "保存"),
						h("button", { style: s.btn, disabled: busy !== "" || !(cloud && cloud.connected), title: cloud && cloud.connected ? "" : "先在下方连接云端", onClick: () => withBusy("同步云端报告", async () => { const r = await api.syncReports(); return r.ok ? `已同步 ${r.written.length} 个云端报告 → ${r.vaultDir}` : String(r.error); }) }, "同步云端报告到库")
					),
					h("p", { style: { ...s.meta, marginTop: "6px", marginBottom: 0 } }, "本机任务的报告生成后自动写入该目录；云端报告用右侧按钮拉取（已同步过的不会重复写）。")
				),

				// 用量统计（统计页）
				tab === "stats" &&
				h(
					"div",
					{ style: s.card },
					h(
						"div",
						{ style: { ...s.row, justifyContent: "space-between" } },
						h("p", { style: { ...s.h, margin: 0 } }, "用量与花费"),
						h("button", { style: s.btn, disabled: busy !== "", onClick: () => withBusy("刷新统计", async () => { setStats(await api.stats(30)); return undefined; }) }, "刷新")
					),
					stats === null
						? h("p", { style: s.meta }, "加载中…")
						: h(
								React.Fragment,
								null,
								h(
									"div",
									{ style: { ...s.row, alignItems: "stretch" } },
									[
										["今日", stats.summary.today],
										["近 30 天", stats.summary.window],
										["全部", stats.summary.all],
									].map(([label, agg]) =>
										h(
											"div",
											{ key: label, style: s.stat },
											h("div", { style: s.meta }, label),
											h("div", { style: { fontSize: "18px", fontWeight: 600 } }, "¥" + Number(agg.cny ?? 0).toFixed(4)),
											h("div", { style: s.meta }, `${agg.runs} 次 · 成功 ${agg.ok}${agg.failed ? " · 失败 " + agg.failed : ""}`),
											h("div", { style: s.meta }, `输入 ${agg.tokensIn.toLocaleString()} / 输出 ${agg.tokensOut.toLocaleString()}${agg.tokensCached ? " / 缓存 " + agg.tokensCached.toLocaleString() : ""}`)
										)
									)
								),
								h("p", { style: { ...s.meta, marginTop: "8px" } }, `账本：本机 ${stats.localCount} 条 · 云端 ${stats.cloudCount} 条${stats.cloudError ? "（云端读取失败：" + stats.cloudError + "）" : ""}　单价按 deepseek-v4-flash（$0.14/$0.28 每百万 token，汇率 7.37）`),
								h(
									"table",
									{ style: s.table },
									h(
										"thead",
										null,
										h(
											"tr",
											null,
											["时间", "任务", "位置", "输入", "输出", "缓存", "费用(¥)", "耗时", "结果"].map((t) => h("th", { key: t, style: s.th }, t))
										)
									),
									h(
										"tbody",
										null,
										stats.entries.slice(0, 80).map((e) =>
											h(
												"tr",
												{ key: `${e.at}-${e.task}` },
												h("td", { style: s.td }, new Date(e.at).toLocaleString()),
												h("td", { style: s.td }, e.name || e.task),
												h("td", { style: s.td }, e.where === "cloud" ? "云端" : "本机"),
												h("td", { style: s.td }, String(e.cost?.tokensIn ?? "-")),
												h("td", { style: s.td }, String(e.cost?.tokensOut ?? "-")),
												h("td", { style: s.td }, String(e.cost?.tokensCached ?? 0)),
												h("td", { style: s.td }, e.cost ? Number(e.cost.cny).toFixed(4) : "-"),
												h("td", { style: s.td }, e.ms ? Math.round(e.ms / 1000) + "s" : "-"),
												h("td", { style: e.ok === false ? s.bad : s.td }, e.ok === false ? "失败" : "成功")
											)
										)
									)
								),
								stats.entries.length === 0 && h("p", { style: s.meta }, "还没有记录：跑一次任务（本机或云端）就会出现在这里。")
							)
				),

				// 日志（派发日志页）
				tab === "logs" &&
				h(
					"div",
					{ style: s.card },
					h(
						"div",
						{ style: { ...s.row, justifyContent: "space-between" } },
						h("p", { style: { ...s.h, margin: 0 } }, "派发日志（最近 40 行）"),
						h("button", { style: s.btn, disabled: busy !== "", title: "把最近一次生成的本机报告重新推送一次", onClick: () => withBusy("重发最近报告", async () => { const r = await api.resend(); return "重发最近存档：" + (r.result && r.result.pushed ? r.result.pushed.detail : JSON.stringify(r)); }) }, "重发最近报告")
					),
					status && status.planError && h("div", { style: s.msgErr }, "调度判定失败：" + status.planError),
					h("pre", { style: s.pre }, ((status && status.log) || []).join("\n") || "（暂无日志）")
				)
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{ name: "settings.section", id: "report-scheduler", order: 310, label: () => "定时报告" },
						ReportSchedulerPanel
					)
				);
			} catch (error) {
				console.warn("[dsh-report-scheduler] settings panel registration failed:", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
