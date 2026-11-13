import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'
import { readMergeDataSource } from '../main/merge-data-source'
import { mergeOutputFileName, mergeOutputPath } from '../main/merge-output'
import type {
  MergeDataSourceResponse,
  MergeOutputRequest,
  MergeOutputResponse,
} from '../shared/ipc'
import type { DocsErrorCode } from '../shared/operation-result'
import { canonical, inside, type DocsFileAccess } from './file-access'
import { DocsFileError } from './file-errors'

export interface DocsMailMergeServicesOptions {
  access: DocsFileAccess
  dialogs: {
    pickSource(): Promise<string | null>
    pickSave(options: { defaultName: string; extension: 'docx' }): Promise<string | null>
    pickDirectory(): Promise<string | null>
  }
  materialize(data: Uint8Array): Promise<Uint8Array>
}

export type DocsMergeOutputResult = MergeOutputResponse & {
  committed: boolean | null
  errorCode?: DocsErrorCode
}
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024

export function createDocsMailMergeServices(options: DocsMailMergeServicesOptions) {
  const failure = (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    errorCode: error instanceof DocsFileError ? error.errorCode : ('host_failure' as const),
  })
  return {
    async pickMergeDataSource(): Promise<
      MergeDataSourceResponse & ({ errorCode?: DocsErrorCode } | null)
    > {
      try {
        options.access.assertLive()
        const picked = await options.dialogs.pickSource()
        options.access.assertLive()
        if (!picked) return null
        await options.access.grantFile(picked, { read: true })
        const path = await options.access.authorize(picked, 'read')
        if (!['.csv', '.xlsx'].includes(extname(path).toLowerCase()))
          throw new DocsFileError('Choose a CSV or XLSX data source', 'invalid_input')
        const info = await stat(path)
        if (!info.isFile() || info.size > 50 * 1024 * 1024)
          throw new DocsFileError('Merge data source exceeds the 50 MB file limit', 'invalid_input')
        const source = await readMergeDataSource(path)
        if ((await options.access.authorize(path, 'read')) !== path)
          throw new DocsFileError('Merge data source path changed', 'permission_denied')
        return { ok: true, source }
      } catch (error) {
        return { ok: false, ...failure(error) }
      }
    },

    async writeMergeOutput(request: MergeOutputRequest): Promise<DocsMergeOutputResult> {
      let count = 0
      let committed: boolean | null = false
      let folder: string | undefined
      let path: string | undefined
      try {
        options.access.assertLive()
        if (
          !request ||
          !['single', 'labels', 'perRecord', 'envelopes'].includes(request.mode) ||
          !Array.isArray(request.files) ||
          request.files.length === 0 ||
          request.files.length > 1000
        )
          throw new DocsFileError('Invalid merge output request', 'invalid_input')
        let total = 0
        const files = request.files.map((file) => {
          if (
            typeof file?.name !== 'string' ||
            file.name.length > 1000 ||
            // eslint-disable-next-line no-control-regex -- native filenames cannot contain control characters
            /[\u0000-\u001f]/.test(file.name) ||
            !(file.data instanceof ArrayBuffer) ||
            file.data.byteLength > 128 * 1024 * 1024
          )
            throw new DocsFileError('Invalid merge output file', 'invalid_input')
          total += file.data.byteLength
          if (total > MAX_OUTPUT_BYTES)
            throw new DocsFileError('Merge output exceeds the size limit', 'invalid_input')
          return { name: file.name, data: new Uint8Array(file.data).slice() }
        })
        const single = request.mode === 'single' || request.mode === 'labels'
        if (single) {
          const picked = await options.dialogs.pickSave({
            defaultName: mergeOutputFileName(files[0].name),
            extension: 'docx',
          })
          options.access.assertLive()
          if (!picked) return { ok: false, canceled: true, committed: false, count: 0 }
          await options.access.grantFile(picked, { write: true })
          path = await options.access.authorize(picked, 'write')
        } else {
          const picked = await options.dialogs.pickDirectory()
          options.access.assertLive()
          if (!picked) return { ok: false, canceled: true, committed: false, count: 0 }
          folder = await options.access.validateSelectedDirectory(picked)
        }
        for (const file of single ? files.slice(0, 1) : files) {
          const target = path ?? mergeOutputPath(folder!, file.name)
          const bytes = await options.materialize(file.data)
          options.access.assertLive()
          if (bytes.byteLength > 128 * 1024 * 1024)
            throw new DocsFileError(
              'Materialized merge file exceeds the size limit',
              'invalid_input',
            )
          if (folder) {
            if ((await canonical(folder)) !== folder || !inside(folder, await canonical(target)))
              throw new DocsFileError(
                'Merge output path escapes its selected folder',
                'permission_denied',
              )
            await options.access.grantFile(target, { write: true })
          }
          if ((await options.access.authorize(target, 'write')) !== target)
            throw new DocsFileError('Merge output path changed', 'permission_denied')
          if (count === 0) committed = null
          try {
            await atomicWriteFile(target, Buffer.from(bytes), { overwrite: single })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST' && count === 0) committed = false
            throw error
          }
          count++
          committed = true
        }
        return { ok: true, count, committed, ...(folder ? { folder } : { path }) }
      } catch (error) {
        return {
          ok: false,
          count,
          committed,
          ...failure(error),
          ...(folder ? { folder } : path ? { path } : {}),
        }
      }
    },
  }
}

export type DocsMailMergeServices = ReturnType<typeof createDocsMailMergeServices>
