// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { createDocsFileAccess } from '../src/services/file-access'
import { createDocsExportServices } from '../src/services/export-services'

let dir: string
const owned: Array<{ dispose(): Promise<void> }> = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docs-export-'))
})
afterEach(async () => {
  await Promise.all(owned.splice(0).map((service) => service.dispose()))
  await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const state = join(dir, 'private'),
    out = join(dir, 'chosen')
  await Promise.all([mkdir(state, { recursive: true }), mkdir(out, { recursive: true })])
  const access = await createDocsFileAccess({
    stateDirectory: state,
    readRoots: [],
    writeRoots: [],
  })
  const picked: Array<string | null> = []
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 300])
  const printPdf = vi.fn(async () => pdf.save())
  const readAsset = vi.fn(async (_url: string) => null as { body: Buffer; mime: string } | null)
  const pickSave = vi.fn(
    async (_options: { defaultName: string; extension: string }) => picked.shift() ?? null,
  )
  const service = await createDocsExportServices({
    access,
    files: { readAsset },
    stateDirectory: state,
    printPdf,
    dialogs: { pickSave, pickDirectory: async () => out },
  })
  owned.push(service)
  return { state, out, access, picked, printPdf, readAsset, pickSave, service }
}

describe('portable exports', () => {
  it('requires its exact dialog grant even under a writable root, preserves names and retries approved paths', async () => {
    const f = await fixture()
    const path = join(f.out, 'document.html')
    expect(await f.service.exportHtml('Document.docx', '<p>blocked</p>', path)).toMatchObject({
      ok: false,
      errorCode: 'permission_denied',
      committed: false,
    })
    f.picked.push(path)
    expect(await f.service.exportHtml('Document.docx', '<p>saved</p>')).toMatchObject({
      ok: true,
      path,
      committed: true,
    })
    expect(f.pickSave).toHaveBeenCalledWith({ defaultName: 'Document.html', extension: 'html' })
    expect(await readFile(path, 'utf8')).toBe('<p>saved</p>')
    expect(await f.service.exportHtml('Document.docx', '<p>retry</p>', path)).toMatchObject({
      ok: true,
    })
    expect(
      await f.service.exportHtml('Document.docx', 'x', join(f.out, 'sibling.html')),
    ).toMatchObject({ ok: false, errorCode: 'permission_denied' })
    f.picked.push(join(f.state, 'secret.html'))
    expect(await f.service.exportHtml('Document.docx', 'private')).toMatchObject({
      ok: false,
      errorCode: 'permission_denied',
    })
  })

  it('prints real PDF bytes, merges pages and stamps internal links without a PDF engine copy', async () => {
    const f = await fixture()
    const path = join(f.out, 'document.pdf')
    f.picked.push(path)
    expect(await f.service.exportPdf('Document.docx', 14400, 20000, undefined, 1.2)).toMatchObject({
      ok: true,
      committed: true,
    })
    expect(f.printPdf).toHaveBeenCalledWith({ widthTwips: 14400, heightTwips: 20000, scale: 1.2 })
    const page = await f.service.printPdfBuffer(14400, 20000)
    expect(page.ok).toBe(true)
    expect(
      await f.service.saveMergedPdf('Document', [page.base64!, page.base64!], path, [
        { page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1, toPage: 1, toY: 0 },
      ]),
    ).toMatchObject({ ok: true })
    const saved = await PDFDocument.load(await readFile(path))
    expect(saved.getPageCount()).toBe(2)
    expect(saved.getPage(0).node.Annots()?.size()).toBe(1)
    expect(await f.service.exportPdf('Document', NaN, 20000, path)).toMatchObject({
      ok: false,
      committed: false,
    })
    expect(await f.service.saveMergedPdf('Document', ['not base64'], path)).toMatchObject({
      ok: false,
      committed: false,
    })
  })

  it('writes Markdown media only beside its approved file and rejects symlink escapes', async () => {
    const f = await fixture()
    const path = join(f.out, 'report (1).md')
    f.picked.push(path)
    expect(
      await f.service.exportMarkdown('Report.docx', '![](__genoffice_media__/image1.png)', [
        { name: 'image1.png', src: 'data:image/png;base64,aW1hZ2U=' },
      ]),
    ).toMatchObject({ ok: true, imagesDropped: 0 })
    expect(await readFile(join(f.out, 'report (1)_files', 'image1.png'), 'utf8')).toBe('image')
    expect(await readFile(path, 'utf8')).toBe('![](report%20%281%29_files/image1.png)')
    const escaped = join(f.out, 'escape.md')
    const outside = join(dir, 'outside')
    await mkdir(outside)
    await symlink(
      outside,
      join(f.out, 'escape_files'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    f.picked.push(escaped)
    expect(
      await f.service.exportMarkdown('Escape', 'x', [
        { name: 'image1.png', src: 'data:image/png;base64,aW1hZ2U=' },
      ]),
    ).toMatchObject({ ok: false, errorCode: 'permission_denied', committed: false })
    await expect(stat(join(outside, 'image1.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps temporary PDFs per host and writes images only into its chosen folder', async () => {
    const f = await fixture()
    const target = (await f.service.pickExportImagesTarget())!
    await expect(f.access.authorize(target.pdfPath, 'read')).rejects.toMatchObject({
      errorCode: 'permission_denied',
    })
    expect(await f.service.exportPdf('Document', 14400, 20000, target.pdfPath)).toMatchObject({
      ok: true,
    })
    const second = await fixture()
    expect(await second.service.takeExportPdf(target.pdfPath)).toMatchObject({
      ok: false,
      errorCode: 'permission_denied',
    })
    expect(await f.service.takeExportPdf(target.pdfPath)).toMatchObject({ ok: true })
    expect(await f.service.takeExportPdf(target.pdfPath)).toMatchObject({
      ok: false,
      errorCode: 'permission_denied',
    })
    expect(await f.service.writeExportImage(f.out, '../escape.png', 'aW1hZ2U=')).toMatchObject({
      ok: false,
    })
    expect(await f.service.writeExportImage(f.out, 'page1.png', 'aW1hZ2U=')).toMatchObject({
      ok: true,
    })
    expect(await readFile(join(f.out, 'page1.png'), 'utf8')).toBe('image')
    await f.service.dispose()
    await expect(stat(target.pdfPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not move Markdown assets when the approved document parent becomes a junction', async () => {
    const f = await fixture()
    const path = join(f.out, 'report.md'),
      outside = join(dir, 'outside')
    await mkdir(outside)
    f.picked.push(path)
    const authorize = f.access.authorize.bind(f.access)
    const check = vi.spyOn(f.access, 'authorize').mockImplementationOnce(async (path, purpose) => {
      const canonical = await authorize(path, purpose)
      await rename(f.out, join(dir, 'original-output'))
      await symlink(outside, f.out, process.platform === 'win32' ? 'junction' : 'dir')
      return canonical
    })
    expect(
      await f.service.exportMarkdown('Report', 'x', [
        { name: 'image1.png', src: 'data:image/png;base64,aW1hZ2U=' },
      ]),
    ).toMatchObject({ ok: false, errorCode: 'permission_denied', committed: false })
    check.mockRestore()
    await expect(stat(join(outside, 'report_files', 'image1.png'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('saves only data images or this file session assets and refuses a write after disposal during print', async () => {
    const f = await fixture()
    f.picked.push(join(f.out, 'image.png'))
    expect(await f.service.saveImageAs('file:///etc/passwd')).toMatchObject({ ok: false })
    expect(await f.service.saveImageAs('https://example.com/image.png')).toMatchObject({
      ok: false,
    })
    expect(await f.service.saveImageAs('data:image/png;base64,aW1hZ2U=')).toMatchObject({
      ok: true,
    })
    const largePicture = Buffer.alloc(25 * 1024 * 1024, 7)
    f.readAsset.mockResolvedValueOnce({ body: largePicture, mime: 'image/png' })
    const largeTarget = join(f.out, 'large.png')
    f.picked.push(largeTarget)
    expect(await f.service.saveImageAs('genoffice-docx-media://owned/large.png')).toMatchObject({
      ok: true,
    })
    expect((await stat(largeTarget)).size).toBe(largePicture.length)
    let release!: (bytes: Uint8Array) => void
    const pending = new Promise<Uint8Array>((resolve) => {
      release = resolve
    })
    f.printPdf.mockImplementationOnce(() => pending)
    f.picked.push(join(f.out, 'late.pdf'))
    const writing = f.service.exportPdf('Document', 14400, 20000)
    await vi.waitFor(() => expect(f.printPdf).toHaveBeenCalledTimes(1))
    await f.service.dispose()
    release(new Uint8Array([1]))
    expect(await writing).toMatchObject({ ok: false, committed: false })
    await expect(stat(join(f.out, 'late.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
