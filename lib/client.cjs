window.__ModuleLoader__.load({
  id: "cc-import",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let react = require("react");
react = __toESM(react, 1);
//#region src/client/index.ts
const STRINGS = {
	zh: {
		title: "导入 Claude Code 对话",
		footerTitle: "导入 Claude Code 对话",
		workspacePrefix: "工作区：",
		noWorkspace: "未检测到当前工作区（显示全部）",
		loading: "加载中…",
		selectAll: (sel, total) => `全选（${sel}/${total}）`,
		empty: "未找到 Claude Code 会话（检查 ~/.claude/projects）。",
		importSelected: (n) => `导入选中（${n}）`,
		importing: "导入中…",
		foldedSuffix: (n) => `(${n}字已折叠)`,
		subagentsSuffix: (n) => `，${n} 子代理`,
		attachErrorSuffix: (e) => `，附加失败：${e}`,
		reimportedSuffix: () => "，重新导入（原会话已归档）",
		okImport: (sessionId, eventCount, extra) => `✓ ${sessionId}（${eventCount} 事件${extra}）`,
		failImport: (file, error) => `✗ ${file}: ${error}`
	},
	en: {
		title: "Import Claude Code conversations",
		footerTitle: "Import Claude Code conversations",
		workspacePrefix: "Workspace: ",
		noWorkspace: "No workspace detected (showing all sessions)",
		loading: "Loading…",
		selectAll: (sel, total) => `Select all (${sel}/${total})`,
		empty: "No Claude Code sessions found (check ~/.claude/projects).",
		importSelected: (n) => `Import selected (${n})`,
		importing: "Importing…",
		foldedSuffix: (n) => `(${n} chars folded)`,
		subagentsSuffix: (n) => `, ${n} sub-agents`,
		attachErrorSuffix: (e) => `, attach failed: ${e}`,
		reimportedSuffix: () => ", re-imported (prior session was archived)",
		okImport: (sessionId, eventCount, extra) => `✓ ${sessionId} (${eventCount} events${extra})`,
		failImport: (file, error) => `✗ ${file}: ${error}`
	}
};
function detectLang() {
	try {
		const lang = typeof navigator !== "undefined" ? navigator.language || "" : "";
		return /^zh/i.test(lang) ? "zh" : "en";
	} catch {
		return "zh";
	}
}
function getStrings() {
	return STRINGS[detectLang()];
}
/** 把浏览器语言上报给 host（fire-and-forget；失败静默，host 默认英文）。 */
function reportBrowserLang() {
	try {
		const lang = typeof navigator !== "undefined" ? navigator.language || "" : "";
		fetch("/api/cc-import/lang", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ lang })
		}).catch(() => {});
	} catch {}
}
const OVERLAY_KEY = "__cc_import_overlay__";
function overlayStore() {
	const w = typeof window !== "undefined" ? window : {};
	if (!w[OVERLAY_KEY]) w[OVERLAY_KEY] = {
		open: false,
		listeners: /* @__PURE__ */ new Set()
	};
	return w[OVERLAY_KEY];
}
function setOpen(v) {
	const s = overlayStore();
	s.open = v;
	for (const l of s.listeners) l();
}
function useOpen() {
	const [v, setV] = react.useState(overlayStore().open);
	react.useEffect(() => {
		const s = overlayStore();
		const l = () => setV(s.open);
		s.listeners.add(l);
		return () => {
			s.listeners.delete(l);
		};
	}, []);
	return v;
}
const panelStyle = {
	position: "fixed",
	inset: 0,
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	background: "rgba(0,0,0,0.35)",
	pointerEvents: "auto",
	zIndex: 1e3
};
const dialogStyle = {
	width: 640,
	maxWidth: "92vw",
	maxHeight: "80vh",
	background: "var(--color-bg-elevated, #1e1e1e)",
	color: "var(--color-text, #e6e6e6)",
	borderRadius: 12,
	padding: 16,
	display: "flex",
	flexDirection: "column",
	gap: 12,
	overflow: "hidden"
};
const rowStyle = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	padding: "6px 8px",
	cursor: "pointer",
	borderRadius: 6
};
const monoStyle = {
	fontSize: 12,
	opacity: .7,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};
