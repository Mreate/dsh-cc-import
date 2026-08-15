/**
 * Host-side HTTP RPC for the client picker.
 *
 * The idiomatic DSH "Remote" (typert) mechanism is build-time coupled: the
 * client imports generated `/remote` artifacts. For a third-party plugin we
 * instead register ordinary HTTP routes on the browser carrier (`webServer`)
 * and let the client half call them with `fetch` — decoupled and simple.
 *
 * Endpoints (all under the `/api/cc-import` prefix):
 *   GET  /api/cc-import/list                 -> { sessions: ImportedSessionSummary[] }
 *   GET  /api/cc-import/preview?sessionId=&provider= -> { markdown: string }  (read-only)
 *   POST /api/cc-import/import               -> ImportResult           (body: { sessionId, cwd?, provider? })
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImportProvider } from './import/provider'

type Req = any
type Res = any

/** 请求体大小上限（导入请求体只有 sessionId/cwd/provider，1 MiB 足够防御异常请求）。 */
const MAX_BODY_BYTES = 1024 * 1024

function sendJson(res: Res, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(body)
}

function readBody(req: Req, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let overflow = false
    req.on('data', (c: string) => {
      if (overflow) return
      data += c
      if (data.length > maxBytes) {
        overflow = true
        // 停止消费请求体，立即以 413 响应，避免异常请求拖垮连接。
        req.pause()
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
      }
    })
    req.on('end', () => { if (!overflow) resolve(data) })
    req.on('error', reject)
  })
}

/** 选 provider：显式 id 优先，缺省取第一个注册的 provider。 */
function pickProvider(providers: ImportProvider[], id?: string): ImportProvider | undefined {
  if (id) return providers.find((p) => p.id === id)
  return providers[0]
}

export function registerRpcRoutes(ctx: any, providers: ImportProvider[]): void {
  const webServer = ctx.webServer
  if (!webServer) {
    console.error('[ccimport] webServer service unavailable — HTTP RPC routes not registered')
    return
  }

  // 路由注册放进 ctx.effect：register 的返回值作为 fiber 清理函数，
  // 插件 stop/update/卸载时自动移除。
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/cc-import',
    handler: async (req: Req, res: Res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const path = url.pathname
      try {
        if (path === '/api/cc-import/list') {
          const cwd = url.searchParams.get('cwd') || undefined
          const sessions: unknown[] = []
          for (const p of providers) sessions.push(...(await p.listSessions(cwd)))
          sendJson(res, 200, { sessions })
          return
        }
        if (path === '/api/cc-import/preview') {
          const provider = pickProvider(providers, url.searchParams.get('provider') || undefined)
          if (!provider) return sendJson(res, 503, { error: 'no import provider registered' })
          const sessionId = url.searchParams.get('sessionId') || ''
          const result = await provider.previewSession(sessionId)
          sendJson(res, 200, result)
          return
        }
        if (path === '/api/cc-import/import' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const provider = pickProvider(providers, typeof body.provider === 'string' ? body.provider : undefined)
          if (!provider) return sendJson(res, 503, { error: 'no import provider registered' })
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const cwd = typeof body.cwd === 'string' ? body.cwd : undefined
          const result = await provider.importSession(sessionId, cwd)
          sendJson(res, result.error ? 500 : 200, result)
          return
        }
        sendJson(res, 404, { error: 'not found' })
      } catch (e: any) {
        sendJson(res, e?.statusCode || 500, { error: e?.message || String(e) })
      }
    },
  }))
}
