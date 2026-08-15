/**
 * 用户主目录定位工具（memory.ts 与 import/claude-code.ts 共用）。
 *
 * 原来的实现只扫描系统用户目录（C:/Users、/home、/Users）并按 marker 目录
 * （.claude / .dsh）猜 home：在多用户机器上可能命中其他用户的目录，导致
 * 记忆加载或会话导入指向错误的数据。这里改为：
 *   1. 优先读环境变量 USERPROFILE / HOME，直接拿到当前用户的主目录（无需
 *      marker 命中——它就是进程所属用户的家目录，数据存在与否由调用方判断）；
 *   2. 环境变量不可用（或指向的目录不存在）时，回退到系统用户目录扫描，
 *      命中任一 marker 目录才认为该目录是目标 home。
 */
import type { Context } from '@deepseek-ai/cordis'

type FsService = any

/** 安全读取环境变量（host 半运行在 Node 进程里，仍做防御性判断）。 */
function env(name: string): string | undefined {
  try {
    const e = typeof process !== 'undefined' && process.env ? process.env : {}
    return e[name]
  } catch {
    return undefined
  }
}

export function createHomeFinder(ctx: Context) {
  const fs = ctx.get('fs') as FsService | undefined

  async function isDir(p: string): Promise<boolean> {
    if (!fs) return false
    try {
      const target = await fs.resolve(p)
      const info = await fs.stat(target)
      return !!(info && info.type === 'directory')
    } catch {
      return false
    }
  }

  async function listDir(p: string): Promise<any[]> {
    if (!fs) return []
    try {
      const target = await fs.resolve(p)
      const info = await fs.stat(target)
      if (!info || info.type !== 'directory') return []
      return await fs.listDir(target)
    } catch {
      return []
    }
  }

  /** 环境变量候选（去重、去尾部分隔符、保留顺序：Windows 优先 USERPROFILE）。 */
  function envCandidates(): string[] {
    const out: string[] = []
    for (const name of ['USERPROFILE', 'HOME']) {
      const v = env(name)
      if (v && !out.includes(v)) out.push(v.replace(/[\\/]+$/, ''))
    }
    return out
  }

  /**
   * 定位用户主目录。
   * @param markers 回退扫描时用于识别 home 的目录名（如 ['.claude', '.dsh']）。
   */
  async function find(markers: readonly string[]): Promise<string | undefined> {
    for (const home of envCandidates()) {
      if (await isDir(home)) return home
    }

    const found: string[] = []
    const SKIP: Record<string, 1> = { Public: 1, Default: 1, 'Default User': 1, 'All Users': 1 }
    async function probe(base: string, name?: string) {
      const h = name ? `${base}/${name}` : base
      for (const m of markers) {
        if (await isDir(`${h}/${m}`)) {
          found.push(h)
          return
        }
      }
    }
    for (const e of await listDir('C:/Users')) {
      if (e.type === 'directory' && !SKIP[e.name]) await probe('C:/Users', e.name)
    }
    for (const base of ['/home', '/Users']) {
      for (const e of await listDir(base)) {
        if (e.type === 'directory') await probe(base, e.name)
      }
    }
    return found[0]
  }

  return { find }
}
