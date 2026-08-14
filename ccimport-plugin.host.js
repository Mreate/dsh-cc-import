// CCImport — Claude Code 导入插件（Host 侧，动态 Cordis 原型）
//
// 本文件内容即 cordis_define 的 `code.host` 函数体（返回一个 Cordis Plugin 对象）。
// 当前它以动态插件形式运行（pluginId: ccimp-1, packageId: pkg-1）。
// 若需长期使用，可将同一逻辑迁移到 agent preset / host composition 的 cordis.yml。
//
// 功能：
//   1. 自动扫描并注入 Claude Code 记忆文件：
//        - ~/.claude/CLAUDE.md          （用户级全局记忆）
//        - <workspace>/CLAUDE.md        （项目级共享记忆）
//        - <workspace>/CLAUDE.local.md  （本地个人记忆）
//        - 子目录下的 CLAUDE.md / CLAUDE.local.md（有界深度，跳过 node_modules/.git 等）
//   2. 提供两个只读工具，迁移 Claude Code 对话历史：
//        - cc_history_list：列出 ~/.claude/projects 下可导入的会话（.jsonl）
//        - cc_history_read：读取单个会话并转换为可读 markdown
//
// 已知边界（原型阶段）：
//   - @import 引用解析尚未实现；
//   - 对话导入为“只读历史”路线（转 markdown），尚未映射成可 resume 的 DSH 会话；
//   - 主目录发现采用“扫描 C:/Users、/home、/Users 下含 .claude 的用户目录”策略。

