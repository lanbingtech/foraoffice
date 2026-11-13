import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'
import { decodeDataUrl, suggestImageFileName } from '@genoffice/electron-utils/image-data'
import { MAX_REMOTE_IMAGE_BYTES } from '@genoffice/electron-utils/remote-image'
import { MARKDOWN_MEDIA_DIR_TOKEN, type MarkdownImage, type PdfInternalLink } from '../shared/ipc'
import type { DocsErrorCode } from '../shared/operation-result'
import { addPdfInternalLinks } from '../main/pdf-links'
import { validPrintGeometry } from '../main/print-args'
import { inlineLazyMediaInHtml } from '../main/lazy-media-inline'
import { canonical, inside, type DocsFileAccess } from './file-access'
import type { DocsFileSession } from './document-files'
import { DocsFileError } from './file-errors'
import { writeMarkdownMedia } from './markdown-media'

export interface DocsExportServicesOptions {
  access: DocsFileAccess
  files: Pick<DocsFileSession, 'readAsset'>
  stateDirectory: string
  dialogs: {
    pickSave(options: { defaultName: string; extension: string }): Promise<string | null>
    pickDirectory(): Promise<string | null>
  }
  printPdf(options: {
    widthTwips: number
    heightTwips: number
    scale?: number
  }): Promise<Uint8Array>
}

export interface DocsExportResult {
  ok: boolean
  path?: string
  error?: string
  errorCode?: DocsErrorCode
  committed: boolean | null
  imagesDropped?: number
}

const MAX_BYTES = 128 * 1024 * 1024
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4
function decodeBase64(text: string): Buffer {
  if (
    typeof text !== 'string' ||
    text.length > MAX_BASE64_CHARS ||
    text.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
  )
    throw new DocsFileError('Invalid or oversized export bytes', 'invalid_input')
  return Buffer.from(text, 'base64')
}

class DocsExportServices {
  private disposed = false
  private readonly approved = new Set<string>()
  private readonly imageDirs = new Set<string>()
  private readonly temps = new Set<string>()
  private readonly writes = new Set<Promise<void>>()
  private disposal?: Promise<void>

  constructor(
    private readonly options: DocsExportServicesOptions,
    private readonly tempRoot: string,
  ) {}

  private live(): void {
    this.options.access.assertLive()
    if (this.disposed) throw new DocsFileError('Export service is closed', 'stale_target')
  }

  private failure(error: unknown, committed: boolean | null, path?: string): DocsExportResult {
    return {
      ok: false,
      committed,
      ...(path ? { path } : {}),
      error: error instanceof Error ? error.message : String(error),
      errorCode: error instanceof DocsFileError ? error.errorCode : 'host_failure',
    }
  }

  private async target(
    defaultName: string,
    extension: string,
    outPath?: string,
  ): Promise<string | null> {
    this.live()
    if (outPath) {
      const path = await canonical(outPath)
      if (!this.approved.has(path) && !this.temps.has(path))
        throw new DocsFileError('Export target is not an authorized path', 'permission_denied')
      return path
    }
    const picked = await this.options.dialogs.pickSave({
      defaultName: basename(defaultName).replace(/\.docx$/i, '') + `.${extension}`,
      extension,
    })
    this.live()
    if (!picked) return null
    await this.options.access.grantFile(picked, { write: true })
    const path = await this.options.access.authorize(picked, 'write')
    this.approved.add(path)
    return path
  }

  private async write(path: string, bytes: Uint8Array, starting?: () => void): Promise<void> {
    this.live()
    if (bytes.length > MAX_BYTES)
      throw new DocsFileError('Export exceeds the size limit', 'invalid_input')
    if (this.temps.has(path)) {
      if (
        !inside(this.tempRoot, path) ||
        (await canonical(path)) !== path ||
        (await canonical(this.tempRoot)) !== this.tempRoot
      )
        throw new DocsFileError('Temporary export path changed', 'permission_denied')
    } else {
      if ((await this.options.access.authorize(path, 'write')) !== path)
        throw new DocsFileError('Export path changed', 'permission_denied')
    }
    this.live()
    starting?.()
    const writing = atomicWriteFile(path, Buffer.from(bytes))
    this.writes.add(writing)
    try {
      await writing
    } finally {
      this.writes.delete(writing)
    }
  }

