# CCImport

Import [Claude Code](https://code.claude.com/docs) memory and conversation history into
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

- **CLAUDE.md memory** — loads `~/.claude/CLAUDE.md`, `./CLAUDE.md`, `./CLAUDE.local.md`,
  subdirectory `CLAUDE.md` files, and `@import` references into the model context,
  following Claude Code's precedence rules.
- **Conversation import** — converts a Claude Code `.jsonl` session into a **resumable,
  backtrackable DSH session** (user/assistant turns, tool calls and results, reasoning,
  timestamps, token usage), grouped under the source project's workspace.
- **Extensible** — importers sit behind an `ImportProvider` interface, so other agent
  products (Cursor, Codex, …) can be added as new providers.

## Package layout

| Entry | Path | Loaded by |
| --- | --- | --- |
| Host half | `main` → `lib/index.js` | a composition row `{ id: ccimport, name: 'ccimport' }` |
| Client half | `exports["./client"]` → `lib/client.js` | the `dsh.client` field in `package.json` |

## Enabling

Add a row to the host composition (or an agent preset):

```yaml
- id: ccimport
  name: 'ccimport'
```

The client half is picked up automatically from the `dsh.client` field once the package
is installed. Model-facing tools `cc_history_list` and `cc_import` are registered by the
host half, so import is also drivable from the model.

## Import model

A Claude Code session is mapped onto the DSH event model (`DESIGN.md` §5):

```
turn/start → user/message → step/start → assistant/message → tool/call → tool/result → step/end → turn/end
```

- `thinking` → DSH `reasoning` blocks
- `tool_use` → `tool-call` blocks + `tool/call` events
- `tool_result` → `tool/result` events
- `usage` → `TokenUsage`
- source timestamps → event `time`; first timestamp → `createdAt`

Import is idempotent: a deterministic session id means re-importing the same source
returns the already-imported session.

## Extending to another agent

Implement `ImportProvider` (see `src/import/provider.ts`) and register it in
`src/index.ts`. `claude-code` is the reference implementation.

## Build

```bash
pnpm install
pnpm run bundle   # tsdown
```

Compilation requires the `@deepseek-ai/*` peer dependencies, which are provided by the
DSH monorepo or npm plugin ecosystem.

## Known limitations

- Tool-call arguments/results are preserved verbatim but are not re-executed; the
  imported session is a faithful replay, not a live re-run.
- Sub-agent side-chains are imported as child DSH sessions (`parentSession` +
  `delegationDepth`), but the main session's tool call that spawned a sub-agent is not
  yet hyperlinked to that child session.
- Image/attachment restoration is not yet implemented (CC image blocks are left out).
- The sidebar session list is a sealed region in DSH, so imported sessions appear as
  ordinary DSH sessions (no in-list agent badge); the picker shows the agent icon.

## License

MIT
