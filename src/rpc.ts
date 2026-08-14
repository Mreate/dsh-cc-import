/**
 * Host-side HTTP RPC for the client picker.
 *
 * The idiomatic DSH "Remote" (typert) mechanism is build-time coupled: the
 * client imports generated `/remote` artifacts. For a third-party plugin we
 * instead register ordinary HTTP routes on the browser carrier (`webServer`)
 * and let the client half call them with `fetch` — decoupled and simple.
 *
 * Endpoints (all under the `/api/ccimport` prefix):
 *   GET  /api/ccimport/list               -> { sessions: ImportedSessionSummary[] }
 *   GET  /api/ccimport/preview?sessionId= -> { markdown: string }   (read-only)
 *   POST /api/ccimport/import             -> ImportResult           (body: { sessionId })
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImportProvider } from './import/provider'

type Req = any
type Res = any

function sendJson(res: Res, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(body)
}

function readBody(req: Req): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c: string) => { data += c })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function registerRpcRoutes(ctx: Context, providers: ImportProvider[]): void {
  const webServer = ctx.get('webServer') as any
  if (!webServer) return

  const disposer = webServer.register({
    kind: 'prefix',
    path: '/api/ccimport',
    handler: async (req: Req, res: Res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const path = url.pathname
      try {
        if (path === '/api/ccimport/list') {
          const sessions: unknown[] = []
          for (const p of providers) sessions.push(...(await p.listSessions()))
          sendJson(res, 200, { sessions })
          return
        }
        if (path === '/api/ccimport/preview') {
          const sessionId = url.searchParams.get('sessionId') || ''
          const result = await providers[0].previewSession(sessionId)
          sendJson(res, 200, result)
          return
        }
        if (path === '/api/ccimport/import' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const result = await providers[0].importSession(sessionId)
          sendJson(res, result.error ? 500 : 200, result)
          return
        }
        sendJson(res, 404, { error: 'not found' })
      } catch (e: any) {
        sendJson(res, 500, { error: e?.message || String(e) })
      }
    },
  })

  ctx.effect(() => disposer)
}
