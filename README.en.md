# dsh-cc-import

<a href="README.md">简体中文</a> · <strong>English</strong>

<p align="center">
  <a href="https://github.com/Mreate/dsh-cc-import"><img alt="GitHub Repo" src="https://img.shields.io/badge/repo-dsh--cc--import-181717?style=flat-square&logo=github&logoColor=white&cacheSeconds=0"></a>
  <a href="https://github.com/Mreate/dsh-cc-import/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/Mreate/dsh-cc-import?style=flat-square&logo=github&cacheSeconds=0"></a>
  <a href="https://github.com/Mreate/dsh-cc-import/forks"><img alt="GitHub Forks" src="https://img.shields.io/github/forks/Mreate/dsh-cc-import?style=flat-square&cacheSeconds=0"></a>
  <a href="https://github.com/Mreate/dsh-cc-import/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Mreate/dsh-cc-import/ci.yml?style=flat-square&label=CI&cacheSeconds=0"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square&cacheSeconds=0"></a>
  <img alt="status" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square&cacheSeconds=0">
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-4b6fff?style=flat-square&cacheSeconds=0">
</p>

> Migrate Claude Code memories and conversations into DeepSeek Harness (DSH): CLAUDE.md / DSH.md memory loading,
> a one-shot `/init` that scaffolds a DSH.md, and high-fidelity import of Claude Code `.jsonl` conversations as
> **traceable, resumable DSH sessions**. Zero core changes — a pure plugin. Install the plugin and it works;
> uninstalling leaves no core patches behind.

## Core Features

