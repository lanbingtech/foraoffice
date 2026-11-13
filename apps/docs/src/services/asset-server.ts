import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { DocsFileSession } from './document-files'

export interface DocsAssetServer {
  readonly url: string
  /** Native host credential. Never expose it to the renderer or Agent. */
  readonly token: string
  close(): Promise<void>
}

/** The native host forwards owned resource URLs; this server cannot read arbitrary paths. */
export async function createDocsAssetServer(files: DocsFileSession): Promise<DocsAssetServer> {
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  let authority = ''
  let closed = false
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    if (closed || request.headers.host !== authority || request.headers.origin !== undefined) {
      response.writeHead(403).end()
      return
    }
    const credential = Buffer.from(request.headers.authorization ?? '')
    if (credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
      response.writeHead(401).end()
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' }).end()
      return
    }
    const url = new URL(request.url ?? '/', `http://${authority}`)
    if (url.pathname !== '/asset' || url.searchParams.size !== 1 || !url.searchParams.has('url')) {
      response.writeHead(404).end()
      return
    }
    try {
      const asset = await files.readAsset(url.searchParams.get('url')!)
      if (!asset || closed) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': asset.mime, 'content-length': asset.body.length })
      response.end(asset.body)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The document asset server did not bind')
  authority = `127.0.0.1:${address.port}`
  let closing: Promise<void> | undefined
  return {
    url: `http://${authority}/asset`,
    token,
    close() {
      if (!closing) {
        closed = true
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
      }
      return closing
    },
  }
}
