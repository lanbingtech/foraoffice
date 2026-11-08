import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'
import type { OpenDocxResult } from '../shared/ipc'
import { handOffBytes, takeHandoff } from './byte-handoff'
import {
  commitDocPasswordSave,
  encryptDocx,
  forgetDocPasswords,
  markDiskEncrypted,
  snapshotDocPassword,
  setDocPassword,
  prepareRecoveryDocx,
  decryptRecoveryCopy,
  currentDocPasswordIntentRevision,
  discardDocPasswordIntents,
} from './docx-encryption'
import {
  adoptLazyMediaHashes,
  forgetLazyMediaOwner,
  materializeLazyDocx,
  pointLazyMediaAt,
  readLazyMedia,
} from './lazy-media'
import { readDocxForOpen } from './document-io'
import { archiveOriginal } from './original-archive'
import { RecoveryCopies } from './recovery-copies'
import { isExternallyModified, type DiskFileState } from './external-change'
import { DocsFileError, DocsFileSaveError } from './file-errors'
import { createDocsFileAccess, type DocsFileAccess } from './file-access'

export interface DocsFileSessionOptions {
  stateDirectory: string
  readRoots: readonly string[]
  writeRoots: readonly string[]
}

type SaveOptions = { sourcePath: string | null; overwrite: boolean; allowExternalChanges?: boolean }
type SaveResult =
  | { ok: true; path: string; passwordIntentPending: boolean; dataUrl?: string; committed: true }
  | { ok: false; reason: 'external-modified'; committed: false }

