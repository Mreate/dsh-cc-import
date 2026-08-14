/**
 * CCImport — host half entry.
 *
 * Loaded by a composition row `{ id: ccimport, name: 'ccimport' }`.
 * Composes the CLAUDE.md memory loader and the Claude Code import provider,
 * and registers model-facing tools so the import is also drivable from the
 * model (the client UI uses RPC added in the UI milestone).
 */
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createMemoryLoader } from './memory'
import { createClaudeCodeProvider } from './import/claude-code'
import type { ImportProvider } from './import/provider'
import { registerRpcRoutes } from './rpc'

export const name = 'ccimport'
export const inject = ['systemPrompt', 'sandboxPolicy', 'tools'] as const

const MEMORY_SECTION_ORDER = 50

export function apply(ctx: Context) {
  // Session cwd (the real project root for CLAUDE.md) must be resolved per
  // assembly, not once at apply: in a global host composition the agent only
  // exists during assembly, where `AssembleContext.scope` IS the agent
  // (dsh-agent-loop does `createScope(loopCtx, this)`).
  const agents = ctx.get('agents') as any
  const fallbackRoot: string | undefined = ctx.sandboxPolicy.workspaceRoot

  // ---- 1. CLAUDE.md memory (per-session-cwd cache) -------------------
  const memoryLoader = createMemoryLoader(ctx)
  const memoryCache = new Map<string, string>()
  const loading = new Set<string>()
  function memoryFor(cwd: string): string {
    if (memoryCache.has(cwd)) return memoryCache.get(cwd)!
    if (!loading.has(cwd)) {
      loading.add(cwd)
      memoryLoader
        .load(cwd)
        .then((t) => { memoryCache.set(cwd, t) })
        .catch(() => { memoryCache.set(cwd, '') })
    }
    return ''
  }
  ctx.systemPrompt.section({
    name: 'ccimport:claude-md',
    order: MEMORY_SECTION_ORDER,
    text: (assembleCtx: any) => {
      const cwd: string | undefined =
        assembleCtx?.scope?.session?.header?.cwd ??
        (typeof agents?.currentInitiator === 'function' ? agents.currentInitiator()?.session?.header?.cwd : undefined) ??
        fallbackRoot
      return cwd ? memoryFor(cwd) : ''
    },
  })

  // ---- 2. import providers (extensible) ------------------------------
  const providers: ImportProvider[] = [createClaudeCodeProvider(ctx)]

  // ---- 2b. client-facing HTTP RPC -------------------------------------
  registerRpcRoutes(ctx, providers)

  // ---- 3. model-facing tools -----------------------------------------
  const listTool = defineTool({
    name: 'cc_history_list',
    description: 'List Claude Code conversation sessions available under ~/.claude/projects (read-only).',
    parameters: {
      limit: { type: 'integer', description: 'Maximum sessions to return (default 100).' },
      filter: { type: 'string', description: 'Optional case-insensitive substring filter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          truncated: { type: 'boolean' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string' },
                fileName: { type: 'string' },
                relPath: { type: 'string' },
                projectDir: { type: 'string' },
                size: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`Claude Code sessions (${value.count} shown):`]
        for (const s of value.sessions) lines.push(`- ${s.relPath}${s.size ? ` (${s.size} bytes)` : ''}`)
        if (value.truncated) lines.push('(more available — raise `limit` or use `filter`)')
        if (value.count === 0) lines.push('No sessions found. Check that ~/.claude/projects exists.')
        lines.push('Import one with cc_import using its fileName or relPath.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: any) {
      const all: any[] = []
      for (const p of providers) all.push(...(await p.listSessions()))
      let sessions = all
      if (args && typeof args.filter === 'string' && args.filter.trim()) {
        const f = args.filter.trim().toLowerCase()
        sessions = sessions.filter((s: any) => `${s.projectDir} ${s.fileName} ${s.relPath}`.toLowerCase().includes(f))
      }
      let limit = 100
      if (args && typeof args.limit === 'number' && args.limit > 0) limit = Math.floor(args.limit)
      const truncated = sessions.length > limit
      return { count: Math.min(sessions.length, limit), truncated, sessions: sessions.slice(0, limit) }
    },
  } as any)
  ctx.tools.register(listTool)

  const importTool = defineTool({
    name: 'cc_import',
    description: 'Import one Claude Code conversation (.jsonl) as a resumable DSH session.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session file name or relPath from cc_history_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          eventCount: { type: 'integer' },
          listed: { type: 'boolean' },
          inspectError: { type: 'string' },
          error: { type: 'string' },
          subagentCount: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const text = value.error
          ? `Import failed: ${value.error}`
          : `Imported ${value.sessionId} (${value.eventCount} events). listed=${value.listed}${value.inspectError ? ` inspectError=${value.inspectError}` : ' inspect=OK'}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args: any) {
      const sid = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      if (!sid) return { sessionId: '', eventCount: 0, listed: false, error: 'sessionId is required' }
      // claude-code is the only provider for now; route by provider later.
      return providers[0].importSession(sid)
    },
  } as any)
  ctx.tools.register(importTool)
}