  private async exportFile(
    defaultName: string,
    extension: string,
    outPath: string | undefined,
    data: (path: string, effect: (committed: boolean | null) => void) => Promise<Uint8Array>,
    extra?: () => Partial<DocsExportResult>,
  ): Promise<DocsExportResult> {
    let path: string | null = null
    let committed: boolean | null = false
    try {
      path = await this.target(defaultName, extension, outPath)
      if (!path) return { ok: false, committed: false }
      const effect = (value: boolean | null) => {
        if (committed !== true) committed = value
      }
      const bytes = await data(path, effect)
      this.live()
      await this.write(path, bytes, () => effect(null))
      committed = true
      return { ok: true, path, committed, ...extra?.() }
    } catch (error) {
      return this.failure(error, committed, path ?? undefined)
    }
  }

  private async pdfBytes(
    widthTwips: number,
    heightTwips: number,
    scale?: number,
  ): Promise<Uint8Array> {
    this.live()
    if (!validPrintGeometry(widthTwips, heightTwips, scale))
      throw new DocsFileError('Invalid page size or scale', 'invalid_input')
    const bytes = await this.options.printPdf({
      widthTwips,
      heightTwips,
      ...(scale === undefined ? {} : { scale }),
    })
    this.live()
    if (bytes.length > MAX_BYTES)
      throw new DocsFileError('PDF exceeds the size limit', 'invalid_input')
    return bytes
  }

  async exportPdf(
    defaultName: string,
    widthTwips: number,
    heightTwips: number,
    outPath?: string,
    scale?: number,
    links?: PdfInternalLink[],
  ): Promise<DocsExportResult> {
    if (!validPrintGeometry(widthTwips, heightTwips, scale))
      return this.failure(new DocsFileError('Invalid page size or scale', 'invalid_input'), false)
    return this.exportFile(defaultName, 'pdf', outPath, async () => {
      const bytes = await this.pdfBytes(widthTwips, heightTwips, scale)
      if (!links?.length) return bytes
      const pdf = await PDFDocument.load(bytes)
      addPdfInternalLinks(pdf, links)
      return pdf.save()
    })
  }

  async printPdfBuffer(
    widthTwips: number,
    heightTwips: number,
    scale?: number,
  ): Promise<{ ok: boolean; base64?: string; error?: string; errorCode?: DocsErrorCode }> {
    try {
      return {
        ok: true,
        base64: Buffer.from(await this.pdfBytes(widthTwips, heightTwips, scale)).toString('base64'),
      }
    } catch (error) {
      return this.failure(error, false)
    }
  }

  async exportHtml(defaultName: string, html: string, outPath?: string): Promise<DocsExportResult> {
    if (typeof html !== 'string' || !html || html.length > MAX_BYTES)
      return this.failure(new DocsFileError('Empty or oversized document', 'invalid_input'), false)
    return this.exportFile(defaultName, 'html', outPath, async () =>
      Buffer.from(
        await inlineLazyMediaInHtml(html, (url) => this.options.files.readAsset(url)),
        'utf8',
      ),
    )
  }