- **Memory loading (CLAUDE.md + DSH.md)**: Injects `~/.claude/CLAUDE.md`, `./CLAUDE.md`, `./CLAUDE.local.md`,
  subdirectory CLAUDE.md files (path index, read on demand) and `@import` references following the
  [Claude Code official docs](https://code.claude.com/docs) memory hierarchy; also loads this harness's native
  **DSH.md family** (`./DSH.md`, `./DSH.local.md`, subdirectory DSH.md (path index, read on demand) and
  `@import`). DSH.md loads later and takes priority on conflicts.
- **`/init` command**: Type `/init` to first pick the document language (中文 / English, via the DSH options
  selection UI), then submit the "analyze the codebase → create DSH.md" prompt to the current model, which
  explores the project and writes `DSH.md` (mirrors Claude Code's `/init` flow; the result is visible immediately).
- **High-fidelity conversation import**: Converts CC `.jsonl` sessions into real, resumable DSH sessions
  (user/assistant turns, tool calls and results, thinking → `reasoning`, timestamps, token usage).
  Imported sessions are **attached to the current workspace** and appear in the sidebar.
- **Sub-agent import**: CC sub-agent side chains (`<session>/subagents/*.jsonl`) are imported as child sessions
  (`parentSession` + `delegationDepth` + `origin: 'subagent'`).
- **Extensible**: Importers implement the `ImportProvider` interface (`src/import/provider.ts`);
  adding Cursor / Codex and other agents later only requires one more provider implementation.
- **Dual entry points**: a sidebar footer button "🅒 Import Claude Code conversations" + an overlay multi-select
  picker; on the model side, the `cc_history_list` / `cc_import` tools let the model drive imports directly.

## Quick Start

Prerequisites: a DSH with the `dsh` CLI installed globally (`npm install -g @deepseek-ai/dsh`), pnpm 10+, Node ≥ 22.

```sh
# 1. Clone / download the plugin source, then install dependencies and build
cd cc-import
pnpm install
pnpm run bundle        # tsdown → lib/index.js + lib/client.cjs

# 2. Install into a DSH profile (web shown here)
dsh plugin --profile web add <absolute path to this plugin>
```

> "declares no dsh.bundle — installed as a plain dependency" is expected:
> this plugin mounts manually via a `cordis.patch.yml` insert, not through the bundle layer.

**Wiring (host half)**: edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: cc-import
      name: cc-import
```

**Client half** is auto-detected and bundled from the `dsh.client` field in `package.json` — no manual wiring.
After editing the config, restart `dsh web` (the browser page reconnects automatically; refresh the page once
if the client is still running an old build).

## UI

A "🅒 Import Claude Code conversations" entry is added to the sidebar footer (the DSH official UI is untouched — a pure plugin overlay):

| Area | Description |
|---|---|
| Footer entry | 🅒 button; opens the import overlay |
| Overlay header | Shows the target workspace (`Workspace: <name>`; shows all sessions when none is detected) |
| Session list | Multi-select: CC icon + title (collapses to a grey `… (xx chars folded)` past 80 chars) + project dir + size |
| Batch import | "Import selected (N)" → per-item results (✓/✗ + event count + sub-agent count) → auto-closes on full success |
| List filtering | Only CC sessions matching the **current workspace** cwd are shown (Windows case/separator tolerant) |

## Screenshots

| Feature              | Screenshot                           |
|----------------------|--------------------------------------|
| Import session UI    | ![Import overlay](image/Example.png) |
| /init command        | ![init command](image/Init.png)      |

## Documentation

| Topic | Content |
| --- | --- |
| [Design doc](DESIGN.md) | Architecture, event mapping, memory hierarchy, milestones (in Chinese) |
| [Integration checklist](INTEGRATION.md) | Install, wiring, end-to-end verification steps (in Chinese) |
| [Code conventions](docs/conventions.md) | Module boundaries, provider abstraction, lossless JSON contract (in Chinese) |

## Configuration & Extension

- **Memory hierarchy**: CLAUDE family first, DSH family second (the latter wins); within a family
  `local > project > user`; root memory is inlined in full, while subdirectory files are listed as a
  path index (read on demand); `@import` supports `@path` (relative to the referencing file's directory),
  `@/path` (workspace root), `@~/path` (user home) — nestable, cycle-free, depth-bounded.
- **`/init`**: pick a language (中文 / English) → generates the "analyze the codebase and create DSH.md" prompt
  and submits it to the current model, which explores the project and writes `DSH.md` (suggests improvements
  if one already exists).
- **Extending importers**: implement `ImportProvider` (`discoverDataRoot` / `listSessions` / `previewSession` /
  `importSession`) and register it in `src/index.ts`; `claude-code` is the reference implementation.
- **Workspace ownership**: imported sessions are `attachSession`-ed to the target workspace registry, so the
  sidebar groups them under the matching workspace immediately.

## How It Works

```text
dsh profile
  -> dsh-base + dsh-web-app
  -> cc-import Cordis patch
  -> systemPrompt.context (CLAUDE.md + DSH.md memory as user-role runtime-context snapshot)
  -> /init command (language pick → userQuestions → agent.followup → model writes DSH.md)
  -> sidebar footer button + shell.overlay (client half)
  -> /api/cc-import RPC (webServer HTTP routes)
  -> ImportProvider (CC JSONL parsing + event synthesis)
  -> sessionPersistence.create/append (persistence)
  -> workspaceRegistry.attachSession (workspace ownership frame)
  -> client session.list baseline re-fetch (appears instantly, no browser refresh)
```

Import only "turns CC history into DSH sessions". The session log is the source of truth for conversations —
resume, traceback, tool execution, compaction and persistence remain owned by DSH services. See the
[design doc](DESIGN.md) for module boundaries in more detail.

## Technical Highlights

- **Event-level high-fidelity mapping**: CC records → a balanced DSH `SessionEvent` sequence
  (`turn/start` → `user/message` → `step/start` → `assistant/message` → `tool/call` → `tool/result` →
  `step/end` → `turn/end`); `seq` is 0-based and contiguous, `time` keeps the source timestamps, surface events
  carry `surfaceOp: 'append'`, and `data` is lossless JSON.
- **Idempotent import**: a deterministic session id (`cc-<source file name>`) makes repeated imports return
  the existing session; sessions archived in DSH can still be re-imported — a fresh session is created under
  `cc-<source file name>-reimport-N` while the archived one is left untouched.
- **Immediately visible**: after import the host fires a `host/workspace-changed` frame and the client re-fetches
  the `session.list` baseline, so the session appears in the current workspace right away — no DSH restart or
  browser refresh.
- **Windows path tolerance**: cwd filtering normalizes case and separators.
- **Model-drivable**: the `cc_history_list` / `cc_import` tools are registered in the model toolset.

## Known Limitations

- Tool call arguments and results are preserved as-is but **never re-executed** — imported sessions are faithful
  replays, not live re-runs.
- Sub-agents are imported as child sessions, but the tool calls that spawned them in the main session are not yet
  hyperlinked to the child sessions.
- Attachment (image) restoration is not implemented: CC image blocks degrade to a text placeholder
  (`[image: <media_type>]`).
- The sidebar session list is a closed DSH area; imported sessions carry no CC badge there (badges only show in
  the plugin overlay).
- Import covers the `claude-code` provider only; `@import` depth/file counts are bounded (default 4 levels /
  40 files).

The full list of limitations and design trade-offs is in the [design doc](DESIGN.md).

## Development

CI uses Node 24 and pnpm; the package declares support for Node `^22.19 || >=24`.

```sh
pnpm install --frozen-lockfile
pnpm run bundle
```

`pnpm run bundle` compiles `src/` to `lib/` with tsdown (host: `lib/index.js`; client: `lib/client.cjs`,
factory form `window.__ModuleLoader__.load`). After changing source code you must rebuild and restart `dsh web`.

## Permissions & Security

`cc-import` implements no separate sandbox: memory loading only **reads** files; `/init` and imports write
through DSH's existing file policy (`/init` is explicitly scoped to `workspace-write` inside the current
workspace). Imported conversations are persisted via `sessionPersistence` and attached to the workspace
registry; no model or shell commands are executed.

## License

[MIT](LICENSE)
