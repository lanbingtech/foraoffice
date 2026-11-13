import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { buildBlankDocx } from '../packages/docx-engine/src'

test('a native host owns an independent Node document backend through JSON-RPC and authenticated resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foraoffice-node-host-'))
  const fixtureZip = await JSZip.loadAsync(await buildBlankDocx())
  fixtureZip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Native host fixture</w:t></w:r></w:p></w:body></w:document>',
  )
  const bytes = await fixtureZip.generateAsync({ type: 'nodebuffer' })
  const source = join(directory, 'source.docx')
  await writeFile(source, bytes)
  const attachment = join(directory, 'attached.txt')
  const knowledge = join(directory, 'knowledge.txt')
  await writeFile(attachment, 'Attachment evidence from a real file')
  await writeFile(knowledge, 'Knowledge evidence from a real file')
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=',
    'base64',
  )
  const imagePath = join(directory, 'picked.png')
  await writeFile(imagePath, image)
  const child = spawn(
    process.execPath,
    [resolve(__dirname, '../apps/docs/out/services/node-host.cjs')],
    { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let seq = 0
  let stderr = ''
  const received: unknown[] = []
  child.stderr.on('data', (data) => {
    stderr += data
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'host.dialog' && message.params.kind === 'image') {
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: imagePath }) + '\n',
      )
      return
    }
    received.push(message)
    const pending = requests.get(message.id)
    if (!pending) return
    requests.delete(message.id)
    if (message.error)
      pending.reject(
        Object.assign(new Error(message.error.message), {
          code: message.error.code,
          data: message.error.data,
        }),
      )
    else pending.resolve(message.result)
  })
  const exited = new Promise<void>((done, reject) =>
    child.once('close', (code) => {
      for (const pending of requests.values())
        pending.reject(new Error(`Backend exited ${code}: ${stderr}`))
      requests.clear()
      if (code === 0) done()
      else reject(new Error(`Backend exited ${code}: ${stderr}`))
    }),
  )
  void exited.catch(() => {})
  const request = (method: string, params: unknown = {}) =>
    new Promise<unknown>((done, reject) => {
      const id = ++seq
      requests.set(id, { resolve: done, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  try {
    child.stdin.write('{bad json}\n')
    await expect.poll(() => received.length).toBeGreaterThan(0)
    expect(received.shift()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'invalid', method: 9 }) + '\n')
    await expect.poll(() => received.length).toBeGreaterThan(0)
    expect(received.shift()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } })
    await expect(request('initialize', { stateDirectory: 9 })).rejects.toMatchObject({
      code: -32602,
    })
    received.splice(0)
    const ready = (await request('initialize', {
      stateDirectory: join(directory, '.state'),
      readRoots: [directory],
      writeRoots: [directory],
      defaultSaveDirectory: directory,
      initialPath: source,
      attachments: [attachment],
      knowledge: [knowledge],
      cli: {
        executable: process.execPath,
        entry: resolve(__dirname, '../packages/cli/dist/genoffice.cjs'),
      },
    })) as { assets: { url: string; token: string } }
    expect(
      await request('services.call', { method: 'readAttachment', args: [attachment, 0, 24_000] }),
    ).toMatchObject({ ok: true, text: 'Attachment evidence from a real file' })
    expect(
      await request('services.call', { method: 'kbRead', args: [knowledge, 0] }),
    ).toMatchObject({ text: 'Knowledge evidence from a real file' })
    expect(
      await request('services.call', { method: 'kbSearch', args: [{ q: 'evidence' }] }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: knowledge,
          snippet: expect.stringContaining('Knowledge evidence'),
        }),
      ]),
    )
    await expect(
      request('services.call', { method: 'readAttachment', args: [knowledge, 0, 24_000] }),
    ).rejects.toMatchObject({ data: { errorCode: 'permission_denied' } })
    const cli = (await request('services.call', {
      method: 'runCli',
      args: [['docs', 'read', source]],
    })) as { ok: boolean; stdout: string }
    expect(cli.ok, cli.stdout).toBe(true)
    expect(cli.stdout).toContain('Native host fixture')
    const opened = (await request('services.call', {
      method: 'consumePendingOpenDocx',
      args: [],
    })) as { dataUrl: string }
    const resource = `${ready.assets.url}?url=${encodeURIComponent(opened.dataUrl)}`
    expect((await fetch(resource)).status).toBe(401)
    const body = await fetch(resource, {
      headers: { authorization: `Bearer ${ready.assets.token}` },
    })
    expect(Buffer.from(await body.arrayBuffer())).toEqual(bytes)
    const target = join(directory, 'saved.docx')
    expect(
      await request('services.call', {
        method: 'saveDocxTo',
        args: [target, { base64: bytes.toString('base64') }, false, source],
      }),
    ).toMatchObject({ ok: true, committed: true, path: target })
    expect(await readFile(target)).toEqual(bytes)
    expect(await request('services.call', { method: 'pickImage', args: [] })).toEqual({
      name: 'picked.png',
      mime: 'image/png',
      base64: image.toString('base64'),
    })
    expect(
      await request('services.call', { method: 'fontMetrics', args: ['Arial'] }),
    ).toMatchObject({ unitsPerEm: expect.any(Number), hheaAscender: expect.any(Number) })
    for (const revoke of ['document.releaseAllActions', 'document.releaseAction']) {
      const bindingId = randomUUID()
      const batchIds = [++seq, ++seq]
      child.stdin.write(
        JSON.stringify([
          { jsonrpc: '2.0', id: batchIds[0], method: 'document.bindAction', params: { bindingId } },
          {
            jsonrpc: '2.0',
            id: batchIds[1],
            method: revoke,
            params: revoke === 'document.releaseAction' ? { bindingId } : {},
          },
        ]) + '\n',
      )
      await expect
        .poll(() =>
          received.some(
            (value) => Array.isArray(value) && value.some((reply) => reply.id === batchIds[0]),
          ),
        )
        .toBe(true)
      const replies = received.find(
        (value) => Array.isArray(value) && value.some((reply) => reply.id === batchIds[0]),
      ) as Array<{ id: number; error?: { message: string }; result?: unknown }>
      expect(replies.find((reply) => reply.id === batchIds[0])?.error?.message).toMatch(
        /closed|revoked/,
      )
      expect(replies.find((reply) => reply.id === batchIds[1])).toMatchObject({
        result: { released: revoke === 'document.releaseAction' ? true : 1 },
      })
    }
    await expect(
      request('services.call', {
        method: 'grantFile',
        args: [join(directory, '..', 'private.docx')],
      }),
    ).rejects.toThrow(/not available/)
    await expect(request('services.call', { method: 'aiChat', args: [{}] })).rejects.toThrow(
      /not available/,
    )
    await expect(request('unknown')).rejects.toThrow(/Method not found/)
    expect(stderr).not.toContain(ready.assets.token)
  } finally {
    child.stdin.end()
    await exited
    lines.close()
  }
})

test('EOF during initialization leaves no late backend server alive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foraoffice-node-early-close-'))
  const child = spawn(
    process.execPath,
    [resolve(__dirname, '../apps/docs/out/services/node-host.cjs')],
    {
      cwd: directory,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  child.stdout.resume()
  child.stderr.resume()
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    child.stdin.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          stateDirectory: join(directory, '.state'),
          readRoots: [directory],
          writeRoots: [directory],
          defaultSaveDirectory: directory,
        },
      }) + '\n',
    )
    expect(
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('A backend created after EOF kept the owned process alive')),
            4000,
          )
        }),
      ]),
    ).toBe(0)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await exited
  }
})
