import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DocsEditorApi, OpenDocxResult, McpSaveResult } from '../shared/ipc'
import { DocxDecryptError } from './docx-encryption'
import type { DocsFileSession } from './document-files'
import { DocsFileSaveError } from './file-errors'

export type DocsFileServices = Pick<
  DocsEditorApi,
  | 'openDocx'
  | 'openDocxPath'
  | 'openDocxDecrypt'
  | 'saveDocx'
  | 'saveDocxAs'
  | 'saveDocxNew'
  | 'saveDocxTo'
  | 'setDocPassword'
  | 'docPasswordIntentRevision'
  | 'discardDocPasswordIntents'
  | 'writeRecoveryCopy'
  | 'getRecentFiles'
>

export interface DocsFileDialogs {
  pickOpen(): Promise<string | null>
  pickSave(options: { defaultName: string; sourcePath: string | null }): Promise<string | null>
  chooseRecovery(options: { path: string; diskNewer: boolean }): Promise<'restore' | 'discard'>
  confirmExternalOverwrite(path: string): Promise<boolean>
}

export interface DocsFileServicesOptions {
  files: DocsFileSession
  defaultSaveDirectory: string
  dialogs: DocsFileDialogs
  recentFiles: { list(): Promise<string[]>; add(path: string): Promise<void> }
  onWarning?(message: string): void
}

/** Common file orchestration; native dialogs and application chrome stay in the host. */
export function createDocsFileServices(options: DocsFileServicesOptions): DocsFileServices {
  const { files, dialogs } = options
  const remember = async (path: string) => {
    try {
      await options.recentFiles.add(path)
    } catch (error) {
      ;(options.onWarning ?? console.warn)(
        `Document saved/opened, but recent files could not be updated: ${String(error)}`,
      )
    }
  }
  const open = async (path: string, password?: string): Promise<OpenDocxResult> => {
    const result = await files.open(path, password, (info) =>
      dialogs.chooseRecovery({ path, ...info }),
    )
    if (result && !('needsPassword' in result)) await remember(result.path)
    return result
  }
  const save = async (
    path: string,
    data: ArrayBuffer,
    sourcePath: string | null,
    overwrite: boolean,
    allowExternalChanges = false,
  ): Promise<McpSaveResult & { reason?: 'external-modified' }> => {
    try {
      const result = await files.save(path, new Uint8Array(data), {
        sourcePath,
        overwrite,
        allowExternalChanges,
      })
      if (!result.ok)
        return {
          ...result,
          error:
            'The document was modified outside the editor; confirm replacement before retrying.',
        }
      await remember(result.path)
      return result
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        committed: error instanceof DocsFileSaveError ? error.committed : null,
        errorCode: error instanceof DocsFileSaveError ? error.errorCode : 'host_failure',
      }
    }
  }
  return {
    async openDocx() {
      const path = await dialogs.pickOpen()
      if (!path) return null
      await files.grantFile(path)
      return open(path)
    },
    openDocxPath: (path) => open(path),
    async openDocxDecrypt(path, password) {
      try {
        const result = await open(path, password)
        if (!result || 'needsPassword' in result)
          return { ok: false, reason: 'error', error: 'The document could not be opened' }
        return { ok: true, result }
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof DocxDecryptError ? error.reason : 'error',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    async saveDocx(path, data, auto) {
      const result = await save(path, data, path, true)
      if (
        !result.ok &&
        result.reason === 'external-modified' &&
        !auto &&
        (await dialogs.confirmExternalOverwrite(path))
      )
        return save(path, data, path, true, true)
      return result
    },
    async saveDocxAs(defaultName, data, sourcePath) {
      const path = await dialogs.pickSave({ defaultName, sourcePath: sourcePath ?? null })
      if (!path) return { ok: false }
      await files.grantFile(path)
      return save(path, data, sourcePath ?? null, true, true)
    },
    async saveDocxNew(defaultName, data) {
      const name = basename(defaultName)
      if (name !== defaultName || !/\.docx$/i.test(name))
        return { ok: false, error: 'A .docx file name is required' }
      const stem = name.slice(0, -5)
      let path = join(options.defaultSaveDirectory, name)
      for (let index = 2; existsSync(path); index++)
        path = join(options.defaultSaveDirectory, `${stem}-${index}.docx`)
      return save(path, data, null, false)
    },
    saveDocxTo: (path, data, overwrite, sourcePath) =>
      save(path, data, sourcePath ?? null, overwrite),
    setDocPassword: (path, password) => files.setPassword(path, password),
    async docPasswordIntentRevision() {
      return files.passwordIntentRevision()
    },
    async discardDocPasswordIntents(revision) {
      files.discardPasswordIntents(revision)
      return { ok: true }
    },
    writeRecoveryCopy: (path, data) => files.writeRecovery(path, new Uint8Array(data)),
    getRecentFiles: () => options.recentFiles.list(),
  }
}
