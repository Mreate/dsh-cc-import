/**
 * CCImport — client half.
 *
 * Registers an additive sidebar footer entry and a frame-wide overlay picker
 * with MULTI-SELECT + batch import, all through the host's `/api/cc-import`
 * HTTP RPC.
 */
import type { Context } from '@deepseek-ai/cordis'
import * as React from 'react'

interface SessionItem {
  provider: string
  fileName: string
  relPath: string
  projectDir: string
  size?: number
  title?: string
}

// Module store coordinating the footer button and the overlay (two separate slots).
let overlayOpen = false
const listeners = new Set<() => void>()
function setOpen(v: boolean) {
  overlayOpen = v
  for (const l of listeners) l()
}
function useOpen(): boolean {
  const [v, setV] = React.useState(overlayOpen)
  React.useEffect(() => {
    const l = () => setV(overlayOpen)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return v
}

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.35)',
  pointerEvents: 'auto',
  zIndex: 1000,
}
const dialogStyle: React.CSSProperties = {
  width: 640,
  maxWidth: '92vw',
  maxHeight: '80vh',
  background: 'var(--color-bg-elevated, #1e1e1e)',
  color: 'var(--color-text, #e6e6e6)',
  borderRadius: 12,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  overflow: 'hidden',
}
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
  cursor: 'pointer', borderRadius: 6,
}
const monoStyle: React.CSSProperties = { fontSize: 12, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const resultStyle: React.CSSProperties = { flex: 'none', maxHeight: 160, overflow: 'auto', background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: 10, fontSize: 12, whiteSpace: 'pre-wrap' }

function FooterButton(props: { wide: boolean }) {
  return React.createElement('button', {
    type: 'button',
    title: '导入 Claude Code 对话',
    onClick: () => setOpen(true),
    style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
  },
    React.createElement('span', null, '🅒'),
    props.wide ? '导入 Claude Code 对话' : null,
  )
}

/**
 * 会话标题行：超过 80 字时截断并追加灰色“… (xx字已折叠)”后缀。
 */
function TitleLine(props: { title?: string; fallback: string }) {
  const t = (props.title || props.fallback).trim()
  if (t.length <= 80) return React.createElement('span', null, t)
  return React.createElement('span', null,
    t.slice(0, 80) + '…',
    React.createElement('span', { style: { color: '#9a9a9a', fontSize: 11, marginLeft: 4 } }, `(${t.length - 80}字已折叠)`),
  )
}

function ImportOverlay(props: { useWorkspaces?: any; useSessions?: any; refreshSessions?: () => Promise<unknown> }) {
  const open = useOpen()
  const [sessions, setSessions] = React.useState<SessionItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [importing, setImporting] = React.useState(false)
  const [results, setResults] = React.useState<string[]>([])

  // 当前工作区路径：优先当前打开会话所在工作区（useSessions.current 的 cwd，
  // 与 DSH 新建会话流程的惯例一致），其次“最近活跃工作区”（recentWorkspaceId）。
  // 注意字段名是 workspaceId（不是 id）——WorkspaceView 的 wire 投影。
  const wsPath: string = typeof props.useWorkspaces === 'function'
    ? props.useWorkspaces((s: any) => {
        const ws = (s?.items || []).find((w: any) => w?.workspaceId === s?.recentWorkspaceId)
        return ws ? ws.path : ''
      })
    : ''
  const sessionCwd: string = typeof props.useSessions === 'function'
    ? props.useSessions((st: any) => {
        const info = st?.current !== undefined ? st?.byId?.[st.current] : undefined
        return info?.cwd ? String(info.cwd) : ''
      })
    : ''
  const cwd: string | undefined = sessionCwd || wsPath || undefined

  React.useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    setSelected(new Set())
    setResults([])
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    fetch(`/api/cc-import/list${q}`)
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions || []))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [open, cwd])

  function toggle(s: SessionItem) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(s.fileName)) next.delete(s.fileName)
      else next.add(s.fileName)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === sessions.length) return new Set()
      return new Set(sessions.map((s) => s.fileName))
    })
  }

  async function importSelected() {
    setImporting(true)
    setError('')
    setResults([])
    const picked = sessions.filter((s) => selected.has(s.fileName))
    const msgs: string[] = []
    for (const s of picked) {
      try {
        const r = await fetch('/api/cc-import/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: s.fileName, cwd }),
        })
        const d = await r.json()
        if (d.error) msgs.push(`✗ ${s.fileName}: ${d.error}`)
        else msgs.push(`✓ ${d.sessionId}（${d.eventCount} 事件${d.subagentCount ? `，${d.subagentCount} 子代理` : ''}${d.attachError ? `，附加失败：${d.attachError}` : ''}）`)
      } catch (e) {
        msgs.push(`✗ ${s.fileName}: ${String(e)}`)
      }
    }
    setResults(msgs)
    setImporting(false)
    if (msgs.length > 0 && !msgs.some((m) => m.startsWith('✗'))) {
      // 全部成功：重拉 session.list 基线，让导入的会话立即出现在侧边栏
      // 当前工作区下（无需刷新浏览器）；然后短暂提示并关闭浮层。
      try { await props.refreshSessions?.() } catch { /* 刷新失败不阻断关闭 */ }
      setTimeout(() => setOpen(false), 1500)
    }
  }

  if (!open) return null
  return React.createElement('div', { style: panelStyle, onClick: () => setOpen(false) },
    React.createElement('div', { style: dialogStyle, onClick: (e: any) => e.stopPropagation() },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
        React.createElement('strong', null, '导入 Claude Code 对话'),
        React.createElement('span', { style: { fontSize: 12, opacity: 0.7, flex: 1, textAlign: 'center' } },
          cwd ? `工作区：${cwd.split(/[\\/]/).pop()}` : '未检测到当前工作区（显示全部）'),
        React.createElement('button', { type: 'button', onClick: () => setOpen(false), style: { cursor: 'pointer' } }, '×'),
      ),
      loading
        ? React.createElement('div', null, '加载中…')
        : React.createElement('div', { style: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
            React.createElement('label', { style: { ...rowStyle, cursor: 'pointer', fontSize: 13, opacity: 0.85 } },
              React.createElement('input', { type: 'checkbox', checked: sessions.length > 0 && selected.size === sessions.length, onChange: toggleAll }),
              React.createElement('span', null, `全选（${selected.size}/${sessions.length}）`),
            ),
            sessions.map((s) => React.createElement('label', { key: s.fileName, style: rowStyle },
              React.createElement('input', { type: 'checkbox', checked: selected.has(s.fileName), onChange: () => toggle(s) }),
              React.createElement('span', null, '🅒'),
              React.createElement('span', { style: { flex: 1, overflow: 'hidden' } },
                React.createElement(TitleLine, { title: s.title, fallback: s.fileName.replace(/\.jsonl$/, '') }),
                React.createElement('div', { style: monoStyle }, s.projectDir),
              ),
              React.createElement('span', { style: monoStyle }, s.size ? `${s.size} B` : ''),
            )),
            sessions.length === 0 ? React.createElement('div', { style: monoStyle }, '未找到 Claude Code 会话（检查 ~/.claude/projects）。') : null,
          ),
      error ? React.createElement('div', { style: { color: '#ff6b6b', fontSize: 13 } }, error) : null,
      results.length > 0 ? React.createElement('div', { style: resultStyle }, results.join('\n')) : null,
      React.createElement('button', {
        type: 'button',
        onClick: importSelected,
        disabled: importing || selected.size === 0,
        style: { cursor: 'pointer', alignSelf: 'flex-end' },
      }, importing ? '导入中…' : `导入选中（${selected.size}）`),
    ),
  )
}

