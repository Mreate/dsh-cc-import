/**
 * `/init` 命令 — 分析代码库并生成 DSH.md 项目记忆文件。
 *
 * 参考 Claude Code 的 `/init`：命令先让用户选择文档语言（经 `ctx.userQuestions`
 * 的 UI 选项通道），然后把"分析代码库 → 创建 DSH.md"的提示词作为 user 消息
 * 提交给当前会话的模型（`agent.followup`），由模型自行探索并写入文件。
 *
 * 本地化策略（浏览器语言，host 经 /api/cc-import/lang 获知，默认英文）：
 *   - 提问题面与结果消息：运行时取 `getUiLang()`，浏览器为中文则中文、否则英文；
 *   - 命令描述：dsh-commands 要求 description 为注册时固定的静态字符串（无更新
 *     API、客户端 remote 只读），无法按浏览器语言展示，因此固定用英文。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { getUiLang, type UiLang } from './ui-lang'

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

/** /init 的 UI 文案（提问 + 结果消息），按浏览器语言选择。 */
const UI: Record<UiLang, {
  question: string
  noCwd: string
  cancelled: string
  agentUnavailable: string
  submitted: (lang: string, path: string) => string
  submitFailed: (msg: string) => string
}> = {
  en: {
    question: 'Please choose the language for the generated DSH.md:',
    noCwd: 'Cannot determine the current workspace (session has no cwd), cannot run /init.',
    cancelled: '/init cancelled.',
    agentUnavailable: 'The current session agent is unavailable; cannot submit the /init analysis task.',
    submitted: (lang, path) => `Submitted /init analysis task (language: ${lang}). The model will explore the codebase and generate: ${path}`,
    submitFailed: (msg) => `Failed to submit /init analysis task: ${msg}`,
  },
  zh: {
    question: '请选择生成的 DSH.md 使用哪种语言：',
    noCwd: '无法确定当前工作区（session 无 cwd），无法执行 /init。',
    cancelled: '/init 已取消。',
    agentUnavailable: '当前会话的 agent 不可用，无法提交 /init 分析任务。',
    submitted: (lang, path) => `已提交 /init 分析任务（语言：${lang}）。模型将探索代码库并生成：${path}`,
    submitFailed: (msg) => `提交 /init 分析任务失败：${msg}`,
  },
}

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
    // 描述固定英文：dsh-commands 要求静态字符串且无更新 API（见文件头注释）。
    description: 'Analyze the codebase and generate a DSH.md project memory file (pick the document language first)',
    async handler(invocation: any) {
      const ui = UI[getUiLang()]
      const agent = invocation?.agent
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || !cwd) {
        return { kind: 'error', text: ui.noCwd }
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
              question: ui.question,
              options: Object.keys(LANGS).map((label) => ({ label })),
            }],
          })
          const item = (answer?.answers || []).find((a: any) => a.id === 'lang')
          const picked = item?.selected?.[0]
          if (typeof picked === 'string' && LANGS[picked]) lang = picked
        } catch (e: any) {
          if (invocation?.signal?.aborted) return { kind: 'error', text: ui.cancelled }
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
          return { kind: 'error', text: ui.agentUnavailable }
        }
        agent.followup(message)
        return {
          kind: 'success',
          text: ui.submitted(lang, `${cwd}\\DSH.md`),
        }
      } catch (e: any) {
        return { kind: 'error', text: ui.submitFailed(e?.message || String(e)) }
      }
    },
  } as any))
}
