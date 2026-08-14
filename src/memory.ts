/**
 * CLAUDE.md memory loader.
 *
 * Implements Claude Code's memory hierarchy (per the official docs):
 *   1. user      ~/.claude/CLAUDE.md
 *   2. project   <workspace>/CLAUDE.md
 *   3. local     <workspace>/CLAUDE.local.md
 *   4. subdir    CLAUDE.md / CLAUDE.local.md under the workspace tree (bounded)
 *   5. imports   `@path`, `@/path`, `@~/path` inlined recursively
 *
 * Files are emitted in increasing specificity so that later, more-specific
 * instructions override earlier ones when the model reconciles them.
 */
import type { Context } from '@deepseek-ai/cordis'

type FsService = any

export interface MemoryFile {
  path: string
  content: string
}

export interface MemoryLoaderOptions {
  workspaceRoot?: string
  homeDir?: string
  /** Max @import nesting depth. */
  maxImportDepth: number
  /** Max subdirectory recursion depth. */
  maxSubdirDepth: number
  /** Hard cap on collected files. */
  maxFiles: number
}

const SKIP_SCAN: Record<string, 1> = {
  '.git': 1, node_modules: 1, dist: 1, build: 1, out: 1, '.next': 1,
  '.cache': 1, coverage: 1, '.venv': 1, venv: 1, __pycache__: 1, '.idea': 1, '.vscode': 1,
}

export function createMemoryLoader(ctx: Context) {
  const fs = ctx.get('fs') as FsService | undefined

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

  function importRefs(content: string): string[] {
    const refs: string[] = []
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*@(\S+)/)
      if (m) refs.push(m[1])
    }
    return refs
  }

  function dirOf(path: string): string {
    const i = path.replace(/\\/g, '/').lastIndexOf('/')
    return i === -1 ? '.' : path.slice(0, i)
  }

  function resolveImport(ref: string, fileDir: string, opts: MemoryLoaderOptions): string | undefined {
    if (ref.startsWith('@~/')) return opts.homeDir ? `${opts.homeDir}/${ref.slice(3)}` : undefined
    if (ref.startsWith('@/')) return opts.workspaceRoot ? `${opts.workspaceRoot}/${ref.slice(2)}` : undefined
    return `${fileDir}/${ref}`
  }

  async function expandImports(
    content: string,
    fileDir: string,
    opts: MemoryLoaderOptions,
    depth: number,
    seen: Set<string>,
  ): Promise<string> {
    if (depth > opts.maxImportDepth) return content
    const lines = content.split(/\r?\n/)
    const out: string[] = []
    for (const line of lines) {
      const m = line.match(/^\s*@(\S+)/)
      if (!m) { out.push(line); continue }
      const resolved = resolveImport(m[1], fileDir, opts)
      if (!resolved || seen.has(resolved)) { out.push(line); continue }
      seen.add(resolved)
      const imported = await readText(resolved)
      if (imported === undefined) { out.push(line); continue }
      const expanded = await expandImports(imported, dirOf(resolved), opts, depth + 1, seen)
      out.push(`<!-- imported: ${resolved} -->\n${expanded}`)
    }
    return out.join('\n')
  }

  async function collectMdFiles(dirPath: string, depth: number, acc: MemoryFile[], opts: MemoryLoaderOptions, seen: Set<string>): Promise<void> {
    if (depth > opts.maxSubdirDepth || acc.length >= opts.maxFiles) return
    for (const fileName of ['CLAUDE.md', 'CLAUDE.local.md']) {
      const fullPath = `${dirPath}/${fileName}`
      const raw = await readText(fullPath)
      if (raw === undefined) continue
      const content = await expandImports(raw, dirPath, opts, 0, seen)
      acc.push({ path: fullPath, content })
    }
    for (const e of await listDir(dirPath)) {
      if (e.type !== 'directory' || SKIP_SCAN[e.name]) continue
      await collectMdFiles(`${dirPath}/${e.name}`, depth + 1, acc, opts, seen)
    }
  }

  /** Collect memory files in increasing-specificity order and render them. */
  async function load(workspaceRoot?: string): Promise<string> {
    if (!fs) return ''
    const opts: MemoryLoaderOptions = { workspaceRoot, homeDir: undefined, maxImportDepth: 4, maxSubdirDepth: 4, maxFiles: 40 }
    // Home discovery (same strategy as the import provider).
    const homes: string[] = []
    const SKIP_USER: Record<string, 1> = { Public: 1, Default: 1, 'Default User': 1, 'All Users': 1 }
    async function isDir(p: string) { const s = await statPath(p); return !!(s && s.info.type === 'directory') }
    async function probe(base: string, name?: string) { const h = name ? `${base}/${name}` : base; if (await isDir(`${h}/.claude`)) homes.push(h) }
    for (const e of await listDir('C:/Users')) { if (e.type === 'directory' && !SKIP_USER[e.name]) await probe('C:/Users', e.name) }
    for (const base of ['/home', '/Users']) { for (const e of await listDir(base)) { if (e.type === 'directory') await probe(base, e.name) } }
    opts.homeDir = homes[0]

    const acc: MemoryFile[] = []
    const seen = new Set<string>()
    // 1. global user memory
    if (opts.homeDir) {
      const p = `${opts.homeDir}/.claude/CLAUDE.md`
      const raw = await readText(p)
      if (raw !== undefined) acc.push({ path: p, content: await expandImports(raw, `${opts.homeDir}/.claude`, opts, 0, seen) })
    }
    // 2-4. project + local + subdirectories
    if (opts.workspaceRoot) await collectMdFiles(opts.workspaceRoot, 0, acc, opts, seen)

    if (!acc.length) return ''
    const blocks = acc.map((f) => `## ${f.path}\n${f.content}`)
    return `<imported_claude_memory>\n${blocks.join('\n\n')}\n</imported_claude_memory>`
  }

  return { load }
}
