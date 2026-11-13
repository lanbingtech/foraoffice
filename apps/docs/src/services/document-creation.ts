import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'
import { buildPrintableHtml, type PrintableHtml } from '@genoffice/electron-utils/print-html-pdf'
import type { CreateDocumentRequest, CreateDocumentResult } from '../shared/ipc'
import type { DocsSaveOutcome } from '../shared/operation-result'
import type { DocsFileAccess } from './file-access'
import { DocsFileError } from './file-errors'

export interface DocsDocumentCreationOptions {
  access: Pick<DocsFileAccess, 'authorize'>
  directory: string
  /** Create a view, fill it through the editor and acknowledge its actual first save. */
  createWord(content: { title: string; html: string; path: string }): Promise<DocsSaveOutcome>
  /** Render the shared sanitized template; the host returns bytes without writing a file. */
  printHtml(html: PrintableHtml): Promise<Uint8Array>
  openFile?(path: string): Promise<boolean>
}

const requestSchema = z
  .object({
    type: z.enum(['docx', 'pdf', 'md', 'html']),
    title: z.string().refine((value) => value.trim().length > 0, 'title must not be empty'),
    content: z.string().refine((value) => value.trim().length > 0, 'content must not be empty'),
  })
  .strict()

export function sanitizeDocumentFileBase(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80)
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'Untitled'
}

/** File creation is shared; native hosts own only view creation and print surfaces. */
export function createDocsDocumentCreation(options: DocsDocumentCreationOptions) {
  const reserved = new Set<string>()
  return {
    async create(raw: CreateDocumentRequest): Promise<CreateDocumentResult> {
      let committed: boolean | null = false
      let path: string | undefined
      try {
        const request = requestSchema.safeParse(raw)
        if (!request.success)
          return {
            ok: false,
            committed: false,
            errorCode: 'invalid_input',
            error: request.error.message,
          }
        const { type, content } = request.data
        const title = sanitizeDocumentFileBase(request.data.title)
        for (let suffix = 1; ; suffix++) {
          const candidate = await options.access.authorize(
            join(options.directory, `${title}${suffix > 1 ? `-${suffix}` : ''}.${type}`),
            'write',
          )
          if (reserved.has(candidate)) continue
          try {
            await stat(candidate)
            continue
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (reserved.has(candidate)) continue
          reserved.add(candidate)
          path = candidate
          break
        }
        if (type === 'docx') {
          committed = null
          const saved = await options.createWord({ title, html: content, path })
          const ok = saved.ok && saved.committed === true && !saved.pending
          return {
            ok,
            committed: saved.committed,
            ...(ok ? { opened: true } : {}),
            ...(saved.path ? { path: saved.path } : {}),
            ...(!ok
              ? { error: saved.error ?? 'The new Word document has not completed its first save' }
              : {}),
            ...(saved.errorCode ? { errorCode: saved.errorCode } : {}),
          }
        }
        const bytes =
          type === 'pdf'
            ? await options.printHtml(buildPrintableHtml(title, content))
            : Buffer.from(content, 'utf8')
        await options.access.authorize(path, 'write')
        committed = null
        await atomicWriteFile(path, Buffer.from(bytes), { overwrite: false })
        committed = true
        let opened = false
        if (options.openFile) {
          try {
            opened = await options.openFile(path)
          } catch {
            /* The file remains created when the host cannot open its viewer. */
          }
        }
        return { ok: true, path, committed, opened }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') committed = false
        return {
          ok: false,
          committed,
          errorCode: error instanceof DocsFileError ? error.errorCode : 'host_failure',
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        if (path) reserved.delete(path)
      }
    },
  }
}
