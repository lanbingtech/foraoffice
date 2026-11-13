import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  decryptDocx,
  docPasswordFor,
  isEncryptedDocx,
  rememberDocPassword,
} from './docx-encryption'
import { openLazyDocx } from './lazy-media'
import type { DocumentOwner } from './ownership'
import type { OpenFileNeedsPassword } from '../shared/ipc'

export const MAX_DOCX_OPEN_BYTES = 512 * 1024 * 1024
export class DocxOpenTooLargeError extends Error {}
export interface ReadDocxBytes {
  bytes: Buffer
  size: number
  mtimeMs: number
  hash: string
  encrypted: boolean
}

/** Reads and decrypts the same document bytes for both Electron and independent hosts. */
export async function readDocxForOpen(
  filePath: string,
  owner: DocumentOwner,
  password?: string,
): Promise<ReadDocxBytes | OpenFileNeedsPassword> {
  const { size, mtimeMs } = await stat(filePath)
  const lazy = await openLazyDocx(filePath, owner)
  if ((lazy?.bytes.length ?? size) > MAX_DOCX_OPEN_BYTES)
    throw new DocxOpenTooLargeError(`${basename(filePath)}: document exceeds the open size limit`)
  const original = lazy?.bytes ?? (await readFile(filePath))
  const encrypted = isEncryptedDocx(original)
  const pwd = password ?? docPasswordFor(owner, filePath)
  if (encrypted && !pwd)
    return { needsPassword: true as const, path: filePath, name: basename(filePath) }
  const bytes = encrypted ? await decryptDocx(original, pwd!) : original
  rememberDocPassword(owner, filePath, encrypted ? pwd! : null)
  return {
    bytes,
    size,
    mtimeMs,
    hash: lazy?.hash ?? createHash('sha256').update(original).digest('hex'),
    encrypted,
  }
}
