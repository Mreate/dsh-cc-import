/**
 * Claude Code import provider.
 *
 * Ports the verified dynamic-plugin synthesis (see imptst-2/pkg-3):
 *   CC `.jsonl` records -> balanced DSH SessionEvent log
 *   -> sessionPersistence.create + append -> resumable session.
 *
 * The service objects are reached through ctx.get and typed loosely here;
 * the real types live in `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-session`,
 * `@deepseek-ai/dsh-llm` — tighten these imports when compiling inside the
 * DSH monorepo.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImportedSessionSummary, ImportProvider, ImportResult } from './provider'

type FsService = any
type SessionPersistenceService = any

/** Parsed intermediate block, before conversion to DSH content blocks. */
interface RawBlock {
  kind: 'text' | 'reasoning' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: unknown
  isError?: boolean
}

interface ParsedRecord {
  role: 'user' | 'assistant'
  blocks: RawBlock[]
  time: number
  model?: string
  usage?: { inputTokens: number; outputTokens: number }
  cwd?: string
}

const SKIP_USER_DIRS: Record<string, 1> = { Public: 1, Default: 1, 'Default User': 1, 'All Users': 1 }

export function createClaudeCodeProvider(ctx: Context): ImportProvider {
  const fs = ctx.get('fs') as FsService | undefined
  const sp = ctx.get('sessionPersistence') as SessionPersistenceService | undefined

  async function statPath(path: string) {
    try {
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      return info ? { target, info } : undefined
    } catch {
      return undefined
    }
  }
  async function readText(path: string): Promise<string | undefined> {
    const s = await statPath(path)
    if (!s || s.info.type !== 'file') return undefined
    try {
      return await fs.readText(s.target)
    } catch {
      return undefined
    }
  }
  async function listDir(path: string) {
    try {
      const s = await statPath(path)
      if (!s || s.info.type !== 'directory') return []
      return await fs.listDir(s.target)
    } catch {
      return []
    }
  }
  async function isDir(path: string): Promise<boolean> {
    const s = await statPath(path)
    return !!(s && s.info.type === 'directory')
  }

  async function discoverHome(): Promise<string | undefined> {
    const homes: string[] = []
    async function probe(base: string, name?: string) {
      const h = name ? `${base}/${name}` : base
      if (await isDir(`${h}/.claude`)) homes.push(h)
    }
    for (const e of await listDir('C:/Users')) {
      if (e.type === 'directory' && !SKIP_USER_DIRS[e.name]) await probe('C:/Users', e.name)
    }
    for (const base of ['/home', '/Users']) {
      for (const e of await listDir(base)) {
        if (e.type === 'directory') await probe(base, e.name)
      }
    }
    return homes.length ? `${homes[0]}/.claude` : undefined
  }

  async function scanSessions(root: string): Promise<ImportedSessionSummary[]> {
    const out: ImportedSessionSummary[] = []
    async function walk(dir: string, rel: string, depth: number): Promise<void> {
      if (depth > 5 || out.length >= 500) return
      for (const e of await listDir(dir)) {
        if (out.length >= 500) return
        if (e.type === 'directory') await walk(`${dir}/${e.name}`, `${rel}/${e.name}`, depth + 1)
        else if (e.type === 'file' && typeof e.name === 'string' && e.name.endsWith('.jsonl')) {
          out.push({
            provider: 'claude-code',
            fileName: e.name,
            relPath: `${rel}/${e.name}`.replace(/^\/+/, ''),
            projectDir: rel.replace(/^\/+/, '') || '.',
            size: typeof e.size === 'number' ? Math.floor(e.size) : 0,
          })
        }
      }
    }
    await walk(`${root}/projects`, '', 0)
    return out
  }

  function contentBlocks(content: unknown): RawBlock[] {
    if (typeof content === 'string') return content.trim() ? [{ kind: 'text', text: content }] : []
    if (!Array.isArray(content)) return []
    const out: RawBlock[] = []
    for (const b of content as any[]) {
      if (typeof b === 'string') { if (b.trim()) out.push({ kind: 'text', text: b }); continue }
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text') out.push({ kind: 'text', text: typeof b.text === 'string' ? b.text : '' })
      else if (b.type === 'thinking') out.push({ kind: 'reasoning', text: typeof b.thinking === 'string' ? b.thinking : '' })
      else if (b.type === 'image') {
        // Image bytes are not restored (attachments.saveImage is async); keep a
        // placeholder so the presence of an image is not silently dropped.
        const mt = typeof b.source?.media_type === 'string' ? b.source.media_type : 'image'
        out.push({ kind: 'text', text: `[image: ${mt}]` })
      }
      else if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: b.id, name: typeof b.name === 'string' ? b.name : 'tool', input: b.input })
      else if (b.type === 'tool_result') {
        let text = ''
        if (typeof b.content === 'string') text = b.content
        else if (Array.isArray(b.content)) text = b.content.map((x: any) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).join('\n')
        out.push({ kind: 'tool_result', id: b.tool_use_id, text, isError: b.is_error === true })
      }
    }
    return out
  }

  function toMs(ts: unknown, fallback: number): number {
    if (typeof ts === 'string') {
      const t = Date.parse(ts)
      if (!Number.isNaN(t)) return t
    }
    return fallback
  }

  /** Recursively drop undefined-valued keys so event data is lossless JSON. */
  function clean(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(clean)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v)) {
        const val = (v as Record<string, unknown>)[k]
        if (val !== undefined) out[k] = clean(val)
      }
      return out
    }
    return v
  }

  function parseRecords(text: string): ParsedRecord[] {
    const records: ParsedRecord[] = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let rec: any
      try { rec = JSON.parse(line) } catch { continue }
      if (!rec || typeof rec !== 'object') continue
      const type = rec.type
      if (type !== 'user' && type !== 'assistant') continue
      const message = rec.message && typeof rec.message === 'object' ? rec.message : {}
      const role: 'user' | 'assistant' = type === 'user' ? 'user' : 'assistant'
      const blocks = contentBlocks(message.content)
      if (!blocks.length) continue
      records.push({
        role,
        blocks,
        time: toMs(rec.timestamp, 0),
        model: message.model,
        usage: message.usage ? { inputTokens: message.usage.input_tokens || 0, outputTokens: message.usage.output_tokens || 0 } : undefined,
        cwd: rec.cwd,
      })
    }
    return records
  }

  /** Synthesize a balanced DSH event log from parsed CC records. */
  function synthesize(records: ParsedRecord[], createdAt: number): any[] {
    const events: any[] = []
    let seq = 0
    function emit(type: string, data: unknown, time: number, surface = false) {
      const ev: any = { type, seq: seq++, time: typeof time === 'number' && time > 0 ? time : createdAt + seq, data: clean(data) }
      if (surface) ev.surfaceOp = 'append'
      events.push(ev)
    }
    let turn = 0
    let step = 0
    let stepOpen = false
    let turnOpen = false
    function openStep(t: number) { step++; stepOpen = true; emit('step/start', { turn, step }, t) }
    function closeStep(t: number) { if (stepOpen) { stepOpen = false; emit('step/end', { turn, step }, t) } }
    function closeTurn(t: number) { closeStep(t); if (turnOpen) { turnOpen = false; emit('turn/end', { turn, reason: { kind: 'success' } }, t) } }

    for (const r of records) {
      const t = r.time
      if (r.role === 'user') {
        if (r.blocks.some((b) => b.kind === 'tool_result')) {
          for (const b of r.blocks) {
            if (b.kind !== 'tool_result') continue
            const trBlock: any = { type: 'tool-result', toolCallId: b.id || 'unknown', content: [{ type: 'text', text: b.text ?? '' }] }
            if (b.isError) trBlock.isError = true
            const data: any = { turn, step, message: { id: `ccmsg-${seq + 1000}`, role: 'user', content: [trBlock], source: { kind: 'tool', callId: b.id || 'unknown' } } }
            if (b.isError) data.error = { name: 'Error', code: 'TOOL_ERROR' }
            emit('tool/result', data, t, true)
          }
          closeStep(t)
          continue
        }
        closeTurn(t)
        turn++
        step = 0
        turnOpen = true
        emit('turn/start', { turn }, t)
        const textBlocks = r.blocks.filter((b) => b.kind === 'text')
        emit('user/message', {
          id: `ccmsg-${seq + 1000}`,
          role: 'user',
          content: textBlocks.length ? textBlocks.map((b) => ({ type: 'text', text: b.text ?? '' })) : [{ type: 'text', text: '' }],
          source: { kind: 'user' },
        }, t, true)
        openStep(t)
      } else {
        if (!stepOpen) openStep(t)
        const content: any[] = []
        const toolUses: { id: string; name: string; args: string }[] = []
        for (const b of r.blocks) {
          if (b.kind === 'text') content.push({ type: 'text', text: b.text ?? '' })
          else if (b.kind === 'reasoning') content.push({ type: 'reasoning', text: b.text ?? '' })
          else if (b.kind === 'tool_use') {
            let args = '{}'
            try { args = JSON.stringify(b.input) } catch { args = '{}' }
            const id = b.id || `call-${seq}`
            content.push({ type: 'tool-call', id, name: b.name ?? 'tool', arguments: args })
            toolUses.push({ id, name: b.name ?? 'tool', args })
          }
        }
        const data: any = { turn, step, message: { id: `ccmsg-${seq + 1000}`, role: 'assistant', content, source: { kind: 'model', provider: 'claude-code', model: r.model || 'unknown' } } }
        if (r.usage) data.usage = r.usage
        emit('assistant/message', data, t, true)
        for (const tu of toolUses) emit('tool/call', { turn, step, callId: tu.id, name: tu.name, arguments: tu.args }, t)
        if (toolUses.length === 0) { closeStep(t); closeTurn(t) }
      }
    }
    closeTurn(createdAt)
    return events
  }

  function recordsToMarkdown(records: ParsedRecord[]): string {
    const parts: string[] = []
    for (const r of records) {
      const role = r.role === 'user' ? 'User' : 'Assistant'
      const body: string[] = []
      for (const b of r.blocks) {
        if (b.kind === 'text' && b.text) body.push(b.text)
        else if (b.kind === 'reasoning') body.push(`<thinking>\n${b.text}\n</thinking>`)
        else if (b.kind === 'tool_use') {
          let input = ''
          try { input = JSON.stringify(b.input) } catch { input = String(b.input) }
          body.push(`[tool_use: ${b.name ?? 'tool'}]${input && input !== '{}' ? `\n${input}` : ''}`)
        } else if (b.kind === 'tool_result') {
          body.push(`[tool_result${b.isError ? ' (error)' : ''}]\n${b.text ?? ''}`)
        }
      }
      parts.push(`### ${role}\n${body.filter(Boolean).join('\n')}`)
    }
    return parts.join('\n\n')
  }

  async function findSession(root: string, sessionId: string) {
    // Only main sessions (exclude sub-agent side-chain files).
    const sessions = (await scanSessions(root)).filter((s) => !s.relPath.includes('/subagents/'))
    return sessions.find((s) => s.fileName === sessionId || s.relPath === sessionId || s.fileName.indexOf(sessionId) === 0 || s.relPath.indexOf(sessionId) !== -1)
  }

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    icon: '🅒',

    discoverDataRoot: () => discoverHome(),

    listSessions: async () => {
      const root = await discoverHome()
      if (!root) return []
      return (await scanSessions(root)).filter((s) => !s.relPath.includes('/subagents/'))
    },

    previewSession: async (sessionId) => {
      if (!fs) return { markdown: 'filesystem service unavailable' }
      const root = await discoverHome()
      if (!root) return { markdown: 'No ~/.claude directory found' }
      const match = await findSession(root, sessionId)
      if (!match) return { markdown: `Session not found: ${sessionId}` }
      const raw = await readText(`${root}/projects/${match.relPath}`)
      if (raw === undefined) return { markdown: `Cannot read ${match.relPath}` }
      const records = parseRecords(raw)
      return { markdown: recordsToMarkdown(records) }
    },

    importSession: async (sessionId) => {
      const empty: ImportResult = { sessionId, eventCount: 0, listed: false }
      if (!fs || !sp) return { ...empty, error: 'fs or sessionPersistence service is unavailable' }
      const root = await discoverHome()
      if (!root) return { ...empty, error: 'No ~/.claude directory found' }
      const all = await scanSessions(root)
      const match = all.find((s) => !s.relPath.includes('/subagents/') && (s.fileName === sessionId || s.relPath === sessionId || s.fileName.indexOf(sessionId) === 0 || s.relPath.indexOf(sessionId) !== -1))
      if (!match) return { ...empty, error: `Session not found: ${sessionId}` }

      async function importOne(m: ImportedSessionSummary, dshId: string, extraMeta: Record<string, unknown>): Promise<ImportResult> {
        // Idempotency: a deterministic id means a re-import returns the existing session.
        try {
          const list = await sp.list()
          if (list.some((h: any) => h.id === dshId)) return { sessionId: dshId, eventCount: 0, listed: true }
        } catch { /* list may be unavailable; fall through to create */ }

        const raw = await readText(`${root}/projects/${m.relPath}`)
        if (raw === undefined) return { sessionId: dshId, eventCount: 0, listed: false, error: `Cannot read ${m.relPath}` }
        const records = parseRecords(raw)
        if (!records.length) return { sessionId: dshId, eventCount: 0, listed: false, error: 'No parseable user/assistant records' }
        const createdAt = records[0].time || Date.now()
        const cwd = records.find((r) => r.cwd)?.cwd
        const meta = { version: 0, id: dshId, createdAt, ...(cwd ? { cwd } : {}), ...extraMeta }
        const events = synthesize(records, createdAt)
        try {
          await sp.create(meta)
          await sp.append(dshId, events)
        } catch (e: any) {
          return { sessionId: dshId, eventCount: events.length, listed: false, error: `write failed: ${e?.message || e}` }
        }
        let listed = false
        try {
          const list = await sp.list()
          listed = list.some((h: any) => h.id === dshId)
        } catch { /* ignore */ }
        let inspectError: string | undefined
        try { await sp.inspect(dshId) } catch (e: any) { inspectError = e?.message || String(e) }
        return { sessionId: dshId, eventCount: events.length, listed, ...(inspectError !== undefined ? { inspectError } : {}) }
      }

      const mainId = `cc-${match.fileName.replace(/\.jsonl$/, '')}`
      const mainResult = await importOne(match, mainId, {})

      // Import sub-agent side-chains as child sessions (parentSession + delegationDepth).
      const mainDir = match.fileName.replace(/\.jsonl$/, '')
      const subPrefix = `${mainDir}/subagents/`
      const subagents = all.filter((s) => s.relPath.startsWith(subPrefix))
      let subagentCount = 0
      for (const sub of subagents) {
        const subId = `cc-${mainDir}-subagent-${sub.fileName.replace(/\.jsonl$/, '')}`
        const r = await importOne(sub, subId, { parentSession: mainId, delegationDepth: 1, origin: 'subagent' })
        if (!r.error && r.listed) subagentCount++
      }
      return { ...mainResult, subagentCount }
    },
  }
}
