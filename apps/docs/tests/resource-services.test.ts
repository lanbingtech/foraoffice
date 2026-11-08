// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDocsFileAccess } from '../src/services/file-access'
import { createDocsResourceServices } from '../src/services/resource-services'
import * as knowledge from '../../shell/src/main/knowledge-base'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docs-resources-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const read = join(dir, 'read'),
    write = join(dir, 'write'),
    state = join(read, 'private')
  await Promise.all([mkdir(state, { recursive: true }), mkdir(write)])
  const a = join(read, 'a.txt'),
    b = join(read, 'b.txt'),
    outside = join(dir, 'outside.txt')
  await Promise.all([
    writeFile(a, 'Alpha needle text'),
    writeFile(b, 'Beta other'),
    writeFile(outside, 'approved'),
  ])
  return { read, write, state, a, b, outside }
}

describe('portable file grants', () => {
  it('keeps directions, exact approvals, private state and symlinks bounded', async () => {
    const f = await fixture()
    const access = await createDocsFileAccess({
      stateDirectory: f.state,
      readRoots: [f.read],
      writeRoots: [f.write],
    })
    expect(await access.authorize(f.a, 'read')).toBe(f.a)
    await expect(access.authorize(f.a, 'write')).rejects.toThrow(/authorized/)
    await expect(access.authorize(join(f.write, 'new.txt'), 'read')).rejects.toThrow(/authorized/)
    expect(await access.authorize(join(f.write, 'new.txt'), 'write')).toBe(join(f.write, 'new.txt'))
    await expect(access.authorize(join(f.state, 'secret.txt'), 'read')).rejects.toThrow(/private/i)
    await expect(access.grantFile(f.read, { read: true })).rejects.toThrow(/regular file/)
    await expect(access.grantFile(join(f.state, 'secret.txt'), { read: true })).rejects.toThrow(
      /private/i,
    )
    await access.grantFile(f.outside, { read: true })
    expect(await access.authorize(f.outside, 'read')).toBe(f.outside)
    await expect(access.authorize(f.outside, 'write')).rejects.toThrow(/authorized/)
    await expect(access.authorize(join(dir, 'sibling.txt'), 'read')).rejects.toThrow(/authorized/)
    await access.revokeFile(f.outside)
    await expect(access.authorize(f.outside, 'read')).rejects.toThrow(/authorized/)
    const link = join(f.read, 'escape')
    await symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(access.authorize(join(link, 'outside.txt'), 'read')).rejects.toThrow(/authorized/)
    await expect(access.authorize(join(link, 'outside.txt'), 'read')).rejects.toMatchObject({
      errorCode: 'permission_denied',
    })
    access.dispose()
    await expect(access.authorize(f.a, 'read')).rejects.toThrow(/closed/)
  })
})

