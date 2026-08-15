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
import { createHomeFinder } from '../home'
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

/**
 * 按 sessionId 匹配会话：精确匹配优先（fileName / relPath / 去 .jsonl 的
 * fileName），再放宽到 fileName 前缀与 relPath 尾缀（CC id 前缀用法）。
 * 不做宽松子串匹配，避免 sessionId 命中无关路径。
 */
function matchSession(sessions: ImportedSessionSummary[], sessionId: string): ImportedSessionSummary | undefined {
  const sid = (sessionId || '').trim()
  if (!sid) return undefined
  const byFile = sessions.find((s) => s.fileName === sid)
  if (byFile) return byFile
  const byRel = sessions.find((s) => s.relPath === sid)
  if (byRel) return byRel
  const byBase = sessions.find((s) => s.fileName.replace(/\.jsonl$/, '') === sid)
  if (byBase) return byBase
  const byPrefix = sessions.find((s) => s.fileName.startsWith(sid) && s.fileName.length > sid.length)
  if (byPrefix) return byPrefix
  const bySuffix = sessions.find((s) => s.relPath.endsWith(`/${sid}.jsonl`))
  if (bySuffix) return bySuffix
  return undefined
}

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
  async function discoverHome(): Promise<string | undefined> {
    // 优先环境变量（USERPROFILE / HOME）定位当前用户主目录，再回退系统用户
    // 目录扫描（marker: .claude）；返回 .claude 数据目录本身。
    const home = await createHomeFinder(ctx).find(['.claude'])
    return home ? `${home}/.claude` : undefined
  }

  async function readHead(target: any, maxBytes = 16384): Promise<string> {
    try {
      const stream = await fs.streamText(target)
      let text = ''
      for await (const chunk of stream) {
        text += chunk
        if (text.length >= maxBytes) break
      }
      return text.slice(0, maxBytes)
    } catch {
      return ''
    }
  }

  function extractHeadInfo(text: string): { title?: string; cwd?: string; createdAt?: number } {
    let title: string | undefined
    let cwd: string | undefined
    let createdAt: number | undefined
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let rec: any
      try { rec = JSON.parse(line) } catch { continue }
      if (!rec || typeof rec !== 'object') continue
      if (cwd === undefined && typeof rec.cwd === 'string') cwd = rec.cwd
      if (createdAt === undefined && typeof rec.timestamp === 'string') {
        const t = Date.parse(rec.timestamp)
        if (!Number.isNaN(t)) createdAt = t
      }
      if (title === undefined && rec.isMeta !== true) {
        if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') title = rec.aiTitle.trim()
        else if (rec.type === 'user') {
          const content = rec.message && typeof rec.message === 'object' ? rec.message.content : undefined
          const realText = (t: string) => (t.trim() && !t.trimStart().startsWith('<') ? t.trim().slice(0, 200) : undefined)
          if (typeof content === 'string') {
            const t = realText(content)
            if (t) title = t
          } else if (Array.isArray(content)) {
            for (const b of content) {
              if (b && b.type === 'text' && typeof b.text === 'string') {
                const t = realText(b.text)
                if (t) { title = t; break }
              }
            }
          }
        }
      }
      if (title !== undefined && cwd !== undefined && createdAt !== undefined) break
    }
    return { title, cwd, createdAt }
  }

  async function scanSessions(root: string): Promise<ImportedSessionSummary[]> {
    const out: ImportedSessionSummary[] = []
    async function walk(dir: string, rel: string, depth: number): Promise<void> {
      if (depth > 5 || out.length >= 500) return
      for (const e of await listDir(dir)) {
        if (out.length >= 500) return
        if (e.type === 'directory') await walk(`${dir}/${e.name}`, `${rel}/${e.name}`, depth + 1)
        else if (e.type === 'file' && typeof e.name === 'string' && e.name.endsWith('.jsonl')) {
          const info = extractHeadInfo(await readHead(e.target))
          out.push({
            provider: 'claude-code',
            fileName: e.name,
            relPath: `${rel}/${e.name}`.replace(/^\/+/, ''),
            projectDir: rel.replace(/^\/+/, '') || '.',
            size: typeof e.size === 'number' ? Math.floor(e.size) : 0,
            ...(info.title !== undefined ? { title: info.title } : {}),
            ...(info.cwd !== undefined ? { cwd: info.cwd } : {}),
            ...(info.createdAt !== undefined ? { createdAt: info.createdAt } : {}),
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

    // CC 会把一次模型回复拆成多条 assistant 记录（thinking、text、多个
    // tool_use 分条发送）。若逐条生成 assistant/message，连续多条带
    // tool-call 的消息会让 provider 拒绝请求（OpenAI/DeepSeek 要求
    // assistant(tool_calls) 后必须紧跟响应其全部 id 的 tool 消息）。
    // 因此把连续出现的 assistant 记录合并为一条 assistant/message。
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
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
        // 合并连续 assistant 记录：一次模型回复 = 一条 assistant/message。
        let end = i
        while (end + 1 < records.length && records[end + 1].role === 'assistant') end++
        const content: any[] = []
        const toolUses: { id: string; name: string; args: string }[] = []
        let model: string | undefined
        let usage: { inputTokens: number; outputTokens: number } | undefined
        for (let k = i; k <= end; k++) {
          for (const b of records[k].blocks) {
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
          if (records[k].model) model = records[k].model
          if (records[k].usage) usage = records[k].usage
        }
        i = end
        const data: any = { turn, step, message: { id: `ccmsg-${seq + 1000}`, role: 'assistant', content, source: { kind: 'model', provider: 'claude-code', model: model || 'unknown' } } }
        if (usage) data.usage = usage
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
    return matchSession(sessions, sessionId)
  }

  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    icon: '🅒',

    discoverDataRoot: () => discoverHome(),

    listSessions: async (cwd?: string) => {
      const root = await discoverHome()
      if (!root) return []
      const all = (await scanSessions(root)).filter((s) => !s.relPath.includes('/subagents/'))
      if (!cwd) return all
      // Windows 上大小写与分隔符都可能与工作区规范路径不一致，做容错比较。
      const norm = (p: string) => p.replace(/[\\/]/g, '\\').toLowerCase()
      const target = norm(cwd)
      return all.filter((s) => s.cwd !== undefined && norm(s.cwd) === target)
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

    importSession: async (sessionId, cwd?: string) => {
      const empty: ImportResult = { sessionId, eventCount: 0, listed: false }
      if (!fs || !sp) return { ...empty, error: 'fs or sessionPersistence service is unavailable' }
      const root = await discoverHome()
      if (!root) return { ...empty, error: 'No ~/.claude directory found' }
      const all = await scanSessions(root)
      const match = matchSession(all.filter((s) => !s.relPath.includes('/subagents/')), sessionId)
      if (!match) return { ...empty, error: `Session not found: ${sessionId}` }

      /** 把会话附加到目标工作区（workspaceRegistry 归属）。 */
      async function attachToWorkspace(dshId: string, cwd?: string): Promise<{ attachError?: string }> {
        if (!cwd) return {}
        try {
          const wsr = ctx.get('workspaceRegistry') as any
          if (wsr && typeof wsr.create === 'function') {
            const ws = await wsr.create(cwd)
            if (ws && typeof ws.attachSession === 'function') await ws.attachSession(dshId)
          }
        } catch (e: any) {
          return { attachError: e?.message || String(e) }
        }
        return {}
      }

      /**
       * 读取 DSH 的全局归档集合（workspaceRegistry.archivedSessionIds）。
       * DSH 归档只是把会话 id 记入该集合并从侧边栏视图隐藏，持久化日志
       * 与 sessionPersistence 都保留——所以仅靠 sp.list() 无法区分"活跃"与
       * "已归档"，必须查这个集合。registry 不可用时视为无归档。
       */
      async function archivedIds(): Promise<Set<string>> {
        try {
          const wsr = ctx.get('workspaceRegistry') as any
          const ids = wsr?.archivedSessionIds
          if (Array.isArray(ids)) return new Set(ids as string[])
        } catch { /* registry 不可用 → 无归档 */ }
        return new Set()
      }

      /** 为重新导入分配一个未被占用（含归档集）的 `-reimport-N` id。 */
      function nextFreeId(base: string, taken: Set<string>, archived: Set<string>): string {
        let n = 1
        for (;;) {
          const candidate = `${base}-reimport-${n}`
          if (!taken.has(candidate) && !archived.has(candidate)) return candidate
          n++
        }
      }

      async function importOne(m: ImportedSessionSummary, preferredId: string, extraMeta: Record<string, unknown>, cwdOverride?: string, attach = false, archived: Set<string> = new Set()): Promise<ImportResult> {
        // 幂等 + 归档重导：确定性 id 已存在于持久化里时——
        //   · 会话仍活跃（未归档）→ 直接返回已有会话（仍补一次工作区附加）；
        //   · 会话已被归档      → 重新导入为全新会话（`-reimport-N` 新 id），
        //     旧归档会话与其日志保持原样不动。
        let dshId = preferredId
        let reimported = false
        try {
          const list = await sp.list()
          const taken = new Set(list.map((h: any) => h.id))
          if (taken.has(dshId)) {
            if (archived.has(dshId)) {
              dshId = nextFreeId(preferredId, taken, archived)
              reimported = true
            } else {
              const result: ImportResult = { sessionId: dshId, eventCount: 0, listed: true, reimported: false }
              if (attach) {
                const att = await attachToWorkspace(dshId, cwdOverride)
                if (att.attachError) result.attachError = att.attachError
              }
              return result
            }
          }
        } catch { /* list may be unavailable; fall through to create */ }

        const raw = await readText(`${root}/projects/${m.relPath}`)
        if (raw === undefined) return { sessionId: dshId, eventCount: 0, listed: false, error: `Cannot read ${m.relPath}` }
        const records = parseRecords(raw)
        if (!records.length) return { sessionId: dshId, eventCount: 0, listed: false, error: 'No parseable user/assistant records' }
        const createdAt = records[0].time || Date.now()
        const cwd = cwdOverride ?? records.find((r) => r.cwd)?.cwd
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
        const result: ImportResult = { sessionId: dshId, eventCount: events.length, listed, reimported, ...(inspectError !== undefined ? { inspectError } : {}) }
        if (attach) {
          const att = await attachToWorkspace(dshId, cwd)
          if (att.attachError) result.attachError = att.attachError
        }
        return result
      }

      const archived = await archivedIds()
      // 主会话：优先确定性 id（cc-<源文件名>）；若已被归档则重新导入为 `-reimport-N`。
      const mainResult = await importOne(match, `cc-${match.fileName.replace(/\.jsonl$/, '')}`, {}, cwd, true, archived)
      const mainId = mainResult.sessionId

      // 子代理侧链：以主会话实际 id 派生（重新导入时同步换新 id），
      // parentSession 指向重新导入后的主会话 id。
      const mainBase = mainId.replace(/^cc-/, '')
      const subPrefix = `${match.fileName.replace(/\.jsonl$/, '')}/subagents/`
      const subagents = all.filter((s) => s.relPath.startsWith(subPrefix))
      let subagentCount = 0
      for (const sub of subagents) {
        const subId = `cc-${mainBase}-subagent-${sub.fileName.replace(/\.jsonl$/, '')}`
        const r = await importOne(sub, subId, { parentSession: mainId, delegationDepth: 1, origin: 'subagent' }, cwd, false, archived)
        if (!r.error && r.listed) subagentCount++
      }
      return { ...mainResult, subagentCount }
    },
  }
}
