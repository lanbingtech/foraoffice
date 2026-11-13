import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createDocsMcpServer, type DocsMcpServerOptions } from './docs-mcp'
import { DOCS_COMMAND_MAX_BYTES } from '../shared/media-policy'

export interface DocsMcpConnection {
  readonly url: string
  readonly transport: 'streamable-http'
  readonly headers: Readonly<Record<string, string>>
  readonly documentId: string
  readonly protocolVersions: readonly string[]
}

export interface DocsHttpMcpServer {
  /** Trusted host configuration; headers contain a document credential. */
  readonly connection: DocsMcpConnection
  close(): Promise<void>
}

export interface DocsHttpMcpOptions extends DocsMcpServerOptions {
  bindingId: string
  documentId: string
  releaseScope(bindingId: string): void
}

/** Standard HTTP MCP for one host-authorized live document, independent of any Agent. */
export async function createDocsHttpMcpServer(
  options: DocsHttpMcpOptions,
): Promise<DocsHttpMcpServer> {
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const sessions = new Map<string, ReturnType<typeof createDocsMcpServer>>()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  let origin = ''
  let revoked = false
  let closing: Promise<void> | undefined
  const json = (res: ServerResponse, status: number, message: string) => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }))
  }
  const route = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('cache-control', 'no-store')
    if (revoked) return json(res, 410, 'The document grant is closed')
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin !== undefined && req.headers.origin !== origin)
    )
      return json(res, 403, 'Invalid host or origin')
    const supplied = Buffer.from(req.headers.authorization ?? '')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.setHeader('www-authenticate', 'Bearer')
      return json(res, 401, 'Unauthorized')
    }
    if (req.url !== '/mcp') return json(res, 404, 'Not found')
    if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      res.setHeader('allow', 'POST, GET, DELETE')
      return json(res, 405, 'Method not allowed')
    }
    const sessionId = req.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
    if (sessionId && !transport) return json(res, 404, 'Session not found')
    let body: unknown
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > DOCS_COMMAND_MAX_BYTES) return json(res, 413, 'Request exceeds the size limit')
        chunks.push(bytes)
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return json(res, 400, 'Invalid JSON')
      }
    }
    // A stop while receiving a body must not create another caller or session.
    if (revoked) return json(res, 410, 'The document grant is closed')
    let initializing: ReturnType<typeof createDocsMcpServer> | undefined
    if (!transport) {
      if (req.method !== 'POST' || !isInitializeRequest(body))
        return json(res, 400, 'Initialize the MCP session first')
      if (sessions.size >= 32) return json(res, 503, 'Too many document connections')
      const id = randomUUID()
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id })
      const server = createDocsMcpServer(options)
      initializing = server
      transport.onclose = () => {
        sessions.delete(id)
        transports.delete(id)
      }
      sessions.set(id, server)
      transports.set(id, transport)
      try {
        await server.connect(transport)
        if (revoked) {
          await server.close()
          return json(res, 410, 'The document grant is closed')
        }
      } catch (error) {
        sessions.delete(id)
        transports.delete(id)
        await server.close()
        throw error
      }
    }
    try {
      await transport.handleRequest(req, res, body)
    } finally {
      // HTTP negotiation failures can return normally without initializing or closing.
      if (initializing && !transport.sessionId) await initializing.close()
    }
  }
  const http = createServer((req, res) => {
    void route(req, res).catch(() => json(res, 500, 'MCP request failed'))
  })
  const close = () => {
    if (!closing) {
      revoked = true
      closing = Promise.resolve().then(async () => {
        options.releaseScope(options.bindingId)
        const stopping = [...sessions.values()].map((server) => server.close())
        sessions.clear()
        transports.clear()
        const listener = new Promise<void>((resolve, reject) => {
          http.close((error: NodeJS.ErrnoException | undefined) =>
            error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(),
          )
          http.closeAllConnections()
        })
        await Promise.all([...stopping, listener])
      })
    }
    return closing
  }
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject)
        resolve()
      })
    })
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('MCP did not obtain a local port')
    origin = `http://127.0.0.1:${address.port}`
    return {
      connection: {
        url: `${origin}/mcp`,
        transport: 'streamable-http',
        headers: { Authorization: `Bearer ${token}` },
        documentId: options.documentId,
        protocolVersions: ['2025-11-25', '2025-06-18', '2025-03-26'],
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
