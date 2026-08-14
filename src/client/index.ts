/**
 * CCImport — client half.
 *
 * Registers an additive sidebar footer entry and a frame-wide overlay picker.
 * The picker lists Claude Code sessions, shows a read-only preview, and imports
 * one into a resumable DSH session — all through the host's `/api/ccimport`
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
const preStyle: React.CSSProperties = { flex: 1, overflow: 'auto', background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: 10, fontSize: 12, whiteSpace: 'pre-wrap' }

function FooterButton(props: { wide: boolean }) {
  return React.createElement('button', {
    type: 'button',
    title: '导入 Claude Code 对话',
    onClick: () => setOpen(true),
    style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
  },
    React.createElement('span', null, '🅒'),
    props.wide ? '导入 Claude Code' : null,
  )
}

function ImportOverlay() {
  const open = useOpen()
  const [sessions, setSessions] = React.useState<SessionItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState<SessionItem | null>(null)
  const [preview, setPreview] = React.useState('')
  const [importMsg, setImportMsg] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    setSelected(null)
    setPreview('')
    setImportMsg('')
    fetch('/api/ccimport/list')
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions || []))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [open])

  function onSelect(s: SessionItem) {
    setSelected(s)
    setPreview('')
    setImportMsg('')
    fetch(`/api/ccimport/preview?sessionId=${encodeURIComponent(s.fileName)}`)
      .then((r) => r.json())
      .then((d) => setPreview(d.markdown || '(empty)'))
      .catch((e) => setPreview(`preview failed: ${e}`))
  }

  function onImport(s: SessionItem) {
    setError('')
    setImportMsg('')
    fetch('/api/ccimport/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.fileName }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error)
        else setImportMsg(`已导入会话 ${d.sessionId}（${d.eventCount} 事件），现在可在对话列表中打开。`)
      })
      .catch((e) => setError(String(e)))
  }

  if (!open) return null
  return React.createElement('div', { style: panelStyle, onClick: () => setOpen(false) },
    React.createElement('div', { style: dialogStyle, onClick: (e: any) => e.stopPropagation() },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        React.createElement('strong', null, '导入 Claude Code 对话'),
        React.createElement('button', { type: 'button', onClick: () => setOpen(false), style: { cursor: 'pointer' } }, '×'),
      ),
      loading
        ? React.createElement('div', null, '加载中…')
        : React.createElement('div', { style: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
            sessions.map((s) => React.createElement('div', {
              key: s.fileName,
              style: { ...rowStyle, background: selected && selected.fileName === s.fileName ? 'rgba(255,255,255,0.08)' : undefined },
              onClick: () => onSelect(s),
            },
              React.createElement('span', null, '🅒'),
              React.createElement('span', { style: { flex: 1, overflow: 'hidden' } },
                React.createElement('div', null, s.fileName.replace(/\.jsonl$/, '')),
                React.createElement('div', { style: monoStyle }, s.projectDir),
              ),
              React.createElement('span', { style: monoStyle }, s.size ? `${s.size} B` : ''),
            )),
            sessions.length === 0 ? React.createElement('div', { style: monoStyle }, '未找到 Claude Code 会话（检查 ~/.claude/projects）。') : null,
          ),
      error ? React.createElement('div', { style: { color: '#ff6b6b', fontSize: 13 } }, error) : null,
      importMsg ? React.createElement('div', { style: { color: '#7bd88f', fontSize: 13 } }, importMsg) : null,
      selected
        ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            React.createElement('div', { style: preStyle }, preview || '加载预览…'),
            React.createElement('button', { type: 'button', onClick: () => onImport(selected), style: { cursor: 'pointer', alignSelf: 'flex-end' } }, '导入此对话'),
          )
        : null,
    ),
  )
}

export function apply(ctx: Context) {
  const slots = ctx.get('slots') as any
  if (!slots) return

  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'ccimport-import', order: 10, label: '导入 Claude Code' },
    (props: any) => React.createElement(FooterButton, { wide: !!props.wide }),
  ))

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'ccimport-overlay' },
    () => React.createElement(ImportOverlay),
  ))
}
