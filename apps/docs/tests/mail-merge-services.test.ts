// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { csvToXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { createDocsFileAccess } from '../src/services/file-access'
import { createDocsMailMergeServices } from '../src/services/mail-merge-services'
import { createDocsFileSession } from '../src/services/document-files'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { isEncryptedDocx } from '../src/services/docx-encryption'
import JSZip from 'jszip'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docs-mail-merge-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(materialize = async (data: Uint8Array) => data) {
  const state = join(dir, 'private'),
    output = join(dir, 'output')
  await Promise.all([mkdir(state), mkdir(output)])
  const access = await createDocsFileAccess({
    stateDirectory: state,
    readRoots: [],
    writeRoots: [],
  })
  const picks: Array<string | null> = []
  const service = createDocsMailMergeServices({
    access,
    materialize,
    dialogs: {
      pickSource: async () => picks.shift() ?? null,
      pickSave: async () => picks.shift() ?? null,
      pickDirectory: async () => picks.shift() ?? null,
    },
  })
  return { state, output, access, picks, service }
}
const data = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

it('materializes only the owning session media without applying its pending password', async () => {
  const f = await fixture()
  const policy = { stateDirectory: f.state, readRoots: [dir], writeRoots: [dir] }
  const owner = await createDocsFileSession(policy),
    other = await createDocsFileSession(policy)
  try {
    const zip = await JSZip.loadAsync(await buildBlankDocx())
    const picture = Buffer.alloc(1024 * 1024, 37)
    zip.file('word/media/image1.png', picture)
    const source = join(dir, 'source.docx')
    await writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }))
    const opened = await owner.open(source)
    if (!opened || 'needsPassword' in opened) throw new Error('Document did not open')
    const slim = (await owner.readAsset(opened.dataUrl))!.body
    await owner.setPassword(source, 'pending-password')
    const revision = owner.passwordIntentRevision()
    const bytes = await owner.materializeDocx(slim)
    expect(isEncryptedDocx(bytes)).toBe(false)
    expect(
      await (await JSZip.loadAsync(bytes)).file('word/media/image1.png')!.async('nodebuffer'),
    ).toEqual(picture)
    expect(owner.passwordIntentRevision()).toBe(revision)
    await expect(other.materializeDocx(slim)).rejects.toThrow(/not authorized/)
  } finally {
    owner.dispose()
    other.dispose()
  }
})

it('parses actual picked CSV and XLSX with the existing field/record contract and excludes private state', async () => {
  const f = await fixture()
  const csv = join(dir, 'people.csv'),
    xlsx = join(dir, 'people.xlsx')
  await writeFile(csv, 'Name,Name\nAda,Lovelace\n')
  await writeFile(xlsx, await csvToXlsxBuffer('Name,Age\nGrace,45\n'))
  f.picks.push(csv, xlsx, join(f.state, 'secret.csv'), null)
  expect(await f.service.pickMergeDataSource()).toMatchObject({
    ok: true,
    source: {
      path: csv,
      name: 'people.csv',
      fields: ['Name', 'Name2'],
      records: [{ Name: 'Ada', Name2: 'Lovelace' }],
    },
  })
  expect(await f.service.pickMergeDataSource()).toMatchObject({
    ok: true,
    source: { fields: ['Name', 'Age'], records: [{ Name: 'Grace', Age: '45' }] },
  })
  expect(await f.service.pickMergeDataSource()).toMatchObject({
    ok: false,
    errorCode: 'permission_denied',
  })
  expect(await f.service.pickMergeDataSource()).toBeNull()
  await expect(f.access.authorize(join(dir, 'unselected.csv'), 'read')).rejects.toMatchObject({
    errorCode: 'permission_denied',
  })
})

it('preserves single/labels and per-record names, unique suffixes and materialized bytes', async () => {
  const f = await fixture(async (bytes) => Buffer.concat([Buffer.from('materialized:'), bytes]))
  const single = join(f.output, 'all.docx')
  f.picks.push(single, single, f.output)
  expect(
    await f.service.writeMergeOutput({
      mode: 'single',
      files: [{ name: 'all', data: data('one') }],
    }),
  ).toMatchObject({ ok: true, path: single, count: 1, committed: true })
  expect(
    await f.service.writeMergeOutput({
      mode: 'labels',
      files: [{ name: 'labels', data: data('labels') }],
    }),
  ).toMatchObject({ ok: true, count: 1 })
  expect(await readFile(single, 'utf8')).toBe('materialized:labels')
  expect(
    await f.service.writeMergeOutput({
      mode: 'perRecord',
      files: [
        { name: '../../person', data: data('A') },
        { name: 'person', data: data('B') },
      ],
    }),
  ).toMatchObject({ ok: true, folder: f.output, count: 2, committed: true })
  expect(await readFile(join(f.output, 'person.docx'), 'utf8')).toBe('materialized:A')
  expect(await readFile(join(f.output, 'person-2.docx'), 'utf8')).toBe('materialized:B')
  await expect(stat(join(dir, 'person.docx'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports earlier files honestly if a later materialization fails and preserves canceled output', async () => {
  let count = 0
  const f = await fixture(async (bytes) => {
    if (++count === 2) throw new Error('materialization failed')
    return bytes
  })
  f.picks.push(f.output, null)
  expect(
    await f.service.writeMergeOutput({
      mode: 'envelopes',
      files: [
        { name: 'first', data: data('A') },
        { name: 'second', data: data('B') },
      ],
    }),
  ).toMatchObject({ ok: false, count: 1, committed: true, error: 'materialization failed' })
  expect(await readFile(join(f.output, 'first.docx'), 'utf8')).toBe('A')
  await expect(stat(join(f.output, 'second.docx'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(
    await f.service.writeMergeOutput({
      mode: 'single',
      files: [{ name: 'cancel', data: data('C') }],
    }),
  ).toMatchObject({ ok: false, canceled: true, committed: false, count: 0 })
})

it('rejects a selected private folder and a selected folder changed to a junction during materialization', async () => {
  const outside = join(dir, 'outside')
  await mkdir(outside)
  const f = await fixture(async (bytes) => {
    await rm(f.output, { recursive: true })
    await symlink(outside, f.output, process.platform === 'win32' ? 'junction' : 'dir')
    return bytes
  })
  f.picks.push(f.state, f.output)
  const request = { mode: 'perRecord' as const, files: [{ name: 'escape', data: data('A') }] }
  expect(await f.service.writeMergeOutput(request)).toMatchObject({
    ok: false,
    committed: false,
    errorCode: 'permission_denied',
  })
  expect(await f.service.writeMergeOutput(request)).toMatchObject({
    ok: false,
    committed: false,
    errorCode: 'permission_denied',
  })
  await expect(stat(join(outside, 'escape.docx'))).rejects.toMatchObject({ code: 'ENOENT' })
})
