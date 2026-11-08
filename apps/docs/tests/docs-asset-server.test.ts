// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { createDocsFileSession } from '../src/services/document-files'
import { createDocsAssetServer } from '../src/services/asset-server'

it('serves only this host session’s document bytes to its authenticated native resource adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-assets-'))
  const files = await createDocsFileSession({
    stateDirectory: join(root, '.state'),
    readRoots: [root],
    writeRoots: [root],
  })
  const bytes = await buildBlankDocx()
  const path = join(root, 'source.docx')
  await writeFile(path, bytes)
  const opened = await files.open(path)
  if (!opened || 'needsPassword' in opened) throw new Error('The fixture did not open')
  const server = await createDocsAssetServer(files)
  const resource = `${server.url}?url=${encodeURIComponent(opened.dataUrl)}`
  const headers = { authorization: `Bearer ${server.token}` }
  try {
    expect((await fetch(resource)).status).toBe(401)
    expect(
      (await fetch(resource, { headers: { ...headers, origin: 'https://untrusted.example' } }))
        .status,
    ).toBe(403)
    expect(
      (await fetch(`${server.url}?url=${encodeURIComponent('file://' + path)}`, { headers }))
        .status,
    ).toBe(404)
    const response = await fetch(resource, { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect((await fetch(resource, { headers })).status).toBe(404)
  } finally {
    await server.close()
    files.dispose()
  }
})