describe('portable resource services', () => {
  it('disables ambient native app discovery and forwards only an explicit host renderer', async () => {
    const f = await fixture()
    const entry = join(dir, 'env-cli.cjs')
    await writeFile(
      entry,
      `console.log(JSON.stringify({status:'ok',command:'info',summary:process.env.GENOFFICE_APP_DISCOVERY+'|'+process.env.GENOFFICE_APP_BIN}))`,
    )
    vi.stubEnv('GENOFFICE_APP_BIN', 'ambient-native-app')
    const services = await createDocsResourceServices({
      stateDirectory: f.state,
      readRoots: [f.read],
      writeRoots: [f.write],
      cli: { executable: process.execPath, entry },
    })
    expect((await services.runCli(['info', f.a])).json?.summary).toBe('off|')
    services.dispose()
    const explicit = await createDocsResourceServices({
      stateDirectory: f.state,
      readRoots: [f.read],
      writeRoots: [f.write],
      cli: { executable: process.execPath, entry, env: { GENOFFICE_APP_BIN: 'host-renderer' } },
    })
    expect((await explicit.runCli(['info', f.a])).json?.summary).toBe('off|host-renderer')
    explicit.dispose()
  })

  it('does not let an older asynchronous collection update restore revoked sources', async () => {
    const f = await fixture()
    const services = await createDocsResourceServices({
      stateDirectory: f.state,
      readRoots: [f.read],
      writeRoots: [f.write],
    })
    const older = services.setAttachments([f.a, f.b])
    const newer = services.setAttachments([])
    const outcomes = await Promise.allSettled([older, newer])
    expect(outcomes[0].status).toBe('rejected')
    expect(services.listAttachments()).toEqual([])
    services.dispose()
  })

  it('uses distinct revocable collections, parses real files, searches content and pages bounded text', async () => {
    const f = await fixture()
    const services = await createDocsResourceServices({
      stateDirectory: f.state,
      readRoots: [f.read],
      writeRoots: [f.write],
    })
    await services.setAttachments([f.a])
    await services.setKnowledgeFiles([f.b])
    expect((await services.readAttachment(f.a, 6, 6)).text).toBe('needle')
    await expect(services.kbRead(f.a, 0)).rejects.toThrow(/knowledge/i)
    await expect(services.kbRead(f.a, 0)).rejects.toMatchObject({ errorCode: 'permission_denied' })
    await expect(services.readAttachment(f.b, 0, 100)).rejects.toThrow(/attachment/i)
    expect(await services.kbSearch({ q: 'needle' })).toEqual([])
    await services.setKnowledgeFiles([f.a, f.b])
    expect((await services.kbSearch({ q: 'needle', limit: 500 }))[0]).toMatchObject({
      path: f.a,
      snippet: 'Alpha needle text',
    })
    await writeFile(f.a, 'x'.repeat(30_000))
    expect((await services.readAttachment(f.a, -8, 1_000_000)).text?.length).toBe(24_000)
    expect((await services.kbRead(f.a, 24_000)).text.length).toBe(6000)
    await services.setAttachments([])
    await expect(services.readAttachment(f.a, 0, 100)).rejects.toThrow(/attachment/i)
    await expect(services.readAttachment(f.a, 0, 100)).rejects.toMatchObject({
      errorCode: 'permission_denied',
    })
    services.dispose()
    await expect(services.kbRead(f.b, 0)).rejects.toThrow(/closed/)
  })

  it('preserves permission_denied when a source is revoked during parsing', async () => {
    const f = await fixture()
    const services = await createDocsResourceServices({
      stateDirectory: f.state,
      readRoots: [f.read],
      writeRoots: [f.write],
    })
    await services.setAttachments([f.a])
    let release!: (text: string) => void
    let started!: () => void
    const parsing = new Promise<string>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.spyOn(knowledge, 'readKnowledgeFileText').mockImplementationOnce(() => {
      started()
      return parsing
    })
    const pending = services.readAttachment(f.a, 0, 100)
    await ready
    await services.setAttachments([])
    release('private parsed text')
    await expect(pending).rejects.toMatchObject({ errorCode: 'permission_denied' })
    services.dispose()
  })

  it('rejects unapproved sources, private files, non-files and oversized corpora', async () => {
    const f = await fixture()
    const services = await createDocsResourceServices({
      stateDirectory: f.state,
      readRoots: [f.read],
      writeRoots: [f.write],
    })
    await expect(services.setKnowledgeFiles([f.outside])).rejects.toThrow(/authorized/)
    await expect(services.setAttachments([f.read])).rejects.toThrow(/regular file/)
    await expect(services.setAttachments(Array.from({ length: 201 }, () => f.a))).rejects.toThrow(
      /200/,
    )
    await services.grantFile(f.outside, { read: true })
    await services.setAttachments([f.outside])
    expect((await services.readAttachment(f.outside, 0, 100)).text).toBe('approved')
    await services.revokeFile(f.outside)
    expect(services.listAttachments()).toEqual([])
    await expect(services.readAttachment(f.outside, 0, 100)).rejects.toThrow(/attachment/i)
    services.dispose()
  })

  it('runs only bounded file commands and reports cancellation effects honestly', async () => {
    const f = await fixture()
    const entry = join(dir, 'cli.cjs')
    await writeFile(
      entry,
      `const fs=require('node:fs'); const args=process.argv.slice(2); if(args.includes('wait')){fs.writeFileSync(args[2],'written'); setTimeout(()=>{},10000)}else{console.log(JSON.stringify({status:'ok',command:args[0],summary:'fixture',output_path:args[1]}))}`,
    )
    const services = await createDocsResourceServices({
      stateDirectory: f.state,
      readRoots: [f.read],
      writeRoots: [f.write],
      cli: { executable: process.execPath, entry },
      cwd: f.write,
    })
    for (const args of [
      ['search', 'hello'],
      ['image', 'x'],
      ['media', 'x'],
      ['capabilities'],
      ['mcp'],
      ['docs', 'apply', f.a],
      ['docs', '--track', 'apply', f.a],
      ['convert', f.a, '--force'],
      ['info', 'x'.repeat(1001)],
    ]) {
      expect(await services.runCli(args)).toMatchObject({ ok: false, committed: false })
    }
    const aborted = new AbortController()
    aborted.abort()
    expect(await services.runCli(['info', f.a], aborted.signal)).toMatchObject({
      ok: false,
      committed: false,
    })
    expect(await services.runCli(['convert', f.a])).toMatchObject({ ok: true, committed: true })
    const controller = new AbortController()
    const target = join(f.write, 'effect.txt')
    const running = services.runCli(['convert', 'wait', target], controller.signal)
    for (let n = 0; n < 100; n++) {
      if ((await readFile(target, 'utf8').catch(() => '')) === 'written') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(await readFile(target, 'utf8')).toBe('written')
    controller.abort()
    expect(await running).toMatchObject({ ok: false, committed: null })
    services.dispose()
  })
})
