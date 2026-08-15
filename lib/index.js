import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/home.ts
/** 安全读取环境变量（host 半运行在 Node 进程里，仍做防御性判断）。 */
function env(name) {
	try {
		return (typeof process !== "undefined" && process.env ? process.env : {})[name];
	} catch {
		return;
	}
}
function createHomeFinder(ctx) {
	const fs = ctx.get("fs");
	async function isDir(p) {
		if (!fs) return false;
		try {
			const target = await fs.resolve(p);
			const info = await fs.stat(target);
			return !!(info && info.type === "directory");
		} catch {
			return false;
		}
	}
	async function listDir(p) {
		if (!fs) return [];
		try {
			const target = await fs.resolve(p);
			const info = await fs.stat(target);
			if (!info || info.type !== "directory") return [];
			return await fs.listDir(target);
		} catch {
			return [];
		}
	}
	/** 环境变量候选（去重、去尾部分隔符、保留顺序：Windows 优先 USERPROFILE）。 */
	function envCandidates() {
		const out = [];
		for (const name of ["USERPROFILE", "HOME"]) {
			const v = env(name);
			if (v && !out.includes(v)) out.push(v.replace(/[\\/]+$/, ""));
		}
		return out;
	}
	/**
	* 定位用户主目录。
	* @param markers 回退扫描时用于识别 home 的目录名（如 ['.claude', '.dsh']）。
	*/
	async function find(markers) {
		for (const home of envCandidates()) if (await isDir(home)) return home;
		const found = [];
		const SKIP = {
			Public: 1,
			Default: 1,
			"Default User": 1,
			"All Users": 1
		};
		async function probe(base, name) {
			const h = name ? `${base}/${name}` : base;
			for (const m of markers) if (await isDir(`${h}/${m}`)) {
				found.push(h);
				return;
			}
		}
		for (const e of await listDir("C:/Users")) if (e.type === "directory" && !SKIP[e.name]) await probe("C:/Users", e.name);
		for (const base of ["/home", "/Users"]) for (const e of await listDir(base)) if (e.type === "directory") await probe(base, e.name);
		return found[0];
	}
	return { find };
}
//#endregion
//#region src/memory.ts
const SKIP_SCAN = {
	".git": 1,
	node_modules: 1,
	dist: 1,
	build: 1,
	out: 1,
	".next": 1,
	".cache": 1,
	coverage: 1,
	".venv": 1,
	venv: 1,
	__pycache__: 1,
	".idea": 1,
	".vscode": 1
};
/** 每个记忆家族要收集的文件名（前者在家族内更优先）。 */
const CLAUDE_FILES = ["CLAUDE.md", "CLAUDE.local.md"];
const DSH_FILES = ["DSH.md", "DSH.local.md"];
function createMemoryLoader(ctx) {
	const fs = ctx.get("fs");
	async function statPath(path) {
		try {
			const target = await fs.resolve(path);
			const info = await fs.stat(target);
			return info ? {
				target,
				info
			} : void 0;
		} catch {
			return;
		}
	}
	async function readText(path) {
		const s = await statPath(path);
		if (!s || s.info.type !== "file") return void 0;
		try {
			return await fs.readText(s.target);
		} catch {
			return;
		}
	}
	async function listDir(path) {
		try {
			const s = await statPath(path);
			if (!s || s.info.type !== "directory") return [];
			return await fs.listDir(s.target);
		} catch {
			return [];
		}
	}
	function dirOf(path) {
		const i = path.replace(/\\/g, "/").lastIndexOf("/");
		return i === -1 ? "." : path.slice(0, i);
	}
	function resolveImport(ref, fileDir, opts) {
		if (ref.startsWith("@~/")) return opts.homeDir ? `${opts.homeDir}/${ref.slice(3)}` : void 0;
		if (ref.startsWith("@/")) return opts.workspaceRoot ? `${opts.workspaceRoot}/${ref.slice(2)}` : void 0;
		return `${fileDir}/${ref}`;
	}
	async function expandImports(content, fileDir, opts, depth, seen) {
		if (depth > opts.maxImportDepth) return content;
		const lines = content.split(/\r?\n/);
		const out = [];
		for (const line of lines) {
			const m = line.match(/^\s*@(\S+)/);
			if (!m) {
				out.push(line);
				continue;
			}
			const resolved = resolveImport(m[1], fileDir, opts);
			if (!resolved || seen.has(resolved)) {
				out.push(line);
				continue;
			}
			seen.add(resolved);
			const imported = await readText(resolved);
			if (imported === void 0) {
				out.push(line);
				continue;
			}
			const expanded = await expandImports(imported, dirOf(resolved), opts, depth + 1, seen);
			out.push(`<!-- imported: ${resolved} -->\n${expanded}`);
		}
		return out.join("\n");
	}
	/**
	* 收集「根目录」某一记忆家族的文件全文（含 @import 内联）。
	* 根目录 = 会话 cwd（workspaceRoot）；CC 的 project/local 记忆就在这一层。
	* 子目录记忆不在这里内联，由 collectSubdirIndex 只列路径按需读取。
	*/
	async function collectRootFiles(dirPath, files, acc, opts, seen) {
		for (const fileName of files) {
			const fullPath = `${dirPath}/${fileName}`;
			const raw = await readText(fullPath);
			if (raw === void 0) continue;
			const content = await expandImports(raw, dirPath, opts, 0, seen);
			acc.push({
				path: fullPath,
				content
			});
		}
	}
	/**
	* 有界扫描子目录，只收集记忆文件路径（不读全文），供模型进入该子树时用
	* read 工具按需读取。这样既保留「子目录记忆」的可发现性，又不把几十个文件
	* 的全文一次性塞进上下文（token/成本负面最小化）。
	*/
	async function collectSubdirIndex(dirPath, depth, files, acc, opts, seen) {
		if (depth > opts.maxSubdirDepth || acc.length >= opts.maxSubdirIndex) return;
		for (const e of await listDir(dirPath)) {
			if (acc.length >= opts.maxSubdirIndex) return;
			if (e.type !== "directory" || SKIP_SCAN[e.name]) continue;
			const sub = `${dirPath}/${e.name}`;
			for (const fileName of files) {
				if (acc.length >= opts.maxSubdirIndex) return;
				const fullPath = `${sub}/${fileName}`;
				if (seen.has(fullPath)) continue;
				const s = await statPath(fullPath);
				if (s && s.info.type === "file") {
					seen.add(fullPath);
					acc.push(fullPath);
				}
			}
			await collectSubdirIndex(sub, depth + 1, files, acc, opts, seen);
		}
	}
	/** 收集记忆文件（CLAUDE 家族 → DSH 家族，后加载者优先）并渲染。 */
	async function load(workspaceRoot) {
		if (!fs) return "";
		const opts = {
			workspaceRoot,
			homeDir: void 0,
			maxImportDepth: 4,
			maxSubdirDepth: 4,
			maxSubdirIndex: 64
		};
		opts.homeDir = await createHomeFinder(ctx).find([".claude", ".dsh"]);
		const rootAcc = [];
		const importSeen = /* @__PURE__ */ new Set();
		if (opts.homeDir) {
			const p = `${opts.homeDir}/.claude/CLAUDE.md`;
			const raw = await readText(p);
			if (raw !== void 0) rootAcc.push({
				path: p,
				content: await expandImports(raw, `${opts.homeDir}/.claude`, opts, 0, importSeen)
			});
		}
		if (opts.workspaceRoot) await collectRootFiles(opts.workspaceRoot, CLAUDE_FILES, rootAcc, opts, importSeen);
		if (opts.homeDir) {
			const p = `${opts.homeDir}/.dsh/DSH.md`;
			const raw = await readText(p);
			if (raw !== void 0) rootAcc.push({
				path: p,
				content: await expandImports(raw, `${opts.homeDir}/.dsh`, opts, 0, importSeen)
			});
		}
		if (opts.workspaceRoot) await collectRootFiles(opts.workspaceRoot, DSH_FILES, rootAcc, opts, importSeen);
		const subdirIndex = [];
		const indexSeen = /* @__PURE__ */ new Set();
		if (opts.workspaceRoot) {
			await collectSubdirIndex(opts.workspaceRoot, 0, CLAUDE_FILES, subdirIndex, opts, indexSeen);
			await collectSubdirIndex(opts.workspaceRoot, 0, DSH_FILES, subdirIndex, opts, indexSeen);
		}
		if (!rootAcc.length && !subdirIndex.length) return "";
		const blocks = rootAcc.map((f) => `## ${f.path}\n${f.content}`);
		if (subdirIndex.length) blocks.push("## Subdirectory memory (not preloaded — read on demand)\nThese files live in subdirectories and are NOT inlined to keep the context lean. When working inside a listed directory, read the matching file with the read tool first:\n" + subdirIndex.map((p) => `- ${p}`).join("\n"));
		return `<imported_claude_memory>\n${blocks.join("\n\n")}\n</imported_claude_memory>`;
	}
	return { load };
}
//#endregion
//#region src/ui-lang.ts
let current = "en";
/** 浏览器语言（如 navigator.language 的 'zh-CN' / 'en-US'）归一化为 UiLang。 */
function normalizeUiLang(lang) {
	return lang && /^zh/i.test(lang) ? "zh" : "en";
}
function getUiLang() {
	return current;
}
function setUiLang(lang) {
	current = normalizeUiLang(lang);
	return current;
}
//#endregion
//#region src/init.ts
/** 可选语言：label 同时是选项标签与答案值。 */
const LANGS = {
	中文: {
		instruction: "使用中文撰写文档内容（代码、命令、路径等原文保留）。",
		prefix: "# DSH.md\n\n本文件是 DeepSeek Harness（DSH）的项目记忆文件，会话组装时由 cc-import 加载到模型上下文。"
	},
	English: {
		instruction: "Write the document in English.",
		prefix: "# DSH.md\n\nThis file is the project memory file of DeepSeek Harness (DSH), loaded into the model context by cc-import during session assembly."
	}
};
const DEFAULT_LANG = "English";
/** /init 的 UI 文案（提问 + 结果消息），按浏览器语言选择。 */
const UI = {
	en: {
		question: "Please choose the language for the generated DSH.md:",
		noCwd: "Cannot determine the current workspace (session has no cwd), cannot run /init.",
		cancelled: "/init cancelled.",
		agentUnavailable: "The current session agent is unavailable; cannot submit the /init analysis task.",
		submitted: (lang, path) => `Submitted /init analysis task (language: ${lang}). The model will explore the codebase and generate: ${path}`,
		submitFailed: (msg) => `Failed to submit /init analysis task: ${msg}`
	},
	zh: {
		question: "请选择生成的 DSH.md 使用哪种语言：",
		noCwd: "无法确定当前工作区（session 无 cwd），无法执行 /init。",
		cancelled: "/init 已取消。",
		agentUnavailable: "当前会话的 agent 不可用，无法提交 /init 分析任务。",
		submitted: (lang, path) => `已提交 /init 分析任务（语言：${lang}）。模型将探索代码库并生成：${path}`,
		submitFailed: (msg) => `提交 /init 分析任务失败：${msg}`
	}
};
/** 组装 /init 提示词（参考 Claude Code /init 生成的 user prompt）。 */
function buildPrompt(lang, workspace) {
	const meta = LANGS[lang] ?? LANGS[DEFAULT_LANG];
	return [
		"Please analyze this codebase and create a DSH.md file, which will be given to future instances of DeepSeek Harness agents to operate in this repository.",
		"",
		`Workspace: ${workspace}`,
		`Language preference: ${lang} — ${meta.instruction}`,
		"",
		"What to add:",
		"1. Commands that will be commonly used, such as how to build, lint, and run tests. Include the necessary commands to develop in this codebase, such as how to run a single test.",
		"2. High-level code architecture and structure so that future instances can be productive more quickly. Focus on the \"big picture\" architecture that requires reading multiple files to understand.",
		"",
		"Usage notes:",
		"- If there's already a DSH.md, suggest improvements to it.",
		"- When you make the initial DSH.md, do not repeat yourself and do not include obvious instructions like \"Provide helpful error messages to users\", \"Write unit tests for all new utilities\", \"Never include sensitive information (API keys, tokens) in code or commits\".",
		"- Avoid listing every component or file structure that can be easily discovered.",
		"- Don't include generic development practices.",
		"- If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), make sure to include the important parts.",
		"- If there is a README.md, make sure to include the important parts.",
		"- Do not make up information such as \"Common Development Tasks\", \"Tips for Development\", \"Support and Documentation\" unless this is expressly included in other files that you read.",
		"- Be sure to prefix the file with the following text:",
		"",
		"```",
		meta.prefix,
		"```"
	].join("\n");
}
/** 注册 `/init` 斜杠命令（host 半；客户端输入框经 commands Remote 自动发现）。 */
function registerInitCommand(ctx) {
	const commands = ctx.get("commands");
	if (!commands || typeof commands.register !== "function") return;
	ctx.effect(() => commands.register({
		name: "init",
		description: "Analyze the codebase and generate a DSH.md project memory file (pick the document language first)",
		async handler(invocation) {
			const ui = UI[getUiLang()];
			const agent = invocation?.agent;
			const cwd = agent?.session?.header?.cwd;
			if (typeof cwd !== "string" || !cwd) return {
				kind: "error",
				text: ui.noCwd
			};
			let lang = DEFAULT_LANG;
			const uq = ctx.get("userQuestions");
			if (uq && typeof uq.ask === "function") try {
				const picked = ((await uq.ask({
					agent,
					signal: invocation?.signal,
					questions: [{
						id: "lang",
						header: "/init",
						question: ui.question,
						options: Object.keys(LANGS).map((label) => ({ label }))
					}]
				}))?.answers || []).find((a) => a.id === "lang")?.selected?.[0];
				if (typeof picked === "string" && LANGS[picked]) lang = picked;
			} catch (e) {
				if (invocation?.signal?.aborted) return {
					kind: "error",
					text: ui.cancelled
				};
			}
			try {
				const prompt = buildPrompt(lang, cwd);
				const message = createUserMessage({
					content: [{
						type: "text",
						text: prompt
					}],
					source: { kind: "user" }
				});
				if (typeof agent?.followup !== "function") return {
					kind: "error",
					text: ui.agentUnavailable
				};
				agent.followup(message);
				return {
					kind: "success",
					text: ui.submitted(lang, `${cwd}\\DSH.md`)
				};
			} catch (e) {
				return {
					kind: "error",
					text: ui.submitFailed(e?.message || String(e))
				};
			}
		}
	}));
}
//#endregion
//#region src/import/claude-code.ts
/**
* 按 sessionId 匹配会话：精确匹配优先（fileName / relPath / 去 .jsonl 的
* fileName），再放宽到 fileName 前缀与 relPath 尾缀（CC id 前缀用法）。
* 不做宽松子串匹配，避免 sessionId 命中无关路径。
*/
function matchSession(sessions, sessionId) {
	const sid = (sessionId || "").trim();
	if (!sid) return void 0;
	const byFile = sessions.find((s) => s.fileName === sid);
	if (byFile) return byFile;
	const byRel = sessions.find((s) => s.relPath === sid);
	if (byRel) return byRel;
	const byBase = sessions.find((s) => s.fileName.replace(/\.jsonl$/, "") === sid);
	if (byBase) return byBase;
	const byPrefix = sessions.find((s) => s.fileName.startsWith(sid) && s.fileName.length > sid.length);
	if (byPrefix) return byPrefix;
	const bySuffix = sessions.find((s) => s.relPath.endsWith(`/${sid}.jsonl`));
	if (bySuffix) return bySuffix;
}
function createClaudeCodeProvider(ctx) {
	const fs = ctx.get("fs");
	const sp = ctx.get("sessionPersistence");
	async function statPath(path) {
		try {
			const target = await fs.resolve(path);
			const info = await fs.stat(target);
			return info ? {
				target,
				info
			} : void 0;
		} catch {
			return;
		}
	}
	async function readText(path) {
		const s = await statPath(path);
		if (!s || s.info.type !== "file") return void 0;
		try {
			return await fs.readText(s.target);
		} catch {
			return;
		}
	}
	async function listDir(path) {
		try {
			const s = await statPath(path);
			if (!s || s.info.type !== "directory") return [];
			return await fs.listDir(s.target);
		} catch {
			return [];
		}
	}
	async function discoverHome() {
		const home = await createHomeFinder(ctx).find([".claude"]);
		return home ? `${home}/.claude` : void 0;
	}
	async function readHead(target, maxBytes = 16384) {
		try {
			const stream = await fs.streamText(target);
			let text = "";
			for await (const chunk of stream) {
				text += chunk;
				if (text.length >= maxBytes) break;
			}
			return text.slice(0, maxBytes);
		} catch {
			return "";
		}
	}
	function extractHeadInfo(text) {
		let title;
		let cwd;
		let createdAt;
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			let rec;
			try {
				rec = JSON.parse(line);
			} catch {
				continue;
			}
			if (!rec || typeof rec !== "object") continue;
			if (cwd === void 0 && typeof rec.cwd === "string") cwd = rec.cwd;
			if (createdAt === void 0 && typeof rec.timestamp === "string") {
				const t = Date.parse(rec.timestamp);
				if (!Number.isNaN(t)) createdAt = t;
			}
			if (title === void 0 && rec.isMeta !== true) {
				if (rec.type === "ai-title" && typeof rec.aiTitle === "string") title = rec.aiTitle.trim();
				else if (rec.type === "user") {
					const content = rec.message && typeof rec.message === "object" ? rec.message.content : void 0;
					const realText = (t) => t.trim() && !t.trimStart().startsWith("<") ? t.trim().slice(0, 200) : void 0;
					if (typeof content === "string") {
						const t = realText(content);
						if (t) title = t;
					} else if (Array.isArray(content)) {
						for (const b of content) if (b && b.type === "text" && typeof b.text === "string") {
							const t = realText(b.text);
							if (t) {
								title = t;
								break;
							}
						}
					}
				}
			}
			if (title !== void 0 && cwd !== void 0 && createdAt !== void 0) break;
		}
		return {
			title,
			cwd,
			createdAt
		};
	}
	async function scanSessions(root) {
		const out = [];
		async function walk(dir, rel, depth) {
			if (depth > 5 || out.length >= 500) return;
			for (const e of await listDir(dir)) {
				if (out.length >= 500) return;
				if (e.type === "directory") await walk(`${dir}/${e.name}`, `${rel}/${e.name}`, depth + 1);
				else if (e.type === "file" && typeof e.name === "string" && e.name.endsWith(".jsonl")) {
					const info = extractHeadInfo(await readHead(e.target));
					out.push({
						provider: "claude-code",
						fileName: e.name,
						relPath: `${rel}/${e.name}`.replace(/^\/+/, ""),
						projectDir: rel.replace(/^\/+/, "") || ".",
						size: typeof e.size === "number" ? Math.floor(e.size) : 0,
						...info.title !== void 0 ? { title: info.title } : {},
						...info.cwd !== void 0 ? { cwd: info.cwd } : {},
						...info.createdAt !== void 0 ? { createdAt: info.createdAt } : {}
					});
				}
			}
		}
		await walk(`${root}/projects`, "", 0);
		return out;
	}
	function contentBlocks(content) {
		if (typeof content === "string") return content.trim() ? [{
			kind: "text",
			text: content
		}] : [];
		if (!Array.isArray(content)) return [];
		const out = [];
		for (const b of content) {
			if (typeof b === "string") {
				if (b.trim()) out.push({
					kind: "text",
					text: b
				});
				continue;
			}
			if (!b || typeof b !== "object") continue;
			if (b.type === "text") out.push({
				kind: "text",
				text: typeof b.text === "string" ? b.text : ""
			});
			else if (b.type === "thinking") out.push({
				kind: "reasoning",
				text: typeof b.thinking === "string" ? b.thinking : ""
			});
			else if (b.type === "image") {
				const mt = typeof b.source?.media_type === "string" ? b.source.media_type : "image";
				out.push({
					kind: "text",
					text: `[image: ${mt}]`
				});
			} else if (b.type === "tool_use") out.push({
				kind: "tool_use",
				id: b.id,
				name: typeof b.name === "string" ? b.name : "tool",
				input: b.input
			});
			else if (b.type === "tool_result") {
				let text = "";
				if (typeof b.content === "string") text = b.content;
				else if (Array.isArray(b.content)) text = b.content.map((x) => typeof x === "string" ? x : x && typeof x.text === "string" ? x.text : "").join("\n");
				out.push({
					kind: "tool_result",
					id: b.tool_use_id,
					text,
					isError: b.is_error === true
				});
			}
		}
		return out;
	}
	function toMs(ts, fallback) {
		if (typeof ts === "string") {
			const t = Date.parse(ts);
			if (!Number.isNaN(t)) return t;
		}
		return fallback;
	}
	/** Recursively drop undefined-valued keys so event data is lossless JSON. */
	function clean(v) {
		if (Array.isArray(v)) return v.map(clean);
		if (v && typeof v === "object") {
			const out = {};
			for (const k of Object.keys(v)) {
				const val = v[k];
				if (val !== void 0) out[k] = clean(val);
			}
			return out;
		}
		return v;
	}
	function parseRecords(text) {
		const records = [];
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			let rec;
			try {
				rec = JSON.parse(line);
			} catch {
				continue;
			}
			if (!rec || typeof rec !== "object") continue;
			const type = rec.type;
			if (type !== "user" && type !== "assistant") continue;
			const message = rec.message && typeof rec.message === "object" ? rec.message : {};
			const role = type === "user" ? "user" : "assistant";
			const blocks = contentBlocks(message.content);
			if (!blocks.length) continue;
			records.push({
				role,
				blocks,
				time: toMs(rec.timestamp, 0),
				model: message.model,
				usage: message.usage ? {
					inputTokens: message.usage.input_tokens || 0,
					outputTokens: message.usage.output_tokens || 0
				} : void 0,
				cwd: rec.cwd
			});
		}
		return records;
	}
	/** Synthesize a balanced DSH event log from parsed CC records. */
	function synthesize(records, createdAt) {
		const events = [];
		let seq = 0;
		function emit(type, data, time, surface = false) {
			const ev = {
				type,
				seq: seq++,
				time: typeof time === "number" && time > 0 ? time : createdAt + seq,
				data: clean(data)
			};
			if (surface) ev.surfaceOp = "append";
			events.push(ev);
		}
		let turn = 0;
		let step = 0;
		let stepOpen = false;
		let turnOpen = false;
		function openStep(t) {
			step++;
			stepOpen = true;
			emit("step/start", {
				turn,
				step
			}, t);
		}
		function closeStep(t) {
			if (stepOpen) {
				stepOpen = false;
				emit("step/end", {
					turn,
					step
				}, t);
			}
		}
		function closeTurn(t) {
			closeStep(t);
			if (turnOpen) {
				turnOpen = false;
				emit("turn/end", {
					turn,
					reason: { kind: "success" }
				}, t);
			}
		}
		for (let i = 0; i < records.length; i++) {
			const r = records[i];
			const t = r.time;
			if (r.role === "user") {
				if (r.blocks.some((b) => b.kind === "tool_result")) {
					for (const b of r.blocks) {
						if (b.kind !== "tool_result") continue;
						const trBlock = {
							type: "tool-result",
							toolCallId: b.id || "unknown",
							content: [{
								type: "text",
								text: b.text ?? ""
							}]
						};
						if (b.isError) trBlock.isError = true;
						const data = {
							turn,
							step,
							message: {
								id: `ccmsg-${seq + 1e3}`,
								role: "user",
								content: [trBlock],
								source: {
									kind: "tool",
									callId: b.id || "unknown"
								}
							}
						};
						if (b.isError) data.error = {
							name: "Error",
							code: "TOOL_ERROR"
						};
						emit("tool/result", data, t, true);
					}
					closeStep(t);
					continue;
				}
				closeTurn(t);
				turn++;
				step = 0;
				turnOpen = true;
				emit("turn/start", { turn }, t);
				const textBlocks = r.blocks.filter((b) => b.kind === "text");
				emit("user/message", {
					id: `ccmsg-${seq + 1e3}`,
					role: "user",
					content: textBlocks.length ? textBlocks.map((b) => ({
						type: "text",
						text: b.text ?? ""
					})) : [{
						type: "text",
						text: ""
					}],
					source: { kind: "user" }
				}, t, true);
				openStep(t);
			} else {
				if (!stepOpen) openStep(t);
				let end = i;
				while (end + 1 < records.length && records[end + 1].role === "assistant") end++;
				const content = [];
				const toolUses = [];
				let model;
				let usage;
				for (let k = i; k <= end; k++) {
					for (const b of records[k].blocks) if (b.kind === "text") content.push({
						type: "text",
						text: b.text ?? ""
					});
					else if (b.kind === "reasoning") content.push({
						type: "reasoning",
						text: b.text ?? ""
					});
					else if (b.kind === "tool_use") {
						let args = "{}";
						try {
							args = JSON.stringify(b.input);
						} catch {
							args = "{}";
						}
						const id = b.id || `call-${seq}`;
						content.push({
							type: "tool-call",
							id,
							name: b.name ?? "tool",
							arguments: args
						});
						toolUses.push({
							id,
							name: b.name ?? "tool",
							args
						});
					}
					if (records[k].model) model = records[k].model;
					if (records[k].usage) usage = records[k].usage;
				}
				i = end;
				const data = {
					turn,
					step,
					message: {
						id: `ccmsg-${seq + 1e3}`,
						role: "assistant",
						content,
						source: {
							kind: "model",
							provider: "claude-code",
							model: model || "unknown"
						}
					}
				};
				if (usage) data.usage = usage;
				emit("assistant/message", data, t, true);
				for (const tu of toolUses) emit("tool/call", {
					turn,
					step,
					callId: tu.id,
					name: tu.name,
					arguments: tu.args
				}, t);
				if (toolUses.length === 0) {
					closeStep(t);
					closeTurn(t);
				}
			}
		}
		closeTurn(createdAt);
		return events;
	}
	function recordsToMarkdown(records) {
		const parts = [];
		for (const r of records) {
			const role = r.role === "user" ? "User" : "Assistant";
			const body = [];
			for (const b of r.blocks) if (b.kind === "text" && b.text) body.push(b.text);
			else if (b.kind === "reasoning") body.push(`<thinking>\n${b.text}\n</thinking>`);
			else if (b.kind === "tool_use") {
				let input = "";
				try {
					input = JSON.stringify(b.input);
				} catch {
					input = String(b.input);
				}
				body.push(`[tool_use: ${b.name ?? "tool"}]${input && input !== "{}" ? `\n${input}` : ""}`);
			} else if (b.kind === "tool_result") body.push(`[tool_result${b.isError ? " (error)" : ""}]\n${b.text ?? ""}`);
			parts.push(`### ${role}\n${body.filter(Boolean).join("\n")}`);
		}
		return parts.join("\n\n");
	}
	async function findSession(root, sessionId) {
		return matchSession((await scanSessions(root)).filter((s) => !s.relPath.includes("/subagents/")), sessionId);
	}
	return {
		id: "claude-code",
		displayName: "Claude Code",
		icon: "🅒",
		discoverDataRoot: () => discoverHome(),
		listSessions: async (cwd) => {
			const root = await discoverHome();
			if (!root) return [];
			const all = (await scanSessions(root)).filter((s) => !s.relPath.includes("/subagents/"));
			if (!cwd) return all;
			const norm = (p) => p.replace(/[\\/]/g, "\\").toLowerCase();
			const target = norm(cwd);
			return all.filter((s) => s.cwd !== void 0 && norm(s.cwd) === target);
		},
		previewSession: async (sessionId) => {
			if (!fs) return { markdown: "filesystem service unavailable" };
			const root = await discoverHome();
			if (!root) return { markdown: "No ~/.claude directory found" };
			const match = await findSession(root, sessionId);
			if (!match) return { markdown: `Session not found: ${sessionId}` };
			const raw = await readText(`${root}/projects/${match.relPath}`);
			if (raw === void 0) return { markdown: `Cannot read ${match.relPath}` };
			return { markdown: recordsToMarkdown(parseRecords(raw)) };
		},
		importSession: async (sessionId, cwd) => {
			const empty = {
				sessionId,
				eventCount: 0,
				listed: false
			};
			if (!fs || !sp) return {
				...empty,
				error: "fs or sessionPersistence service is unavailable"
			};
			const root = await discoverHome();
			if (!root) return {
				...empty,
				error: "No ~/.claude directory found"
			};
			const all = await scanSessions(root);
			const match = matchSession(all.filter((s) => !s.relPath.includes("/subagents/")), sessionId);
			if (!match) return {
				...empty,
				error: `Session not found: ${sessionId}`
			};
			/** 把会话附加到目标工作区（workspaceRegistry 归属）。 */
			async function attachToWorkspace(dshId, cwd) {
				if (!cwd) return {};
				try {
					const wsr = ctx.get("workspaceRegistry");
					if (wsr && typeof wsr.create === "function") {
						const ws = await wsr.create(cwd);
						if (ws && typeof ws.attachSession === "function") await ws.attachSession(dshId);
					}
				} catch (e) {
					return { attachError: e?.message || String(e) };
				}
				return {};
			}
			/**
			* 读取 DSH 的全局归档集合（workspaceRegistry.archivedSessionIds）。
			* DSH 归档只是把会话 id 记入该集合并从侧边栏视图隐藏，持久化日志
			* 与 sessionPersistence 都保留——所以仅靠 sp.list() 无法区分"活跃"与
			* "已归档"，必须查这个集合。registry 不可用时视为无归档。
			*/
			async function archivedIds() {
				try {
					const ids = ctx.get("workspaceRegistry")?.archivedSessionIds;
					if (Array.isArray(ids)) return new Set(ids);
				} catch {}
				return /* @__PURE__ */ new Set();
			}
			/** 为重新导入分配一个未被占用（含归档集）的 `-reimport-N` id。 */
			function nextFreeId(base, taken, archived) {
				let n = 1;
				for (;;) {
					const candidate = `${base}-reimport-${n}`;
					if (!taken.has(candidate) && !archived.has(candidate)) return candidate;
					n++;
				}
			}
			/**
			* 该源当前"最新"的会话 id：base 或编号最大的 `-reimport-N` 中已存在的那个。
			* 幂等/归档重导的决策必须基于最新会话，而不是基础 id——
			* 否则原会话被归档后，`taken.has(base)` 与 `archived.has(base)` 恒成立，
			* 每次导入都会走重新导入分支，导致无限创建 `-reimport-N`（即使最新会话仍活跃）。
			*/
			function latestSessionId(base, taken) {
				if (!taken.has(base)) return base;
				let latest = base;
				for (let n = 1;; n++) {
					const candidate = `${base}-reimport-${n}`;
					if (!taken.has(candidate)) break;
					latest = candidate;
				}
				return latest;
			}
			async function importOne(m, preferredId, extraMeta, cwdOverride, attach = false, archived = /* @__PURE__ */ new Set()) {
				let dshId = preferredId;
				let reimported = false;
				try {
					const list = await sp.list();
					const taken = new Set(list.map((h) => h.id));
					const latest = latestSessionId(preferredId, taken);
					if (taken.has(latest)) {
						if (archived.has(latest)) {
							dshId = nextFreeId(preferredId, taken, archived);
							reimported = true;
						} else {
							const result = {
								sessionId: latest,
								eventCount: 0,
								listed: true,
								reimported: false
							};
							if (attach) {
								const att = await attachToWorkspace(latest, cwdOverride);
								if (att.attachError) result.attachError = att.attachError;
							}
							return result;
						}
					}
				} catch {}
				const raw = await readText(`${root}/projects/${m.relPath}`);
				if (raw === void 0) return {
					sessionId: dshId,
					eventCount: 0,
					listed: false,
					error: `Cannot read ${m.relPath}`
				};
				const records = parseRecords(raw);
				if (!records.length) return {
					sessionId: dshId,
					eventCount: 0,
					listed: false,
					error: "No parseable user/assistant records"
				};
				const createdAt = records[0].time || Date.now();
				const cwd = cwdOverride ?? records.find((r) => r.cwd)?.cwd;
				const meta = {
					version: 0,
					id: dshId,
					createdAt,
					...cwd ? { cwd } : {},
					...extraMeta
				};
				const events = synthesize(records, createdAt);
				try {
					await sp.create(meta);
					await sp.append(dshId, events);
				} catch (e) {
					return {
						sessionId: dshId,
						eventCount: events.length,
						listed: false,
						error: `write failed: ${e?.message || e}`
					};
				}
				let listed = false;
				try {
					listed = (await sp.list()).some((h) => h.id === dshId);
				} catch {}
				let inspectError;
				try {
					await sp.inspect(dshId);
				} catch (e) {
					inspectError = e?.message || String(e);
				}
				const result = {
					sessionId: dshId,
					eventCount: events.length,
					listed,
					reimported,
					...inspectError !== void 0 ? { inspectError } : {}
				};
				if (attach) {
					const att = await attachToWorkspace(dshId, cwd);
					if (att.attachError) result.attachError = att.attachError;
				}
				return result;
			}
			const archived = await archivedIds();
			const mainResult = await importOne(match, `cc-${match.fileName.replace(/\.jsonl$/, "")}`, {}, cwd, true, archived);
			const mainId = mainResult.sessionId;
			const mainBase = mainId.replace(/^cc-/, "");
			const subPrefix = `${match.fileName.replace(/\.jsonl$/, "")}/subagents/`;
			const subagents = all.filter((s) => s.relPath.startsWith(subPrefix));
			let subagentCount = 0;
			for (const sub of subagents) {
				const r = await importOne(sub, `cc-${mainBase}-subagent-${sub.fileName.replace(/\.jsonl$/, "")}`, {
					parentSession: mainId,
					delegationDepth: 1,
					origin: "subagent"
				}, cwd, false, archived);
				if (!r.error && r.listed) subagentCount++;
			}
			return {
				...mainResult,
				subagentCount
			};
		}
	};
}
//#endregion
//#region src/rpc.ts
/** 请求体大小上限（导入请求体只有 sessionId/cwd/provider，1 MiB 足够防御异常请求）。 */
const MAX_BODY_BYTES = 1048576;
function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(body);
}
function readBody(req, maxBytes = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		let data = "";
		let overflow = false;
		req.on("data", (c) => {
			if (overflow) return;
			data += c;
			if (data.length > maxBytes) {
				overflow = true;
				req.pause();
				reject(Object.assign(/* @__PURE__ */ new Error("request body too large"), { statusCode: 413 }));
			}
		});
		req.on("end", () => {
			if (!overflow) resolve(data);
		});
		req.on("error", reject);
	});
}
/** 选 provider：显式 id 优先，缺省取第一个注册的 provider。 */
function pickProvider(providers, id) {
	if (id) return providers.find((p) => p.id === id);
	return providers[0];
}
function registerRpcRoutes(ctx, providers) {
	const webServer = ctx.webServer;
	if (!webServer) {
		console.error("[ccimport] webServer service unavailable — HTTP RPC routes not registered");
		return;
	}
	ctx.effect(() => webServer.register({
		kind: "prefix",
		path: "/api/cc-import",
		handler: async (req, res) => {
			const url = new URL(req.url || "/", "http://localhost");
			const path = url.pathname;
			try {
				if (path === "/api/cc-import/list") {
					const cwd = url.searchParams.get("cwd") || void 0;
					const sessions = [];
					for (const p of providers) sessions.push(...await p.listSessions(cwd));
					sendJson(res, 200, { sessions });
					return;
				}
				if (path === "/api/cc-import/preview") {
					const provider = pickProvider(providers, url.searchParams.get("provider") || void 0);
					if (!provider) return sendJson(res, 503, { error: "no import provider registered" });
					const sessionId = url.searchParams.get("sessionId") || "";
					sendJson(res, 200, await provider.previewSession(sessionId));
					return;
				}
				if (path === "/api/cc-import/import" && req.method === "POST") {
					const body = JSON.parse(await readBody(req) || "{}");
					const provider = pickProvider(providers, typeof body.provider === "string" ? body.provider : void 0);
					if (!provider) return sendJson(res, 503, { error: "no import provider registered" });
					const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
					const cwd = typeof body.cwd === "string" ? body.cwd : void 0;
					const result = await provider.importSession(sessionId, cwd);
					sendJson(res, result.error ? 500 : 200, result);
					return;
				}
				if (path === "/api/cc-import/lang") {
					if (req.method === "POST") {
						const body = JSON.parse(await readBody(req) || "{}");
						setUiLang(typeof body.lang === "string" ? body.lang : void 0);
					}
					sendJson(res, 200, { lang: getUiLang() });
					return;
				}
				sendJson(res, 404, { error: "not found" });
			} catch (e) {
				sendJson(res, e?.statusCode || 500, { error: e?.message || String(e) });
			}
		}
	}));
}
//#endregion
//#region src/index.ts
const name = "cc-import";
const inject = [
	"systemPrompt",
	"sandboxPolicy",
	"tools",
	"webServer"
];
const MEMORY_CONTEXT_ORDER = 50;
function apply(ctx) {
	const agents = ctx.get("agents");
	const fallbackRoot = ctx.sandboxPolicy.workspaceRoot;
	const memoryLoader = createMemoryLoader(ctx);
	const memoryCache = /* @__PURE__ */ new Map();
	const MEMORY_CACHE_MAX = 64;
	const loading = /* @__PURE__ */ new Set();
	function trimMemoryCache() {
		while (memoryCache.size > MEMORY_CACHE_MAX) {
			const oldest = memoryCache.keys().next().value;
			if (oldest === void 0) break;
			memoryCache.delete(oldest);
		}
	}
	function memoryFor(cwd) {
		const hit = memoryCache.get(cwd);
		if (hit !== void 0) {
			memoryCache.delete(cwd);
			memoryCache.set(cwd, hit);
			return hit;
		}
		if (!loading.has(cwd)) {
			loading.add(cwd);
			memoryLoader.load(cwd).then((t) => {
				memoryCache.set(cwd, t);
				trimMemoryCache();
			}).catch(() => {
				memoryCache.set(cwd, "");
				trimMemoryCache();
			}).finally(() => {
				loading.delete(cwd);
			});
		}
		return "";
	}
	ctx.systemPrompt.context({
		name: "cc-import:memory",
		order: MEMORY_CONTEXT_ORDER,
		text: (assembleCtx) => {
			const cwd = assembleCtx?.scope?.session?.header?.cwd ?? (typeof agents?.currentInitiator === "function" ? agents.currentInitiator()?.session?.header?.cwd : void 0) ?? fallbackRoot;
			return cwd ? memoryFor(cwd) : "";
		}
	});
	const providers = [createClaudeCodeProvider(ctx)];
	registerInitCommand(ctx);
	registerRpcRoutes(ctx, providers);
	const listTool = defineTool({
		name: "cc_history_list",
		description: "List Claude Code conversation sessions available under ~/.claude/projects (read-only).",
		parameters: {
			limit: {
				type: "integer",
				description: "Maximum sessions to return (default 100)."
			},
			filter: {
				type: "string",
				description: "Optional case-insensitive substring filter."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: { type: "integer" },
					truncated: { type: "boolean" },
					sessions: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								provider: { type: "string" },
								fileName: { type: "string" },
								relPath: { type: "string" },
								projectDir: { type: "string" },
								size: { type: "integer" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const lines = [`Claude Code sessions (${value.count} shown):`];
				for (const s of value.sessions) lines.push(`- ${s.relPath}${s.size ? ` (${s.size} bytes)` : ""}`);
				if (value.truncated) lines.push("(more available — raise `limit` or use `filter`)");
				if (value.count === 0) lines.push("No sessions found. Check that ~/.claude/projects exists.");
				lines.push("Import one with cc_import using its fileName or relPath.");
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		async execute(args) {
			const all = [];
			for (const p of providers) all.push(...await p.listSessions());
			let sessions = all;
			if (args && typeof args.filter === "string" && args.filter.trim()) {
				const f = args.filter.trim().toLowerCase();
				sessions = sessions.filter((s) => `${s.projectDir} ${s.fileName} ${s.relPath}`.toLowerCase().includes(f));
			}
			let limit = 100;
			if (args && typeof args.limit === "number" && args.limit > 0) limit = Math.floor(args.limit);
			const truncated = sessions.length > limit;
			return {
				count: Math.min(sessions.length, limit),
				truncated,
				sessions: sessions.slice(0, limit)
			};
		}
	});
	ctx.tools.register(listTool);
	const importTool = defineTool({
		name: "cc_import",
		description: "Import one Claude Code conversation (.jsonl) as a resumable DSH session.",
		parameters: { sessionId: {
			type: "string",
			required: true,
			description: "Session file name or relPath from cc_history_list."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessionId: { type: "string" },
					eventCount: { type: "integer" },
					listed: { type: "boolean" },
					inspectError: { type: "string" },
					error: { type: "string" },
					subagentCount: { type: "integer" },
					reimported: { type: "boolean" }
				}
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: value.error ? `Import failed: ${value.error}` : `Imported ${value.sessionId} (${value.eventCount} events). listed=${value.listed}${value.reimported ? " [re-imported: prior session was archived]" : ""}${value.inspectError ? ` inspectError=${value.inspectError}` : " inspect=OK"}`
				}];
			}
		},
		async execute(args) {
			const sid = args && typeof args.sessionId === "string" ? args.sessionId.trim() : "";
			if (!sid) return {
				sessionId: "",
				eventCount: 0,
				listed: false,
				error: "sessionId is required"
			};
			return providers[0].importSession(sid);
		}
	});
	ctx.tools.register(importTool);
}
//#endregion
export { apply, inject, name };
