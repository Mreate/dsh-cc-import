# cc-import — 设计文档

将 Claude Code（后续可扩展到其他 Agent）的记忆文件与对话历史迁移进 DeepSeek Harness（DSH）。
本项目是**可开源发布的 TypeScript 插件包**（host 半 + `dsh.client` 客户端半）。

## 1. 目标

1. **记忆加载（CLAUDE.md + DSH.md）**：按 [Claude Code 官方文档](https://code.claude.com/docs) 的 memory 规范，扫描并注入
   `~/.claude/CLAUDE.md`、`./CLAUDE.md`、`./CLAUDE.local.md`、子目录 CLAUDE.md、`@import` 引用，遵循优先级；
   同时加载本 harness 原生的 DSH.md 家族（`/init` 生成，冲突时优先级更高）。
2. **高保真对话导入**：把 Claude Code 的 `.jsonl` 会话转换成**可回溯、可 resume 的真实 DSH 会话**（含子代理、附件、时间戳、thinking）。
3. **侧边栏叠加式入口 + 浮层选择器**：侧边栏底部入口 → 浮层列出 CC 会话（CC 图标标注、只读预览）→「导入此对话」。
4. **`/init` 命令**：先让用户选择文档语言，再生成「分析代码库 → 创建 DSH.md」提示词并提交给
   当前模型（参考 Claude Code 的 `/init` 流程），由模型探索项目并写入 `DSH.md`。
5. **多 Agent 可扩展**：导入器做成 provider 抽象，CC 是第一个 provider，后续接 Cursor / Codex 等。

## 2. 架构总览

```
┌────────────────────────────────────────────────────────────┐
│  cc-import（单包，双半）                                      │
│                                                              │
│  Host 半（lib/index.js，composition 行加载）                    │
│   ├─ MemoryLoader   CLAUDE.md + DSH.md 扫描/优先级/@import → systemPrompt.section │
│   ├─ InitCommand    /init：语言选择 → 分析提示词 → agent.followup 生成 DSH.md │
│   ├─ ImportService  CC JSONL → DSH SessionEvent 序列          │
│   │      └─ ImportProvider 抽象（claude-code 为第一个实现）      │
│   └─ RPC 方法       供客户端调用（list/preview/import）          │
│                                                              │
│  Client 半（lib/client.cjs，dsh.client 加载）                   │
│   ├─ sidebar.footer.action  入口按钮（CC 图标）                 │
│   └─ shell.overlay          浮层选择器（列表/预览/导入）          │
└────────────────────────────────────────────────────────────┘
```

### 关键约束（已核实）

- **侧边栏会话列表是封闭区域**：`sidebar.workspaces` 为 `kind: single` + `replaceRisk: shadows-shipped-ui`，
  无逐条会话项插槽、无三点菜单插槽。→ 采用叠加式入口（`sidebar.footer.action`）+ 浮层（`shell.overlay`）。
- **`SessionHeader` 无 `source` 字段**（仅 `origin?: 'subagent'`）→ 导入的会话无法在普通列表项上原生打 CC 徽标。
  徽标只在**插件自己的浮层**里显示；导入后成为普通会话（列表项不标 CC）。
- **`dsh.client` 打包约定**：`package.json` 的 `dsh.client` 字段 + `exports["./client"]`；host 半走 `main`；构建用 `tsdown`。

## 3. 包结构与发布

```
cc-import/
├─ package.json         # main=lib/index.js；exports["./client"]；dsh.client；scripts.bundle=tsdown
├─ tsdown.config.ts     # 构建（host + client 两个入口）
├─ tsconfig.json
├─ src/
│  ├─ index.ts          # host 半入口（Cordis plugin）
│  ├─ memory.ts         # CLAUDE.md + DSH.md 加载
│  ├─ init.ts           # /init 命令（生成 DSH.md）
│  ├─ import/           # 导入器 + provider 抽象
│  │  ├─ provider.ts    # ImportProvider 接口
│  │  └─ claude-code.ts # CC provider（JSONL 解析 + 事件映射）
│  ├─ rpc.ts            # host 暴露给 client 的 HTTP 路由
│  └─ client/
│     └─ index.ts       # client 半入口（slot 注册）
├─ README.md / LICENSE
└─ docs/
```

- **依赖**：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*`（peerDependencies）、`react`（client）。
- **启用方式**：composition 加一行 `- { id: cc-import, name: 'cc-import' }`（host 半）；客户端半经 `dsh.client` 自动扫描打包。

## 4. 记忆加载完整实现（host）

按官方 memory 规范，加载顺序与优先级（后加载者更具体，冲突时覆盖）：

| 层 | 路径 | 说明 |
|---|---|---|
| managed policy | 部署注入 | 最高优先级，只读 |
| user | `~/.claude/CLAUDE.md` / `~/.dsh/DSH.md` | 全局个人记忆 |
| project | `./CLAUDE.md` / `./DSH.md`（workspace 根） | 共享、入库 |
| local | `./CLAUDE.local.md` / `./DSH.local.md` | 个人、gitignore |
| subdir | 子目录 CLAUDE.md / CLAUDE.local.md / DSH.md / DSH.local.md | 按需加载（进入该子树时） |
| imports | `@path` / `@/path` / `@~/path` | 内联引用，可嵌套、去环 |

**实现要点**：
- 注入点：`systemPrompt.section({ name: 'cc-import:memory', order: 50, text })`。
- **CLAUDE 家族在前、DSH 家族在后**（DSH.md 是本 harness 原生记忆，`/init` 生成，冲突时覆盖 CLAUDE.md）；
  家族内 `local > project > user`、子目录 > 根目录。
- 全局 + project + local 在 session 启动时读入；subdir 采用「按需」策略：随 `fs/observed` 或工作区扫描有界加载
  （原型先做有界深度扫描，跳过 `node_modules`/`.git` 等）。
- `@import` 解析：`@/x` → workspace 根；`@~/x` → home；`@x` → 引用文件所在目录；深度 ≤ N、路径去环。
- 优先级合并：同 key 的指令，更具体层（local > project > user）覆盖。

## 5. 高保真导入：CC JSONL → DSH SessionEvent

### 5.1 DSH 会话事件模型（已核实）

- 会话 = 追加式 `SessionEvent[]`，事件 `{ type, seq, time, data, surfaceOp?, sourceEventSeqs? }`。
- Surface 事件（进入模型历史）仅三类：`user/message`、`assistant/message`、`tool/result`。
- 结构括号：`turn/start`/`turn/end`、`step/start`/`step/end`；工具：`tool/call`（请求）+ `tool/result`（结果）。
- ContentBlock 词汇：`text` / `reasoning`(← CC `thinking`) / `image` / `tool-call` / `tool-result`。
- Message：`{ id, role, content: ContentBlock[], source: MessageSource }`；
  `source` 为 merge-extensible：`{kind:'user'}` / `{kind:'plugin',plugin}` / `{kind:'model',provider,model}` / `{kind:'tool',callId}`。

### 5.2 CC 记录 → DSH 事件映射

| CC JSONL record | DSH 事件 / 块 |
|---|---|
| `user`（content: string \| text[]） | `turn/start` → `user/message`（content=[TextBlock]，source `{kind:'user'}`） |
| `user`（content: tool_result[]） | 每个 result → `tool/result`（ToolResultMessage，content=[ToolResultBlock]） |
| `assistant`（text/thinking/tool_use） | `step/start` → `assistant/message`（text→`text`、thinking→`reasoning`、tool_use→`tool-call` 块）+ 对应 `tool/call` 事件 |
| `assistant`（纯文本收尾） | `assistant/message` → `step/end` → `turn/end`（reason `{kind:'success'}`） |
| `summary`/`system`/`mode`/`attachment` 等 | 跳过（非消息记录） |
| `cwd`/`version`/`gitBranch`/`timestamp` | 会话 meta（`cwd`）、事件 `time`、`createdAt` |

**一轮 agentic 循环的合成结构**（CC 一个 user 提示 + 若干 assistant/tool_result 往返）：

```
turn/start {turn:N}
  user/message              ← CC user（提示）
  step/start {turn:N, step:1}
    assistant/message       ← CC assistant（含 tool-call 块）
    tool/call               ← 每个 CC tool_use
    tool/result             ← 每个 CC tool_result
  step/end
  step/start {turn:N, step:2}
    assistant/message       ← CC assistant（最终文本）
  step/end
turn/end {reason:{kind:'success'}}
```

### 5.3 高保真细节

- **thinking → `reasoning` 块**：保留原文。
- **tool_use → `tool-call` 块 + `tool/call` 事件**：`arguments = JSON.stringify(input)`，`callId` 沿用 CC 的 tool_use `id`。
- **附件（image）**：CC user 消息的 image 块 → 保存到 `ctx.attachments`，产出 `{type:'image', attachment}` 块；无法还原的降级为文本占位。
- **子代理树**：`~/.claude/projects/<proj>/<sid>/subagents/*.jsonl` → 独立子会话，`SessionHeader.parentSession` 指向父会话、
  `delegationDepth` + 1；主会话内以 `{kind:'plugin'}` 或 recall 块表示子代理产出（具体呈现待 UI 阶段定）。
- **时间戳**：CC `timestamp` → 事件 `time`；最早 user 消息时间 → `SessionHeader.createdAt`。
- **usage**：CC `usage.input_tokens/output_tokens` → `assistant/message.usage`（TokenUsage）。

### 5.4 写入路径

1. `ctx.get('sessionPersistence').create(meta)` — 注册 `SessionHeader{version,id,createdAt,cwd}`。
2. `ctx.get('sessionPersistence').append(id, events)` — 逐批追加，`seq` 连续、`time` 单调、log 平衡（括号闭合）。
3. `ctx.get('workspaceRegistry').create(cwd)` + `attachSession(id)` — 把会话**附加到目标工作区**
   （侧边栏按注册表 `sessionIds` 分组，仅持久化会落到「未分组」）；attach 触发
   `host/workspace-changed` 帧，客户端工作区列表立即更新。
4. 客户端导入成功后重拉 `session.list` 基线（`SessionRuntime.refresh`）→ 会话**立即**出现在
   当前工作区下，无需重启 DSH 或刷新浏览器。
5. 导入后会话即成为普通 DSH 会话：可 resume、可回溯、出现在会话列表。

> 风险：`sessionPersistence.append` 要求「平衡 log + 连续 seq」，导入器需在合成阶段保证每轮括号闭合、
> 每个 `tool/call` 有 `tool/result`，否则 load 时会触发 crash-repair（合成结果非预期）。首版用**单步逐轮合成**并
> 用最小事件集验证，再逐步增加 thinking/附件/子代理保真度。

## 6. 客户端 UI（client）

- **入口**：`sidebar.footer.action` 注册「导入 Claude Code 对话」按钮（CC 图标）。
- **浮层**：`shell.overlay` 注册选择器：
  - 左栏：CC 会话列表（按项目分组，CC 图标标注，含相对时间/消息数/标题）。
  - 右栏/展开：只读预览（复用 host 的 JSONL→markdown 渲染）。
  - 「导入此对话」按钮 → 调 host RPC → 进度 → 成功后提示并可在会话列表打开。
- **通信**：host 半注册 RPC 方法（`listSessions` / `previewSession` / `importSession`），client 经
  `@deepseek-ai/dsh-api-remotes` 或 plugin 自带的 remotes 调用（具体机制在 UI 阶段核实）。

## 7. 多 Agent 可扩展性

```ts
interface ImportProvider {
  readonly id: string                 // 'claude-code'
  readonly displayName: string
  readonly icon: string               // UI 图标
  discoverHome(): Promise<string[]>   // 定位数据目录
  listSessions(): Promise<ImportedSessionSummary[]>
  preview(id): Promise<PreviewDocument>
  toSessionEvents(id): Promise<SessionEvent[]>   // 核心映射
}
```

`cc-import/import/provider.ts` 定义接口，`claude-code` 实现之；新 Agent 只需新增一个 provider 实现 + 注册。

## 8. 里程碑

1. **M1 脚手架**：TS 包结构、tsdown 可编译、host/client 空入口、composition 行可加载。
2. **M2 记忆加载**：CLAUDE.md + DSH.md 完整加载（含 @import、优先级、子目录），动态插件验证后移植 TS。
3. **M3 导入器**：provider 抽象 + CC JSONL→SessionEvent 映射（先单轮、再高保真），写入 `sessionPersistence` 验证可回溯。
4. **M4 UI**：footer 入口 + overlay 浮层 + RPC 贯通 + 工作区归属（attach + 客户端基线重拉）。
5. **M5 /init**：`/init` 语言选择（`ctx.userQuestions.ask`）+ 分析提示词经 `agent.followup`
   提交模型，模型生成 DSH.md。
6. **M6 发布**：README/LICENSE/类型导出/编译产物，端到端实测。

## 9. 已核实结论（原「待核实」项）

- 客户端插槽：`shell.overlay`（additive list，`{id,order,label}`）、`sidebar.footer.action`（additive list，ownerProps `{wide}`）——已用 `Slots.listSubTree` 精确查询。
- packaged 插件 client→host RPC：采用 **`webServer` HTTP 路由**（`/api/cc-import/*`），官方 typert Remote 构建期耦合过重。见 `src/rpc.ts`。
- `sessionPersistence.append` 要求：seq **0 基连续**、事件带 `time`、surface 事件带 `surfaceOp:'append'`、`data` 为 lossless JSON（剔除 `undefined`）、日志**平衡**（括号闭合）。已实测 1584 事件 `inspect=OK`。
- `SessionId`/`MessageId`/`CallId`：均为 branded string，事件数据层用普通字符串即可。
- **会话 cwd 来源**：`sandboxPolicy.workspaceRoot` 是进程 cwd 回退值（不可用作项目根）；正确来源是 `agents.currentInitiator().session.header.cwd`。记忆加载器须按会话 cwd 取项目级 CLAUDE.md/DSH.md。
- **侧边栏分组依据**：`WorkspaceView.sessionIds`（workspaceRegistry 注册表归属），不是会话 cwd 匹配；导入必须 `attachSession` 才出现在对应工作区。
- **客户端工作区信号**：`WorkspaceView.workspaceId`（不是 `id`）；`WorkspaceListState.recentWorkspaceId` 为「最近活跃工作区」，另有 `SessionListState.current` 的 cwd 可作兜底。
- **立即可见机制**：`host/session-added` 帧仅在创建**live Session** 时发出；冷会话靠 `session.list` 基线（含 cwd 的持久化会话）合并。导入采用「持久化 + attach + 客户端基线重拉」组合，无需 live Session。
- **`/init`**：DSH 无内置 `/init`，经 `ctx.commands.register` 注册（host 半，客户端 `/` 菜单自动发现）；
  语言选择走 `ctx.userQuestions.ask`（`dsh-user-questions` 服务，web UI 提供选项弹窗）；
  提示词作为 user 消息经 `agent.followup`（`dsh-agent-loop`）提交，模型分析后写入文件。