/** File ownership and document bytes are independent of the windowing toolkit. */
class DocsFileSession {
  private readonly owner = randomUUID()
  private readonly handoffs = new Set<string>()
  private readonly openedPaths = new Set<string>()
  private readonly diskStates = new Map<string, DiskFileState>()
  private readonly recovery: RecoveryCopies
  private disposed = false
  private saves: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly policy: DocsFileSessionOptions,
    private readonly access: DocsFileAccess,
  ) {
    this.recovery = new RecoveryCopies(join(policy.stateDirectory, 'docs-autosave'))
  }

  private assertLive(): void {
    if (this.disposed) throw new DocsFileError('Document file session is closed', 'stale_target')
  }

  private async authorize(path: string, purpose: 'read' | 'write'): Promise<string> {
    this.assertLive()
    if (!isAbsolute(path) || extname(path).toLowerCase() !== '.docx') {
      throw new DocsFileError('An absolute .docx path is required', 'invalid_input')
    }
    const resolved = await this.access.authorize(path, purpose)
    this.assertLive()
    return resolved
  }

  /** Called by the trusted host after a native file dialog approves this exact file. */
  async grantFile(path: string): Promise<void> {
    this.assertLive()
    if (!isAbsolute(path) || extname(path).toLowerCase() !== '.docx')
      throw new DocsFileError('An absolute .docx path is required', 'invalid_input')
    await this.access.grantFile(path, { read: true, write: true })
  }

  passwordIntentRevision(): number {
    this.assertLive()
    return currentDocPasswordIntentRevision()
  }

  discardPasswordIntents(throughRevision: number): void {
    this.assertLive()
    if (!Number.isSafeInteger(throughRevision) || throughRevision < 0)
      throw new DocsFileError('Invalid password intent revision', 'invalid_input')
    discardDocPasswordIntents(this.owner, throughRevision)
  }

  async open(
    path: string,
    password?: string,
    recovery?:
      'restore' | 'discard' | ((info: { diskNewer: boolean }) => Promise<'restore' | 'discard'>),
  ): Promise<OpenDocxResult> {
    const filePath = await this.authorize(path, 'read')
    let opened: Awaited<ReturnType<typeof readDocxForOpen>>
    try {
      opened = await readDocxForOpen(filePath, this.owner, password)
    } finally {
      if (this.disposed) {
        forgetDocPasswords(this.owner)
        forgetLazyMediaOwner(this.owner)
      }
    }
    this.assertLive()
    if ('needsPassword' in opened) return opened
    const { encrypted, hash, size } = opened
    let { bytes } = opened
    await archiveOriginal(this.policy.stateDirectory, filePath, hash, size)
    this.assertLive()
    markDiskEncrypted(this.owner, filePath, encrypted)
    const decision =
      typeof recovery === 'function'
        ? await this.recovery.inspect(filePath).then((info) => (info ? recovery(info) : undefined))
        : recovery
    let recovered = false
    if (decision === 'restore' && (await this.recovery.inspect(filePath))) {
      bytes = await decryptRecoveryCopy(this.owner, filePath, await this.recovery.read(filePath))
      await adoptLazyMediaHashes(bytes, filePath, this.owner)
      recovered = true
    } else if (decision === 'discard') this.recovery.clear(filePath)
    this.assertLive()
    this.openedPaths.add(filePath)
    this.diskStates.set(filePath, { size, mtimeMs: opened.mtimeMs, hash })
    const dataUrl = handOffBytes(bytes)
    this.handoffs.add(dataUrl)
    return {
      path: filePath,
      name: basename(filePath),
      dataUrl,
      hash,
      encrypted,
      recovered: recovered || undefined,
    }
  }

  async setPassword(path: string | null, password: string | null): Promise<{ ok: true }> {
    if (password !== null && (typeof password !== 'string' || password.length === 0))
      throw new DocsFileError('A non-empty password or null is required', 'invalid_input')
    const filePath = path === null ? null : await this.authorize(path, 'read')
    this.assertLive()
    if (filePath && !this.openedPaths.has(filePath))
      throw new DocsFileError('The password target is not an opened document', 'permission_denied')
    setDocPassword(this.owner, filePath, password)
    return { ok: true }
  }

  async recoveryInfo(path: string): Promise<{ diskNewer: boolean } | null> {
    const filePath = await this.authorize(path, 'read')
    return this.recovery.inspect(filePath)
  }

  async writeRecovery(path: string, data: Uint8Array): Promise<{ ok: boolean }> {
    const filePath = await this.authorize(path, 'write')
    if (!this.openedPaths.has(filePath))
      throw new DocsFileError('The recovery target is not an opened document', 'permission_denied')
    const ok = await this.recovery.write(
      filePath,
      () => prepareRecoveryDocx(this.owner, filePath, Buffer.from(data)),
      () => !this.disposed && this.openedPaths.has(filePath),
    )
    return { ok }
  }

  async readAsset(url: string): Promise<{ body: Buffer; mime: string } | null> {
    this.assertLive()
    if (this.handoffs.delete(url)) {
      const body = takeHandoff(url)
      return body
        ? { body, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
        : null
    }
    const resource = await readLazyMedia(url, this.owner)
    this.assertLive()
    return resource
  }

  /** Materialize an independent merged document without changing passwords or file state. */
  async materializeDocx(data: Uint8Array): Promise<Buffer> {
    this.assertLive()
    const { bytes } = await materializeLazyDocx(Buffer.from(data), this.owner)
    this.assertLive()
    return Buffer.from(bytes)
  }

  async save(path: string, data: Uint8Array, options: SaveOptions): Promise<SaveResult> {
    const snapshot = Buffer.from(data)
    const result = this.saves.then(() => this.saveOnce(path, snapshot, options))
    this.saves = result.catch(() => undefined)
    return result
  }

  private async saveOnce(
    path: string,
    data: Uint8Array,
    options: SaveOptions,
  ): Promise<SaveResult> {
    let committed: boolean | null = false
    try {
      const filePath = await this.authorize(path, 'write')
      const sourcePath =
        options.sourcePath === null ? null : await this.authorize(options.sourcePath, 'read')
      if (filePath === sourcePath && !options.allowExternalChanges) {
        const disk = await stat(filePath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
        if (
          await isExternallyModified(this.diskStates.get(filePath), disk, async () =>
            createHash('sha256')
              .update(await readFile(filePath))
              .digest('hex'),
          )
        )
          return { ok: false, reason: 'external-modified', committed: false }
      }
      const passwordState = snapshotDocPassword(this.owner, sourcePath)
      const { bytes: plain, hashes } = await materializeLazyDocx(Buffer.from(data), this.owner)
      const bytes = passwordState.password ? encryptDocx(plain, passwordState.password) : plain
      this.assertLive()
      await mkdir(dirname(filePath), { recursive: true })
      await this.authorize(filePath, 'write')
      committed = null
      await atomicWriteFile(filePath, bytes, { overwrite: options.overwrite })
      committed = true
      this.assertLive()
      const { size, mtimeMs } = await stat(filePath)
      this.assertLive()
      this.diskStates.set(filePath, {
        size,
        mtimeMs,
        hash: createHash('sha256').update(bytes).digest('hex'),
      })
      pointLazyMediaAt(hashes, filePath, this.owner, passwordState.password ? plain : undefined)
      const passwordIntentPending = commitDocPasswordSave(this.owner, passwordState, filePath)
      this.openedPaths.add(filePath)
      this.recovery.clear(filePath)
      let dataUrl: string | undefined
      if (passwordState.password && hashes.size > 0) {
        dataUrl = handOffBytes(plain)
        this.handoffs.add(dataUrl)
      }
      return {
        ok: true,
        path: filePath,
        passwordIntentPending,
        committed: true,
        ...(dataUrl ? { dataUrl } : {}),
      }
    } catch (error) {
      const exclusiveConflict =
        !options.overwrite && (error as NodeJS.ErrnoException)?.code === 'EEXIST'
      throw new DocsFileSaveError(error, exclusiveConflict ? false : committed)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const url of this.handoffs) takeHandoff(url)
    this.handoffs.clear()
    this.openedPaths.clear()
    this.diskStates.clear()
    this.access.dispose()
    forgetLazyMediaOwner(this.owner)
    forgetDocPasswords(this.owner)
  }
}

export type { DocsFileSession }

export async function createDocsFileSession(
  options: DocsFileSessionOptions,
): Promise<DocsFileSession> {
  return new DocsFileSession(options, await createDocsFileAccess(options))
}
