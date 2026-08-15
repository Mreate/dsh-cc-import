# cc-import 接入清单

插件已编译通过（`tsdown` 产出 `lib/index.js` + `lib/client.cjs` + `.d.ts`）。
以下是在**全局安装的 DSH**（`npm install -g`，`$DSH_HOME=C:\Users\<you>\.dsh`）里
安装、接线与端到端验证的步骤。

## 0. 前置

- 已全局安装 dsh，node ≥ 24（`node --version`）
- 已 `pnpm run bundle` 编译出 `lib/`

## 1. 构建

```bash
cd E:\MessyProject\dsh-plugin\CCImport
pnpm install          # 拉取 @deepseek-ai/* @0.1.0-rc.6 + tsdown@0.22
pnpm run bundle       # tsdown → lib/index.js + lib/client.cjs + lib/*.d.ts
```

## 2. 安装到 profile

```powershell
dsh plugin --profile web add E:\MessyProject\dsh-plugin\CCImport
```
> 会提示「declares no dsh.bundle — installed as a plain dependency」是正常的：
> 我们走 `cordis.patch.yml` 的 insert 手动挂载，不走 bundle 层。

## 3. 接线（host 半）

编辑 `C:\Users\<you>\.dsh\profiles\web\cordis.patch.yml`，把 `[]` 改为：

```yaml
- insert:
    - id: cc-import
      name: cc-import
```

> 记忆加载器已改为**按 assembly 的 scope 取会话 cwd**（`src/index.ts`），
> 所以 host 半放**全局 host composition 即可**，项目级 CLAUDE.md/DSH.md 也能扫对目录。

**客户端半**：`dsh.client` 字段自动发现，无需手动接线。

## 4. 验证

```powershell
dsh web --dump-config    # 应出现 cc-import
# 重启 dsh
```

1. **记忆注入**：`~/.claude/CLAUDE.md` / `~/.dsh/DSH.md` + 会话工作区
   `CLAUDE.md`/`CLAUDE.local.md`/`DSH.md`/`DSH.local.md` 作为运行时上下文（user-role
   快照）注入**全文**，**不写入系统提示词**（`<!-- imported: … -->` 内联标记）；子目录
   同名文件只列路径索引（不内联），模型进入该子树时按需 read。
2. **`/init`**：会话输入框输入 `/init` → 弹出语言选择（中文 / English）→ 选择后模型
   开始分析代码库并生成 DSH.md；输入框旁显示提交结果（空白会话同样可见——DSH 的
   空白会话不渲染命令卡片）。
3. **模型工具**：`cc_history_list`、`cc_import` 出现在工具列表。
4. **导入**：`cc_import { sessionId }` → `listed=true, inspect=OK`；会话按当前工作区 cwd 归属
   （`workspaceRegistry.attachSession`），可 resume/回溯；子代理作为子会话导入
   （`parentSession`+`delegationDepth`+`origin:subagent`）。
5. **客户端 UI**：侧边栏底部「🅒 导入 Claude Code 对话」→ 浮层列表（CC 图标、标题折叠提示、
   当前工作区过滤）→ 多选导入 → 全部成功后**立即**出现在当前工作区（无需刷新浏览器）。
6. **HTTP RPC**：`GET /api/cc-import/list`、`GET /api/cc-import/preview?sessionId=`、
   `POST /api/cc-import/import` 返回 JSON。

## 5. 类型说明

`defineTool` 的 DSL 对象已用 `as any` 兜底（`src/index.ts`），`ctx.get(...)` 用结构类型
（`src/import/*`、`src/memory.ts`、`src/rpc.ts`）。在 monorepo 里可换成
`@deepseek-ai/dsh-fs` / `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-llm` / `node:http` 的精确类型。

## 6. 已知限制

- 附件（图片）还原未实现（CC 图片块格式多变 + 需 `attachments.saveImage` 异步注入）。
- 子代理已作为子会话导入，但主会话里触发子代理的工具调用尚未超链接到子会话。
- 导入为「忠实回放」，工具调用不会被重新执行。
- 会话列表是封闭区域，导入的会话在列表里无 CC 徽标（徽标仅在插件浮层内显示）。