return {
  apply(ctx) {
    const fs = ctx.get('fs')
    const systemPrompt = ctx.get('systemPrompt')
    if (!fs || !systemPrompt) return
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const workspaceRoot = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' ? sandboxPolicy.workspaceRoot : undefined

    async function statPath(path) {
      try {
        const target = await fs.resolve(path)
        const info = await fs.stat(target)
        return info ? { target, info } : undefined
      } catch (e) { return undefined }
    }
    async function readText(path) {
      const s = await statPath(path)
      if (!s || s.info.type !== 'file') return undefined
      try { return await fs.readText(s.target) } catch (e) { return undefined }
    }
    async function listDir(path) {
      try {
        const s = await statPath(path)
        if (!s || s.info.type !== 'directory') return []
        return await fs.listDir(s.target)
      } catch (e) { return [] }
    }
    async function isDir(path) {
      const s = await statPath(path)
      return !!(s && s.info.type === 'directory')
    }

    const SKIP_USER_DIRS = { Public: 1, Default: 1, 'Default User': 1, 'All Users': 1 }
    async function discoverHomes() {
      const homes = []
      async function probe(base, name) {
        const home = name ? base + '/' + name : base
        if (await isDir(home + '/.claude')) homes.push(home)
      }
      for (const e of await listDir('C:/Users')) {
        if (e.type === 'directory' && !SKIP_USER_DIRS[e.name]) await probe('C:/Users', e.name)
      }
      for (const base of ['/home', '/Users']) {
        for (const e of await listDir(base)) {
          if (e.type === 'directory') await probe(base, e.name)
        }
      }
      return homes
    }
    async function claudeRoot() {
      const homes = await discoverHomes()
      return homes.length ? homes[0] + '/.claude' : undefined
    }

    const SKIP_SCAN = { '.git': 1, node_modules: 1, dist: 1, build: 1, out: 1, '.next': 1, '.cache': 1, coverage: 1, '.venv': 1, venv: 1, __pycache__: 1, '.idea': 1, '.vscode': 1 }
    async function collectMdFiles(dirPath, depth, acc) {
      if (depth > 4 || acc.length > 40) return
      for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
        const content = await readText(dirPath + '/' + name)
        if (content) acc.push({ path: dirPath + '/' + name, content })
      }
      for (const e of await listDir(dirPath)) {
        if (e.type !== 'directory' || SKIP_SCAN[e.name]) continue
        await collectMdFiles(dirPath + '/' + e.name, depth + 1, acc)
      }
    }
    async function buildMemoryText() {
      const acc = []
      const root = await claudeRoot()
      if (root) {
        const g = await readText(root + '/CLAUDE.md')
        if (g) acc.push({ path: root + '/CLAUDE.md', content: g })
      }
      if (workspaceRoot) await collectMdFiles(workspaceRoot, 0, acc)
      if (!acc.length) return ''
      const blocks = acc.map((f) => '## ' + f.path + '\n' + f.content)
      return '<imported_claude_memory>\n' + blocks.join('\n\n') + '\n</imported_claude_memory>'
    }

    let memoryText = ''
    ctx.effect(() => {
      let cancelled = false
      buildMemoryText().then((t) => { if (!cancelled) memoryText = t }).catch(() => {})
      return () => { cancelled = true }
    })
    systemPrompt.section({ name: 'ccimport:claude-md', order: 50, text: () => memoryText })

    async function scanSessions(claudeRootPath) {
      const sessions = []
      async function walk(dirPath, relDir, depth) {
        if (depth > 5 || sessions.length >= 500) return
        for (const e of await listDir(dirPath)) {
          if (sessions.length >= 500) return
          if (e.type === 'directory') await walk(dirPath + '/' + e.name, relDir + '/' + e.name, depth + 1)
          else if (e.type === 'file' && typeof e.name === 'string' && e.name.endsWith('.jsonl')) {
            sessions.push({
              fileName: e.name,
              projectDir: relDir.replace(/^\/+/, '') || '.',
              relPath: (relDir + '/' + e.name).replace(/^\/+/, ''),
              size: typeof e.size === 'number' ? Math.floor(e.size) : 0,
            })
          }
        }
      }
      await walk(claudeRootPath + '/projects', '', 0)
      return sessions
    }

    function contentBlocks(content) {
      if (typeof content === 'string') return content.trim() ? [{ kind: 'text', text: content }] : []
      if (!Array.isArray(content)) return []
      const out = []
      for (const b of content) {
        if (typeof b === 'string') { if (b.trim()) out.push({ kind: 'text', text: b }); continue }
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text') out.push({ kind: 'text', text: typeof b.text === 'string' ? b.text : '' })
        else if (b.type === 'thinking') out.push({ kind: 'thinking', text: typeof b.thinking === 'string' ? b.thinking : '' })
        else if (b.type === 'tool_use') out.push({ kind: 'tool_use', name: typeof b.name === 'string' ? b.name : 'tool', input: b.input })
        else if (b.type === 'tool_result') {
          let text = ''
          if (typeof b.content === 'string') text = b.content
          else if (Array.isArray(b.content)) text = b.content.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).join('\n')
          else if (b.content && typeof b.content === 'object' && typeof b.content.text === 'string') text = b.content.text
          out.push({ kind: 'tool_result', text: text, isError: b.is_error === true })
        }
      }
      return out
    }

    function jsonlToMarkdown(text, maxMessages) {
      const lines = String(text).split(/\r?\n/)
      const parts = []
      let count = 0
      let truncated = false
      for (const line of lines) {
        if (!line.trim()) continue
        let rec
        try { rec = JSON.parse(line) } catch (e) { continue }
        if (!rec || typeof rec !== 'object') continue
        if (rec.type === 'summary' || rec.type === 'system') continue
        const message = rec.message && typeof rec.message === 'object' ? rec.message : {}
        const role = typeof message.role === 'string' ? message.role : (typeof rec.type === 'string' ? rec.type : 'unknown')
        const blocks = contentBlocks(message.content)
        if (!blocks.length) continue
        count++
        if (maxMessages && count > maxMessages) { truncated = true; break }
        const ts = typeof rec.timestamp === 'string' ? rec.timestamp.slice(0, 19).replace('T', ' ') : ''
        let header = '### ' + (role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : role)
        if (ts) header += ' — ' + ts
        const body = []
        for (const b of blocks) {
          if (b.kind === 'text') { if (b.text) body.push(b.text) }
          else if (b.kind === 'thinking') body.push('<thinking>\n' + b.text + '\n</thinking>')
          else if (b.kind === 'tool_use') {
            let input = ''
            try { input = JSON.stringify(b.input) } catch (e) { input = String(b.input) }
            body.push('[tool_use: ' + (b.name || 'unknown') + ']' + (input && input !== '{}' ? '\n' + input : ''))
          } else if (b.kind === 'tool_result') {
            body.push('[tool_result' + (b.isError ? ' (error)' : '') + ']\n' + b.text)
          }
        }
        parts.push(header + '\n' + body.filter((x) => x).join('\n'))
      }
      return { markdown: parts.join('\n\n'), count: count, truncated: truncated }
    }

    const listTool = harness.defineTool({
      name: 'cc_history_list',
      description: 'List Claude Code conversation sessions available under ~/.claude/projects (read-only import view).',
      parameters: {
        limit: { type: 'integer', description: 'Maximum sessions to return (default 100).' },
        filter: { type: 'string', description: 'Optional case-insensitive substring to match against the project directory or file name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claudeRoot: { type: 'string' },
            count: { type: 'integer' },
            truncated: { type: 'boolean' },
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  fileName: { type: 'string' },
                  projectDir: { type: 'string' },
                  relPath: { type: 'string' },
                  size: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (args, value) => {
          const lines = ['Claude Code sessions' + (value.claudeRoot ? ' under ' + value.claudeRoot : '') + ' (' + value.count + ' shown):']
          for (const s of value.sessions) lines.push('- ' + s.relPath + (s.size ? ' (' + s.size + ' bytes)' : ''))
          if (value.truncated) lines.push('(more sessions available — raise `limit` or use `filter`)')
          if (value.count === 0) lines.push('No sessions found. If you have used Claude Code, check that ~/.claude/projects exists.')
          lines.push('Read one session with cc_history_read using its fileName or relPath.')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const root = await claudeRoot()
        if (!root) return { claudeRoot: '', count: 0, truncated: false, sessions: [] }
        let sessions = await scanSessions(root)
        if (args && typeof args.filter === 'string' && args.filter.trim()) {
          const f = args.filter.trim().toLowerCase()
          sessions = sessions.filter((s) => (s.projectDir + ' ' + s.fileName + ' ' + s.relPath).toLowerCase().indexOf(f) !== -1)
        }
        let limit = 100
        if (args && typeof args.limit === 'number' && args.limit > 0) limit = Math.floor(args.limit)
        const truncated = sessions.length > limit
        return { claudeRoot: root, count: Math.min(sessions.length, limit), truncated: truncated, sessions: sessions.slice(0, limit) }
      },
    })
    harness.registerTool(ctx, listTool)

    const readTool = harness.defineTool({
      name: 'cc_history_read',
      description: 'Read one Claude Code conversation (.jsonl) and convert it to readable markdown (read-only).',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'Session file name or relPath, e.g. "abc123.jsonl" (from cc_history_list).' },
        maxMessages: { type: 'integer', description: 'Maximum number of messages to convert (default: no truncation).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            messageCount: { type: 'integer' },
            truncated: { type: 'boolean' },
            markdown: { type: 'string' },
          },
        },
        render: (args, value) => [{ type: 'text', text: value.markdown }],
      },
      async execute(args) {
        const root = await claudeRoot()
        const sid = args && typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        if (!root) return { sessionId: sid, messageCount: 0, truncated: false, markdown: 'No Claude Code data directory found under the user home (~/.claude).' }
        if (!sid) return { sessionId: '', messageCount: 0, truncated: false, markdown: 'sessionId is required — run cc_history_list first.' }
        const sessions = await scanSessions(root)
        const match = sessions.find((s) => s.fileName === sid || s.relPath === sid || s.fileName.indexOf(sid) === 0 || (s.relPath.indexOf(sid) !== -1))
        if (!match) return { sessionId: sid, messageCount: 0, truncated: false, markdown: 'Session not found: ' + sid }
        const raw = await readText(root + '/projects/' + match.relPath)
        if (raw === undefined) return { sessionId: sid, messageCount: 0, truncated: false, markdown: 'Could not read session file: ' + match.relPath }
        let maxMessages = 0
        if (args && typeof args.maxMessages === 'number' && args.maxMessages > 0) maxMessages = Math.floor(args.maxMessages)
        const converted = jsonlToMarkdown(raw, maxMessages)
        return { sessionId: match.fileName, messageCount: converted.count, truncated: converted.truncated, markdown: converted.markdown }
      },
    })
    harness.registerTool(ctx, readTool)
  },
}
