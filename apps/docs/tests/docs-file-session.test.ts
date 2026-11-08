// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBlankDocx, parseDocx } from '@genoffice/docx-engine'
import { createDocsFileSession, type DocsFileSession } from '../src/services/document-files'
import { decryptDocx, encryptDocx, isEncryptedDocx } from '../src/services/docx-encryption'
import JSZip from 'jszip'
import { lazyMediaUrl } from '@genoffice/docx-engine/lazy-media'

const sessions: DocsFileSession[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
})

it("does not materialize or serve another file session's lazy media references", async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-media-'))
  const policy = { stateDirectory: join(root, '.state'), readRoots: [root], writeRoots: [root] }
  const owner = await createDocsFileSession(policy)
  const other = await createDocsFileSession(policy)
  sessions.push(owner, other)
  const zip = await JSZip.loadAsync(await buildBlankDocx())
  const picture = Buffer.alloc(1024 * 1024, 37)
  zip.file('word/media/image1.png', picture)
  const source = join(root, 'source.docx')
  await writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }))
  const opened = await owner.open(source)
  if (!opened || 'needsPassword' in opened) throw new Error('Document did not open')
  const slim = await owner.readAsset(opened.dataUrl)
  const url = lazyMediaUrl(opened.hash, 'word/media/image1.png')
  expect((await owner.readAsset(url))?.body).toEqual(picture)
  expect(await other.readAsset(url)).toBeNull()
  await expect(
    other.save(join(root, 'stolen.docx'), slim!.body, { sourcePath: null, overwrite: false }),
  ).rejects.toThrow('not authorized')
  await owner.save(join(root, 'saved.docx'), slim!.body, { sourcePath: source, overwrite: false })
  expect(
    await (
      await JSZip.loadAsync(await readFile(join(root, 'saved.docx')))
    )
      .file('word/media/image1.png')!
      .async('nodebuffer'),
  ).toEqual(picture)
})

it('opens and saves a Word document through the host-independent file service and its owned byte resource', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-session-'))
  const source = join(root, 'source.docx')
  const target = join(root, 'saved.docx')
  const bytes = await buildBlankDocx()
  await writeFile(source, bytes)
  const session = await createDocsFileSession({
    stateDirectory: join(root, '.state'),
    readRoots: [root],
    writeRoots: [root],
  })
  sessions.push(session)
  const opened = await session.open(source)
  if (!opened || 'needsPassword' in opened) throw new Error('The plain document did not open')
  const resource = await session.readAsset(opened.dataUrl)
  expect(resource).not.toBeNull()
  expect((await parseDocx(resource!.body)).blocks).toEqual((await parseDocx(bytes)).blocks)
  expect(await session.readAsset(opened.dataUrl)).toBeNull()
  const saved = await session.save(target, bytes, { sourcePath: source, overwrite: false })
  expect(saved.ok).toBe(true)
  expect(new Uint8Array(await readFile(target))).toEqual(bytes)
  const reopened = await session.open(target)
  expect(reopened && !('needsPassword' in reopened) && reopened.path).toBe(target)
})

it('refuses to overwrite a document modified on disk since it was opened', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-conflict-'))
  const session = await createDocsFileSession({
    stateDirectory: join(root, '.state'),
    readRoots: [root],
    writeRoots: [root],
  })
  sessions.push(session)
  const source = join(root, 'source.docx')
  const bytes = await buildBlankDocx()
  await writeFile(source, bytes)
  await session.open(source)
  const external = Buffer.from('External application content')
  await writeFile(source, external)
  expect(await session.save(source, bytes, { sourcePath: source, overwrite: true })).toMatchObject({
    ok: false,
    reason: 'external-modified',
  })
  expect(await readFile(source)).toEqual(external)
})