  async exportMarkdown(
    defaultName: string,
    markdown: string,
    images: MarkdownImage[],
    outPath?: string,
  ): Promise<DocsExportResult> {
    if (
      typeof markdown !== 'string' ||
      !markdown ||
      markdown.length > MAX_BYTES ||
      !Array.isArray(images)
    )
      return this.failure(
        new DocsFileError('Invalid Markdown document or image list', 'invalid_input'),
        false,
      )
    let imagesDropped = 0
    return this.exportFile(
      defaultName,
      'md',
      outPath,
      async (path, effect) => {
        const parent = dirname(path)
        const written = await writeMarkdownMedia(path, images, {
          readAsset: (url) => this.options.files.readAsset(url),
          authorize: async (path) => {
            this.live()
            if ((await canonical(parent)) !== parent)
              throw new DocsFileError('Markdown export parent changed', 'permission_denied')
            await this.options.access.grantFile(path, { write: true })
            return this.options.access.authorize(path, 'write')
          },
          write: async (path, bytes) => {
            await this.write(path, bytes, () => effect(null))
            effect(true)
          },
        })
        imagesDropped = images.length - written
        const mediaDir = encodeURIComponent(
          basename(path).replace(/\.md$/i, '') + '_files',
        ).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))
        return Buffer.from(
          markdown.split(`${MARKDOWN_MEDIA_DIR_TOKEN}/`).join(`${mediaDir}/`),
          'utf8',
        )
      },
      () => ({ imagesDropped }),
    )
  }

  async saveMergedPdf(
    defaultName: string,
    base64Parts: string[],
    outPath?: string,
    links?: PdfInternalLink[],
  ): Promise<DocsExportResult> {
    return this.exportFile(defaultName, 'pdf', outPath, async () => {
      if (
        !Array.isArray(base64Parts) ||
        base64Parts.length === 0 ||
        base64Parts.length > 1000 ||
        base64Parts.reduce(
          (total, part) => total + (typeof part === 'string' ? part.length : MAX_BASE64_CHARS + 1),
          0,
        ) > MAX_BASE64_CHARS
      )
        throw new DocsFileError('Invalid or oversized PDF parts', 'invalid_input')
      const merged = await PDFDocument.create()
      for (const base64 of base64Parts) {
        const part = await PDFDocument.load(decodeBase64(base64))
        for (const page of await merged.copyPages(part, part.getPageIndices())) merged.addPage(page)
      }
      if (links?.length) addPdfInternalLinks(merged, links)
      return merged.save()
    })
  }

  async pickExportImagesTarget(): Promise<{ dir: string; pdfPath: string } | null> {
    this.live()
    const picked = await this.options.dialogs.pickDirectory()
    this.live()
    if (!picked) return null
    const dir = await this.options.access.validateSelectedDirectory(picked)
    this.live()
    const pdfPath = join(this.tempRoot, `${randomUUID()}.pdf`)
    this.imageDirs.add(dir)
    this.temps.add(pdfPath)
    return { dir, pdfPath }
  }

  async takeExportPdf(
    pdfPath: string,
  ): Promise<{ ok: boolean; base64?: string; error?: string; errorCode?: DocsErrorCode }> {
    let file
    try {
      this.live()
      if (!this.temps.has(pdfPath) || (await canonical(pdfPath)) !== pdfPath)
        throw new DocsFileError('Not an owned image-export temp file', 'permission_denied')
      this.temps.delete(pdfPath)
      file = await open(pdfPath, 'r')
      const info = await file.stat()
      if (!info.isFile() || info.size > MAX_BYTES)
        throw new DocsFileError('Invalid or oversized export PDF', 'invalid_input')
      const bytes = Buffer.alloc(info.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (bytesRead === 0) throw new Error('Temporary PDF changed during the read')
        offset += bytesRead
      }
      this.live()
      return { ok: true, base64: bytes.toString('base64') }
    } catch (error) {
      return this.failure(error, false)
    } finally {
      if (file) {
        await file.close()
        await rm(pdfPath, { force: true })
      }
    }
  }

  async writeExportImage(
    dir: string,
    fileName: string,
    pngBase64: string,
  ): Promise<DocsExportResult> {
    let path: string | undefined
    let committed: boolean | null = false
    try {
      this.live()
      if (!this.imageDirs.has(dir) || (await canonical(dir)) !== dir)
        throw new DocsFileError('Export target is not an authorized folder', 'permission_denied')
      if (
        typeof fileName !== 'string' ||
        fileName !== basename(fileName) ||
        !/^[^/\\:]+\.png$/i.test(fileName)
      )
        throw new DocsFileError('Invalid image file name', 'invalid_input')
      path = await canonical(join(dir, fileName))
      if (!inside(dir, path))
        throw new DocsFileError('Image path escapes its authorized folder', 'permission_denied')
      const bytes = decodeBase64(pngBase64)
      await this.options.access.grantFile(path, { write: true })
      await this.write(path, bytes, () => {
        committed = null
      })
      return { ok: true, path, committed: true }
    } catch (error) {
      return this.failure(error, committed, path)
    }
  }

  async saveImageAs(src: string): Promise<DocsExportResult> {
    try {
      this.live()
      const data = /^data:/i.test(src) ? decodeDataUrl(src) : null
      const image = data
        ? { body: data.bytes, mime: data.mime }
        : await this.options.files.readAsset(src)
      if (
        !image ||
        !image.mime?.startsWith('image/') ||
        image.body.length === 0 ||
        image.body.length > MAX_REMOTE_IMAGE_BYTES
      )
        throw new DocsFileError('Image source is not an owned image asset', 'permission_denied')
      const name = suggestImageFileName(src, image.mime)
      return this.exportFile(
        name.replace(/\.[^.]+$/, ''),
        extname(name).slice(1),
        undefined,
        async () => image.body,
      )
    } catch (error) {
      return this.failure(error, false)
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.approved.clear()
    this.imageDirs.clear()
    this.temps.clear()
    this.disposal = Promise.allSettled([...this.writes]).then(async () => {
      await rm(this.tempRoot, { recursive: true, force: true })
    })
    return this.disposal
  }
}

export type { DocsExportServices }

export async function createDocsExportServices(
  options: DocsExportServicesOptions,
): Promise<DocsExportServices> {
  const state = await canonical(options.stateDirectory)
  await mkdir(state, { recursive: true })
  return new DocsExportServices(options, await mkdtemp(join(state, 'docs-export-')))
}