const resultStyle = {
	flex: "none",
	maxHeight: 160,
	overflow: "auto",
	background: "rgba(0,0,0,0.2)",
	borderRadius: 8,
	padding: 10,
	fontSize: 12,
	whiteSpace: "pre-wrap"
};
function FooterButton(props) {
	const t = getStrings();
	return react.createElement("button", {
		type: "button",
		title: t.footerTitle,
		onClick: () => setOpen(true),
		style: {
			display: "flex",
			alignItems: "center",
			gap: 6,
			cursor: "pointer"
		}
	}, react.createElement("span", null, "🅒"), props.wide ? t.footerTitle : null);
}
/**
* 会话标题行：超过 80 字时截断并追加灰色折叠后缀（文案随语言）。
*/
function TitleLine(props) {
	const t = getStrings();
	const text = (props.title || props.fallback).trim();
	if (text.length <= 80) return react.createElement("span", null, text);
	return react.createElement("span", null, text.slice(0, 80) + "…", react.createElement("span", { style: {
		color: "#9a9a9a",
		fontSize: 11,
		marginLeft: 4
	} }, t.foldedSuffix(text.length - 80)));
}
function ImportOverlay(props) {
	const t = getStrings();
	const open = useOpen();
	const [sessions, setSessions] = react.useState([]);
	const [loading, setLoading] = react.useState(false);
	const [error, setError] = react.useState("");
	const [selected, setSelected] = react.useState(/* @__PURE__ */ new Set());
	const [importing, setImporting] = react.useState(false);
	const [results, setResults] = react.useState([]);
	const wsPath = typeof props.useWorkspaces === "function" ? props.useWorkspaces((s) => {
		const ws = (s?.items || []).find((w) => w?.workspaceId === s?.recentWorkspaceId);
		return ws ? ws.path : "";
	}) : "";
	const cwd = (typeof props.useSessions === "function" ? props.useSessions((st) => {
		const info = st?.current !== void 0 ? st?.byId?.[st.current] : void 0;
		return info?.cwd ? String(info.cwd) : "";
	}) : "") || wsPath || void 0;
	react.useEffect(() => {
		if (!open) return;
		setLoading(true);
		setError("");
		setSelected(/* @__PURE__ */ new Set());
		setResults([]);
		const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
		fetch(`/api/cc-import/list${q}`).then((r) => r.json()).then((d) => setSessions(d.sessions || [])).catch((e) => setError(String(e))).finally(() => setLoading(false));
	}, [open, cwd]);
	function toggle(s) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(s.fileName)) next.delete(s.fileName);
			else next.add(s.fileName);
			return next;
		});
	}
	function toggleAll() {
		setSelected((prev) => {
			if (prev.size === sessions.length) return /* @__PURE__ */ new Set();
			return new Set(sessions.map((s) => s.fileName));
		});
	}
	async function importSelected() {
		setImporting(true);
		setError("");
		setResults([]);
		const picked = sessions.filter((s) => selected.has(s.fileName));
		const msgs = [];
		for (const s of picked) try {
			const d = await (await fetch("/api/cc-import/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: s.fileName,
					cwd
				})
			})).json();
			if (d.error) msgs.push(t.failImport(s.fileName, d.error));
			else {
				const extra = (d.reimported ? t.reimportedSuffix() : "") + (d.subagentCount ? t.subagentsSuffix(d.subagentCount) : "") + (d.attachError ? t.attachErrorSuffix(d.attachError) : "");
				msgs.push(t.okImport(d.sessionId, d.eventCount, extra));
			}
		} catch (e) {
			msgs.push(t.failImport(s.fileName, String(e)));
		}
		setResults(msgs);
		setImporting(false);
		if (msgs.length > 0 && !msgs.some((m) => m.startsWith("✗"))) {
			try {
				await props.refreshSessions?.();
			} catch {}
			setTimeout(() => setOpen(false), 1500);
		}
	}
	if (!open) return null;
	return react.createElement("div", {
		style: panelStyle,
		onClick: () => setOpen(false)
	}, react.createElement("div", {
		style: dialogStyle,
		onClick: (e) => e.stopPropagation()
	}, react.createElement("div", { style: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 8
	} }, react.createElement("strong", null, t.title), react.createElement("span", { style: {
		fontSize: 12,
		opacity: .7,
		flex: 1,
		textAlign: "center"
	} }, cwd ? `${t.workspacePrefix}${cwd.split(/[\\/]/).pop()}` : t.noWorkspace), react.createElement("button", {
		type: "button",
		onClick: () => setOpen(false),
		style: { cursor: "pointer" }
	}, "×")), loading ? react.createElement("div", null, t.loading) : react.createElement("div", { style: {
		flex: 1,
		overflow: "auto",
		display: "flex",
		flexDirection: "column",
		gap: 4
	} }, react.createElement("label", { style: {
		...rowStyle,
		cursor: "pointer",
		fontSize: 13,
		opacity: .85
	} }, react.createElement("input", {
		type: "checkbox",
		checked: sessions.length > 0 && selected.size === sessions.length,
		onChange: toggleAll
	}), react.createElement("span", null, t.selectAll(selected.size, sessions.length))), sessions.map((s) => react.createElement("label", {
		key: s.fileName,
		style: rowStyle
	}, react.createElement("input", {
		type: "checkbox",
		checked: selected.has(s.fileName),
		onChange: () => toggle(s)
	}), react.createElement("span", null, "🅒"), react.createElement("span", { style: {
		flex: 1,
		overflow: "hidden"
	} }, react.createElement(TitleLine, {
		title: s.title,
		fallback: s.fileName.replace(/\.jsonl$/, "")
	}), react.createElement("div", { style: monoStyle }, s.projectDir)), react.createElement("span", { style: monoStyle }, s.size ? `${s.size} B` : ""))), sessions.length === 0 ? react.createElement("div", { style: monoStyle }, t.empty) : null), error ? react.createElement("div", { style: {
		color: "#ff6b6b",
		fontSize: 13
	} }, error) : null, results.length > 0 ? react.createElement("div", { style: resultStyle }, results.join("\n")) : null, react.createElement("button", {
		type: "button",
		onClick: importSelected,
		disabled: importing || selected.size === 0,
		style: {
			cursor: "pointer",
			alignSelf: "flex-end"
		}
	}, importing ? t.importing : t.importSelected(selected.size))));
}
function apply(ctx) {
	const slots = ctx.get("slots");
	if (!slots) return;
	reportBrowserLang();
	ctx.on("command/executed", (sessionId, name, result) => {
		if (name !== "init" || !result || typeof result.text !== "string") return;
		try {
			const sessions = ctx.get("sessions");
			const scope = typeof sessions?.scope === "function" ? sessions.scope(sessionId) : void 0;
			const conversation = scope?.get?.("conversation");
			if (conversation && typeof conversation?.input?.for === "function") conversation.input.for(scope).notify(result.kind === "error" ? "error" : "info", result.text);
		} catch {}
	});
	slots.inject("sidebar.footer.action", () => slots.register({
		name: "sidebar.footer.action",
		id: "cc-import-import",
		order: 10,
		label: "导入 Claude Code 对话"
	}, (props) => react.createElement(FooterButton, { wide: !!props.wide })));
	slots.inject("shell.overlay", () => slots.register({
		name: "shell.overlay",
		id: "cc-import-overlay"
	}, (props) => react.createElement(ImportOverlay, {
		useWorkspaces: props.useWorkspaces,
		useSessions: props.useSessions,
		refreshSessions: () => {
			const s = ctx.get("sessions");
			if (s && typeof s.refresh === "function") return Promise.resolve(s.refresh());
			return Promise.resolve();
		}
	})));
}
//#endregion
exports.apply = apply;


    return module.exports;
  }
});