it('recovers protected dirty bytes using the disk password while a new save password is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-recovery-'))
  const stateDirectory = join(root, '.state')
  const policy = { stateDirectory, readRoots: [root], writeRoots: [root] }
  const session = await createDocsFileSession(policy)
  sessions.push(session)
  const source = join(root, 'protected.docx')
  const bytes = await buildBlankDocx()
  await writeFile(source, encryptDocx(Buffer.from(bytes), 'disk-password'))
  await session.open(source, 'disk-password')
  await session.setPassword(source, 'next-password')
  expect(await session.writeRecovery(source, bytes)).toEqual({ ok: true })
  expect(await session.recoveryInfo(source)).not.toBeNull()
  const { createHash } = await import('node:crypto')
  const path = join(
    stateDirectory,
    'docs-autosave',
    `${createHash('sha1').update(source).digest('hex').slice(0, 16)}.docx`,
  )
  const recovery = await readFile(path)
  expect(isEncryptedDocx(recovery)).toBe(true)
  expect(await decryptDocx(recovery, 'disk-password')).toEqual(Buffer.from(bytes))
  const reopened = await session.open(source, 'disk-password', 'restore')
  expect(reopened && !('needsPassword' in reopened) && reopened.recovered).toBe(true)
  const saved = await session.save(source, bytes, { sourcePath: source, overwrite: true })
  expect(saved.ok).toBe(true)
  expect(await session.recoveryInfo(source)).toBeNull()
  expect(await decryptDocx(await readFile(source), 'next-password')).toEqual(Buffer.from(bytes))
})

it('refuses paths outside grants, symlink escapes, and private service state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-policy-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  const stateDirectory = join(workspace, '.state')
  await Promise.all([mkdir(workspace), mkdir(outside)])
  await mkdir(stateDirectory)
  const bytes = await buildBlankDocx()
  await Promise.all([
    writeFile(join(outside, 'secret.docx'), bytes),
    writeFile(join(stateDirectory, 'secret.docx'), bytes),
  ])
  await symlink(
    outside,
    join(workspace, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const session = await createDocsFileSession({
    stateDirectory,
    readRoots: [workspace],
    writeRoots: [workspace],
  })
  sessions.push(session)
  for (const path of [
    join(outside, 'secret.docx'),
    join(workspace, 'escape', 'secret.docx'),
    join(stateDirectory, 'secret.docx'),
  ]) {
    await expect(session.open(path)).rejects.toThrow('authorized roots')
    await expect(session.save(path, bytes, { sourcePath: null, overwrite: true })).rejects.toThrow(
      'authorized roots',
    )
  }
  await expect(
    session.save(join(workspace, 'escape', 'new', 'secret.docx'), bytes, {
      sourcePath: null,
      overwrite: false,
    }),
  ).rejects.toThrow('authorized roots')
})

it('publishes only one concurrent non-overwriting save and preserves its complete bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-exclusive-'))
  const session = await createDocsFileSession({
    stateDirectory: join(root, '.state'),
    readRoots: [root],
    writeRoots: [root],
  })
  sessions.push(session)
  const target = join(root, 'saved.docx')
  const first = await buildBlankDocx()
  const second = Buffer.from('a competing document')
  const results = await Promise.allSettled(
    [first, second].map((bytes) =>
      session.save(target, bytes, { sourcePath: null, overwrite: false }),
    ),
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const saved = await readFile(target)
  expect(saved.equals(Buffer.from(first)) || saved.equals(second)).toBe(true)
  await expect(
    session.save(target, first, { sourcePath: null, overwrite: false }),
  ).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(target)).toEqual(saved)
})

it('owns one-shot resources per session and preserves encryption on Save As', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-password-'))
  const policy = { stateDirectory: join(root, '.state'), readRoots: [root], writeRoots: [root] }
  const first = await createDocsFileSession(policy)
  const other = await createDocsFileSession(policy)
  sessions.push(first, other)
  const source = join(root, 'protected.docx')
  const bytes = await buildBlankDocx()
  await writeFile(source, encryptDocx(Buffer.from(bytes), 'local-test-password'))
  expect(await first.open(source)).toMatchObject({ needsPassword: true })
  await expect(first.open(source, 'incorrect')).rejects.toThrow()
  const opened = await first.open(source, 'local-test-password')
  if (!opened || 'needsPassword' in opened) throw new Error('Encrypted open failed')
  expect(await readFile(join(policy.stateDirectory, 'originals', `${opened.hash}.docx`))).toEqual(
    await readFile(source),
  )
  expect(await other.readAsset(opened.dataUrl)).toBeNull()
  expect((await first.readAsset(opened.dataUrl))?.body).toEqual(Buffer.from(bytes))
  const target = join(root, 'saved.docx')
  await first.save(target, bytes, { sourcePath: source, overwrite: false })
  expect(await other.open(target)).toMatchObject({ needsPassword: true })
  const reopened = await other.open(target, 'local-test-password')
  expect(reopened && !('needsPassword' in reopened) && reopened.encrypted).toBe(true)
  first.dispose()
  await expect(first.open(source)).rejects.toThrow('closed')
})
