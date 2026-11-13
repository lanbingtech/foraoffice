// @vitest-environment node
import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

it('shares exact directional grants and revocation with resource services', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'docs-host-grants-')))
  const root = join(directory, 'root')
  await mkdir(root)
  const outside = join(directory, 'outside.txt')
  const sibling = join(directory, 'sibling.txt')
  await writeFile(outside, 'approved bytes')
  await writeFile(sibling, 'unapproved bytes')
  const child = spawn(process.execPath, [resolve('out/sdk/services/node-host.cjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  let id = 0
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const reply = JSON.parse(line)
    pending.get(reply.id)?.(reply)
    pending.delete(reply.id)
  })
  const rpc = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((done) => {
      const requestId = ++id
      pending.set(requestId, done)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
    })
  try {
    expect(
      await rpc('initialize', {
        stateDirectory: join(root, '.state'),
        readRoots: [root],
        writeRoots: [root],
        defaultSaveDirectory: root,
      }),
    ).toHaveProperty('result')
    const selection = { attachments: [outside], knowledge: [] }
    expect(await rpc('resources.configure', selection)).toHaveProperty('error')
    expect(await rpc('files.grant', { path: outside, read: true, write: false })).toHaveProperty(
      'result',
    )
    expect(await rpc('resources.configure', selection)).toHaveProperty('result')
    expect(
      await rpc('services.call', { method: 'readAttachment', args: [outside, 0, 100] }),
    ).toMatchObject({ result: { text: 'approved bytes' } })
    expect(
      await rpc('resources.configure', { attachments: [sibling], knowledge: [] }),
    ).toHaveProperty('error')
    expect(
      await rpc('services.call', {
        method: 'saveDocxTo',
        args: [outside, { base64: 'UEsDBA==' }, false, null],
      }),
    ).toMatchObject({ result: { ok: false } })
    expect(await rpc('files.revoke', { path: outside })).toHaveProperty('result')
    expect(
      await rpc('services.call', { method: 'readAttachment', args: [outside, 0, 100] }),
    ).toHaveProperty('error')
  } finally {
    lines.close()
    child.kill()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
