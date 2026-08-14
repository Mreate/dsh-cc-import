/**
 * `/init` 命令 — 生成 DSH.md 项目记忆文件。
 *
 * DSH.md 是本 harness 对 Claude Code CLAUDE.md 的同位替代：memory loader
 * 在会话组装时按同一套层级（全局 / 项目 / local / 子目录 / @import）加载它。
 * Claude Code 的 `/init` 生成 CLAUDE.md，本插件的 `/init` 生成 DSH.md。
 */
import type { Context } from '@deepseek-ai/cordis'

function template(name: string): string {
  return `# DSH.md — ${name}

本文件是 DeepSeek Harness（DSH）的项目记忆文件，等同 Claude Code 的 CLAUDE.md。
会话组装时由 cc-import 加载到模型上下文（含 DSH.local.md、子目录 DSH.md 与 @import 引用）。

## 项目说明

（一句话说明这个项目做什么。）

## 项目结构

（按需补充关键目录与文件。）

## 常用命令

（按需补充：构建 / 测试 / 运行。）

## 约定与规范

（按需补充：编码风格、提交规范、架构约定。）

## 其他说明

（按需补充。）
`
}

/** 注册 `/init` 斜杠命令（host 半；客户端输入框经 commands Remote 自动发现）。 */
export function registerInitCommand(ctx: Context): void {
  const commands = ctx.get('commands') as any
  if (!commands || typeof commands.register !== 'function') return

  ctx.effect(() => commands.register({
    name: 'init',
    description: '创建 DSH.md 项目记忆文件（本 harness 的 CLAUDE.md 同位替代）',
    async handler(invocation: any) {
      const agent = invocation?.agent
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || !cwd) {
        return { kind: 'error', text: '无法确定当前工作区（session 无 cwd），未创建 DSH.md。' }
      }
      const fs = ctx.get('fs') as any
      if (!fs || typeof fs.resolve !== 'function' || typeof fs.writeText !== 'function') {
        return { kind: 'error', text: 'filesystem 服务不可用，未创建 DSH.md。' }
      }
      try {
        const target = await fs.resolve(`${cwd}/DSH.md`)
        const existing = await fs.stat(target)
        if (existing && existing.type === 'file') {
          return { kind: 'success', text: `DSH.md 已存在：${cwd}\\DSH.md（未覆盖，直接编辑即可）。` }
        }
        const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project'
        // 显式 workspace-write 策略：写入只允许落在当前工作区内。
        await fs.writeText(target, template(base), undefined, undefined, {
          mode: 'workspace-write',
          workspaceRoot: cwd,
          sessionId: agent?.session?.id,
        })
        return { kind: 'success', text: `已创建 DSH.md：${cwd}\\DSH.md\n（编辑后，下次会话组装时自动载入模型上下文。）` }
      } catch (e: any) {
        return { kind: 'error', text: `创建 DSH.md 失败：${e?.message || String(e)}` }
      }
    },
  } as any))
}