export function apply(ctx: Context) {
  const slots = ctx.get('slots') as any
  if (!slots) return

  // `/init` 等命令的结果在"空白会话"（还没有任何 user/assistant 消息）里不会
  // 渲染命令卡片（DSH 视其为控制面内容，会话停留在空态 hero）。这里监听
  // command/executed，把命令结果用 composer 通知通道显示出来——任何会话状态下
  // 都紧贴输入框可见。
  ctx.on('command/executed', (sessionId: any, name: any, result: any) => {
    if (name !== 'init' || !result || typeof result.text !== 'string') return
    try {
      const sessions = ctx.get('sessions') as any
      const scope = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined
      const conversation = scope?.get?.('conversation')
      if (conversation && typeof conversation?.input?.for === 'function') {
        conversation.input.for(scope).notify(result.kind === 'error' ? 'error' : 'info', result.text)
      }
    } catch { /* 通知失败不影响命令本身 */ }
  })

  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'cc-import-import', order: 10, label: '导入 Claude Code 对话' },
    (props: any) => React.createElement(FooterButton, { wide: !!props.wide }),
  ))

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'cc-import-overlay' },
    (props: any) => React.createElement(ImportOverlay, {
      useWorkspaces: props.useWorkspaces,
      useSessions: props.useSessions,
      // 导入完成后重拉会话基线（SessionRuntime.refresh 未在公开 face 上，经
      // ctx 懒取具体实例调用；失败时静默，会话仍会出现在下次连接基线里）。
      refreshSessions: () => {
        const s = ctx.get('sessions') as any
        if (s && typeof s.refresh === 'function') return Promise.resolve(s.refresh())
        return Promise.resolve()
      },
    }),
  ))
}
