/**
 * 记忆文件加载器（CLAUDE.md + DSH.md）。
 *
 * CLAUDE.md 按 Claude Code 官方文档的 memory 层级实现；DSH.md 是 DeepSeek
 * Harness 的项目记忆文件（`/init` 命令生成），按同一套层级加载：
 *   1. user      ~/.claude/CLAUDE.md   ~/.dsh/DSH.md          （全文）
 *   2. project   <cwd>/CLAUDE.md       <cwd>/DSH.md           （全文）
 *   3. local     <cwd>/CLAUDE.local.md <cwd>/DSH.local.md     （全文）
 *   4. subdir    子目录 CLAUDE.md / CLAUDE.local.md / DSH.md / DSH.local.md
 *                —— 只列路径、不内联全文；模型进入该子树时用 read 工具按需读取。
 *                  （贴近 CC「进入子目录才加载」，同时避免几十个文件撑爆上下文）
 *   5. imports   `@path`, `@/path`, `@~/path` inlined recursively
 *
 * 根目录记忆按“越来越具体”的顺序输出全文：CLAUDE 家族在前、DSH 家族在后，且
 * 每家族内 local > project > user，后加载的更具体指令覆盖先前的冲突。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHomeFinder } from './home'

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
  /** Max subdirectory recursion depth for the on-demand path index. */
  maxSubdirDepth: number
  /** Hard cap on subdirectory memory paths listed in the on-demand index. */
  maxSubdirIndex: number
}

const SKIP_SCAN: Record<string, 1> = {
  '.git': 1, node_modules: 1, dist: 1, build: 1, out: 1, '.next': 1,
  '.cache': 1, coverage: 1, '.venv': 1, venv: 1, __pycache__: 1, '.idea': 1, '.vscode': 1,
}

/** 每个记忆家族要收集的文件名（前者在家族内更优先）。 */
const CLAUDE_FILES = ['CLAUDE.md', 'CLAUDE.local.md'] as const
const DSH_FILES = ['DSH.md', 'DSH.local.md'] as const

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

  /**
   * 收集「根目录」某一记忆家族的文件全文（含 @import 内联）。
   * 根目录 = 会话 cwd（workspaceRoot）；CC 的 project/local 记忆就在这一层。
   * 子目录记忆不在这里内联，由 collectSubdirIndex 只列路径按需读取。
   */
  async function collectRootFiles(dirPath: string, files: readonly string[], acc: MemoryFile[], opts: MemoryLoaderOptions, seen: Set<string>): Promise<void> {
    for (const fileName of files) {
      const fullPath = `${dirPath}/${fileName}`
      const raw = await readText(fullPath)
      if (raw === undefined) continue
      const content = await expandImports(raw, dirPath, opts, 0, seen)
      acc.push({ path: fullPath, content })
    }
  }

  /**
   * 有界扫描子目录，只收集记忆文件路径（不读全文），供模型进入该子树时用
   * read 工具按需读取。这样既保留「子目录记忆」的可发现性，又不把几十个文件
   * 的全文一次性塞进上下文（token/成本负面最小化）。
   */
  async function collectSubdirIndex(dirPath: string, depth: number, files: readonly string[], acc: string[], opts: MemoryLoaderOptions, seen: Set<string>): Promise<void> {
    if (depth > opts.maxSubdirDepth || acc.length >= opts.maxSubdirIndex) return
    for (const e of await listDir(dirPath)) {
      if (acc.length >= opts.maxSubdirIndex) return
      if (e.type !== 'directory' || SKIP_SCAN[e.name]) continue
      const sub = `${dirPath}/${e.name}`
      for (const fileName of files) {
        if (acc.length >= opts.maxSubdirIndex) return
        const fullPath = `${sub}/${fileName}`
        if (seen.has(fullPath)) continue
        const s = await statPath(fullPath)
        if (s && s.info.type === 'file') {
          seen.add(fullPath)
          acc.push(fullPath)
        }
      }
      await collectSubdirIndex(sub, depth + 1, files, acc, opts, seen)
    }
  }

  /** 收集记忆文件（CLAUDE 家族 → DSH 家族，后加载者优先）并渲染。 */
  async function load(workspaceRoot?: string): Promise<string> {
    if (!fs) return ''
    const opts: MemoryLoaderOptions = { workspaceRoot, homeDir: undefined, maxImportDepth: 4, maxSubdirDepth: 4, maxSubdirIndex: 64 }
    // Home discovery：优先环境变量（USERPROFILE / HOME）定位当前用户主目录，
    // 避免多用户机器上命中其他用户的目录；不可用时回退系统用户目录扫描
    // （认 .claude（CC）或 .dsh（本 harness）marker）。
    opts.homeDir = await createHomeFinder(ctx).find(['.claude', '.dsh'])

    const rootAcc: MemoryFile[] = []
    const importSeen = new Set<string>()

    // 1. 全局 user 记忆（CLAUDE 家族，全文）
    if (opts.homeDir) {
      const p = `${opts.homeDir}/.claude/CLAUDE.md`
      const raw = await readText(p)
      if (raw !== undefined) rootAcc.push({ path: p, content: await expandImports(raw, `${opts.homeDir}/.claude`, opts, 0, importSeen) })
    }
    // 2. project + local（CLAUDE 家族，根目录全文）
    if (opts.workspaceRoot) await collectRootFiles(opts.workspaceRoot, CLAUDE_FILES, rootAcc, opts, importSeen)

    // 3. 全局 user 记忆（DSH 家族，本 harness 原生，全文）
    if (opts.homeDir) {
      const p = `${opts.homeDir}/.dsh/DSH.md`
      const raw = await readText(p)
      if (raw !== undefined) rootAcc.push({ path: p, content: await expandImports(raw, `${opts.homeDir}/.dsh`, opts, 0, importSeen) })
    }
    // 4. project + local（DSH 家族，根目录全文，后加载 → 优先级更高）
    if (opts.workspaceRoot) await collectRootFiles(opts.workspaceRoot, DSH_FILES, rootAcc, opts, importSeen)

    // 5. 子目录记忆：只列路径（CLAUDE 家族 → DSH 家族），供模型按需 read。
    const subdirIndex: string[] = []
    const indexSeen = new Set<string>()
    if (opts.workspaceRoot) {
      await collectSubdirIndex(opts.workspaceRoot, 0, CLAUDE_FILES, subdirIndex, opts, indexSeen)
      await collectSubdirIndex(opts.workspaceRoot, 0, DSH_FILES, subdirIndex, opts, indexSeen)
    }

    if (!rootAcc.length && !subdirIndex.length) return ''
    const blocks: string[] = rootAcc.map((f) => `## ${f.path}\n${f.content}`)
    if (subdirIndex.length) {
      blocks.push(
        '## Subdirectory memory (not preloaded — read on demand)\n' +
        'These files live in subdirectories and are NOT inlined to keep the context lean. ' +
        'When working inside a listed directory, read the matching file with the read tool first:\n' +
        subdirIndex.map((p) => `- ${p}`).join('\n'),
      )
    }
    return `<imported_claude_memory>\n${blocks.join('\n\n')}\n</imported_claude_memory>`
  }

  return { load }
}

