/**
 * `/init` 命令 — 分析代码库并生成 DSH.md 项目记忆文件。
 *
 * 参考 Claude Code 的 `/init`：命令先让用户选择文档语言（经 `ctx.userQuestions`
 * 的 UI 选项通道），然后把"分析代码库 → 创建 DSH.md"的提示词作为 user 消息
 * 提交给当前会话的模型（`agent.followup`），由模型自行探索并写入文件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 可选语言：label 同时是选项标签与答案值。 */
const LANGS: Record<string, { instruction: string; prefix: string }> = {
  中文: {
    instruction: '使用中文撰写文档内容（代码、命令、路径等原文保留）。',
    prefix:
      '# DSH.md\n\n' +
      '本文件是 DeepSeek Harness（DSH）的项目记忆文件，会话组装时由 cc-import 加载到模型上下文。',
  },
  English: {
    instruction: 'Write the document in English.',
    prefix:
      '# DSH.md\n\n' +
      'This file is the project memory file of DeepSeek Harness (DSH), loaded into the model context by cc-import during session assembly.',
  },
}
const DEFAULT_LANG = 'English'

/** 组装 /init 提示词（参考 Claude Code /init 生成的 user prompt）。 */
function buildPrompt(lang: string, workspace: string): string {
  const meta = LANGS[lang] ?? LANGS[DEFAULT_LANG]
  return [
    'Please analyze this codebase and create a DSH.md file, which will be given to future instances of DeepSeek Harness agents to operate in this repository.',
    '',
    `Workspace: ${workspace}`,
    `Language preference: ${lang} — ${meta.instruction}`,
    '',
    'What to add:',
    '1. Commands that will be commonly used, such as how to build, lint, and run tests. Include the necessary commands to develop in this codebase, such as how to run a single test.',
    '2. High-level code architecture and structure so that future instances can be productive more quickly. Focus on the "big picture" architecture that requires reading multiple files to understand.',
    '',
    'Usage notes:',
    "- If there's already a DSH.md, suggest improvements to it.",
    '- When you make the initial DSH.md, do not repeat yourself and do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", "Never include sensitive information (API keys, tokens) in code or commits".',
    '- Avoid listing every component or file structure that can be easily discovered.',
    "- Don't include generic development practices.",
    '- If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), make sure to include the important parts.',
    '- If there is a README.md, make sure to include the important parts.',
    '- Do not make up information such as "Common Development Tasks", "Tips for Development", "Support and Documentation" unless this is expressly included in other files that you read.',
    '- Be sure to prefix the file with the following text:',
    '',
    '```',
    meta.prefix,
    '```',
  ].join('\n')
}

/** 注册 `/init` 斜杠命令（host 半；客户端输入框经 commands Remote 自动发现）。 */
export function registerInitCommand(ctx: Context): void {
  const commands = ctx.get('commands') as any
  if (!commands || typeof commands.register !== 'function') return

  ctx.effect(() => commands.register({
    name: 'init',
    description: '分析代码库并生成 DSH.md 项目记忆文件（先选择文档语言）',
    async handler(invocation: any) {
      const agent = invocation?.agent
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || !cwd) {
        return { kind: 'error', text: '无法确定当前工作区（session 无 cwd），无法执行 /init。' }
      }

      // 1. 让用户选择文档语言（DSH 的 UI 选项通道；取消/失败则回退默认语言）。
      let lang = DEFAULT_LANG
      const uq = ctx.get('userQuestions') as any
      if (uq && typeof uq.ask === 'function') {
        try {
          const answer = await uq.ask({
            agent,
            signal: invocation?.signal,
            questions: [{
              id: 'lang',
              header: '/init',
              question: '请选择生成的 DSH.md 使用哪种语言：',
              options: Object.keys(LANGS).map((label) => ({ label })),
            }],
          })
          const item = (answer?.answers || []).find((a: any) => a.id === 'lang')
          const picked = item?.selected?.[0]
          if (typeof picked === 'string' && LANGS[picked]) lang = picked
        } catch (e: any) {
          if (invocation?.signal?.aborted) return { kind: 'error', text: '/init 已取消。' }
          // 提问通道不可用或被拒：回退默认语言继续。
        }
      }

      // 2. 生成提示词并作为 user 消息提交给模型（模型会自行分析并写入 DSH.md）。
      try {
        const prompt = buildPrompt(lang, cwd)
        const message = createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        })
        if (typeof agent?.followup !== 'function') {
          return { kind: 'error', text: '当前会话的 agent 不可用，无法提交 /init 分析任务。' }
        }
        agent.followup(message)
        return {
          kind: 'success',
          text: `已提交 /init 分析任务（语言：${lang}）。模型将探索代码库并生成：${cwd}\\DSH.md`,
        }
      } catch (e: any) {
        return { kind: 'error', text: `提交 /init 分析任务失败：${e?.message || String(e)}` }
      }
    },
  } as any))
}
