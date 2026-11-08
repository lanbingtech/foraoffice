import type { DocumentOwner } from './ownership'
/**
 * Password-protected (ECMA-376 encrypted) docx support. The single integration
 * point for the third-party crypto implementation (officecrypto-tool): if it
 * ever needs replacing, only this module changes.
 *
 * An encrypted docx is not a zip: Word/WPS repackage it as a CFB (OLE2)
 * container holding an EncryptionInfo stream (parameters) and an
 * EncryptedPackage stream (the ciphertext of the real docx zip). Both apps
 * write the same MS-OFFCRYPTO formats (Standard = AES-128/SHA-1, Agile =
 * AES-256/SHA-512), and both open either — so we decrypt both and re-encrypt
 * with Agile, matching Word 2013+ defaults.
 */
import {
  decryptOoxml as decryptDocx,
  encryptOoxml as encryptDocx,
  isEncryptedOoxml as isEncryptedDocx,
  OoxmlDecryptError as DocxDecryptError,
  type OoxmlDecryptFailReason as DecryptFailReason,
} from '@genoffice/electron-utils/ooxml-encryption'

export { decryptDocx, encryptDocx, isEncryptedDocx, DocxDecryptError, type DecryptFailReason }

// ── In-memory password state, keyed per renderer + file path.
// Never persisted: a relaunch re-prompts, exactly like Word/WPS. ──

/** Password that can decrypt the bytes currently on disk. */
const diskPasswords = new Map<DocumentOwner, Map<string, string>>()

interface PasswordIntent {
  password: string | null
  revision: number
}

/** Desired password for the next successful save of an existing document. */
const desiredPasswords = new Map<DocumentOwner, Map<string, PasswordIntent>>()
/** Desired password for the next successful save of a pathless document. */
const pendingNewDocPasswords = new Map<DocumentOwner, PasswordIntent>()
let nextIntentRevision = 1

/** paths whose on-disk bytes are currently encrypted (tracked at open/save time:
 *  deterministic, unlike probing the file, which can transiently fail) */
const diskEncryptedPaths = new Map<DocumentOwner, Set<string>>()

function setDiskPassword(ownerId: DocumentOwner, filePath: string, password: string | null): void {
  const forWc = diskPasswords.get(ownerId) ?? new Map<string, string>()
  if (password) forWc.set(filePath, password)
  else forWc.delete(filePath)
  if (forWc.size > 0) diskPasswords.set(ownerId, forWc)
  else diskPasswords.delete(ownerId)
}

/** Record the current on-disk password (null when the opened file is plain). */
export function rememberDocPassword(
  ownerId: DocumentOwner,
  filePath: string,
  password: string | null,
): void {
  setDiskPassword(ownerId, filePath, password)
}

/** Password for the bytes currently on disk, or null for plain documents. */
export function docPasswordFor(
  ownerId: DocumentOwner,
  filePath: string | null | undefined,
): string | null {
  if (!filePath) return null
  return diskPasswords.get(ownerId)?.get(filePath) ?? null
}

/**
 * Record the user's desired password for the next save. This deliberately does
 * not alter the password for the current on-disk bytes: recovery copies and
 * reopen must keep using that password until a save actually lands.
 */
export function setDocPassword(
  ownerId: DocumentOwner,
  filePath: string | null,
  password: string | null,
): void {
  const intent = { password, revision: nextIntentRevision++ }
  if (filePath) {
    const forWc = desiredPasswords.get(ownerId) ?? new Map<string, PasswordIntent>()
    forWc.set(filePath, intent)
    desiredPasswords.set(ownerId, forWc)
    return
  }
  pendingNewDocPasswords.set(ownerId, intent)
}

/** Capture a cutoff before document-swap cleanup is queued behind an in-flight save. */
export function currentDocPasswordIntentRevision(): number {
  return nextIntentRevision - 1
}

/**
 * The renderer accepted a different document. Discard only intents that
 * existed at the captured cutoff; a password chosen for the replacement
 * document while cleanup waits behind a save must survive.
 */
export function discardDocPasswordIntents(
  ownerId: DocumentOwner,
  throughRevision = Number.MAX_SAFE_INTEGER,
): void {
  const forWc = desiredPasswords.get(ownerId)
  if (forWc) {
    for (const [path, intent] of forWc) {
      if (intent.revision <= throughRevision) forWc.delete(path)
    }
    if (forWc.size === 0) desiredPasswords.delete(ownerId)
  }
  const pending = pendingNewDocPasswords.get(ownerId)
  if (pending && pending.revision <= throughRevision) pendingNewDocPasswords.delete(ownerId)
}

export interface DocPasswordSaveSnapshot {
  readonly sourcePath: string | null
  readonly password: string | null
  readonly intentRevision: number | null
}

/**
 * Snapshot the effective desired state before a save starts. A failed write
 * leaves the snapshot uncommitted, while a successful write commits exactly
 * these bytes without consuming a newer intent recorded during the await.
 */
export function snapshotDocPassword(
  ownerId: DocumentOwner,
  filePath: string | null,
): DocPasswordSaveSnapshot {
  const intent = filePath
    ? desiredPasswords.get(ownerId)?.get(filePath)
    : pendingNewDocPasswords.get(ownerId)
  return {
    sourcePath: filePath,
    password: intent ? intent.password : docPasswordFor(ownerId, filePath),
    intentRevision: intent?.revision ?? null,
  }
}

/**
 * Commit password state only after the atomic file write succeeds. Save As and
 * first-save move a newer concurrent intent to the new path so it remains the
 * desired state for the following save. Returns whether such an intent remains.
 */
export function commitDocPasswordSave(
  ownerId: DocumentOwner,
  snapshot: DocPasswordSaveSnapshot,
  savedPath: string,
): boolean {
  setDiskPassword(ownerId, savedPath, snapshot.password)
  markDiskEncrypted(ownerId, savedPath, snapshot.password !== null)

  const sourcePath = snapshot.sourcePath
  const forWc = desiredPasswords.get(ownerId) ?? new Map<string, PasswordIntent>()

  if (sourcePath === null) {
    const current = pendingNewDocPasswords.get(ownerId)
    // The target may have stale state from an older document opened in this
    // renderer. Its new baseline is the just-written snapshot.
    forWc.delete(savedPath)
    if (current?.revision === snapshot.intentRevision) {
      pendingNewDocPasswords.delete(ownerId)
    } else if (current) {
      pendingNewDocPasswords.delete(ownerId)
      forWc.set(savedPath, current)
    }
  } else if (sourcePath === savedPath) {
    const current = forWc.get(sourcePath)
    if (current?.revision === snapshot.intentRevision) forWc.delete(sourcePath)
  } else {
    const current = forWc.get(sourcePath)
    forWc.delete(sourcePath)
    forWc.delete(savedPath)
    if (current && current.revision !== snapshot.intentRevision) {
      forWc.set(savedPath, current)
    }
  }

  if (forWc.size > 0) desiredPasswords.set(ownerId, forWc)
  else desiredPasswords.delete(ownerId)
  return forWc.has(savedPath)
}

/**
 * Prepare crash-recovery bytes using only the password for the current disk
 * file. Returning null for an encrypted file with missing state is deliberate:
 * skipping a recovery tick is safer than ever writing its plaintext.
 */
export function prepareRecoveryDocx(
  ownerId: DocumentOwner,
  filePath: string,
  plainBytes: Buffer,
): Buffer | null {
  if (!isDiskEncrypted(ownerId, filePath)) return plainBytes
  const password = docPasswordFor(ownerId, filePath)
  return password ? encryptDocx(plainBytes, password) : null
}

/** Decrypt an encrypted recovery copy with the current disk password. */
export async function decryptRecoveryCopy(
  ownerId: DocumentOwner,
  filePath: string,
  bytes: Buffer,
): Promise<Buffer> {
  if (!isEncryptedDocx(bytes)) return bytes
  const password = docPasswordFor(ownerId, filePath)
  if (!password) {
    throw new DocxDecryptError('unsupported', 'missing password for encrypted recovery copy')
  }
  return decryptDocx(bytes, password)
}

/** File renamed on disk: keep disk and desired state reachable under the new path. */
export function renameDocPassword(ownerId: DocumentOwner, oldPath: string, newPath: string): void {
  const forWc = diskPasswords.get(ownerId)
  const password = forWc?.get(oldPath)
  if (forWc && password !== undefined) {
    forWc.delete(oldPath)
    forWc.set(newPath, password)
  }
  const desiredForWc = desiredPasswords.get(ownerId)
  const desired = desiredForWc?.get(oldPath)
  if (desiredForWc && desired) {
    desiredForWc.delete(oldPath)
    desiredForWc.set(newPath, desired)
  }
  const encSet = diskEncryptedPaths.get(ownerId)
  if (encSet?.delete(oldPath)) encSet.add(newPath)
}

/**
 * Record whether the file's on-disk bytes are encrypted; called wherever the
 * main process learns the on-disk state (open, and after every save). Recovery
 * copies key off this: they are only encrypted when the on-disk original is,
 * so a post-crash reopen (which can only ever obtain the on-disk file's
 * password) can always decrypt them.
 */
export function markDiskEncrypted(
  ownerId: DocumentOwner,
  filePath: string,
  encrypted: boolean,
): void {
  const forWc = diskEncryptedPaths.get(ownerId) ?? new Set<string>()
  if (encrypted) forWc.add(filePath)
  else forWc.delete(filePath)
  diskEncryptedPaths.set(ownerId, forWc)
}

/** The file's on-disk bytes are encrypted (as last opened/saved by this renderer). */
export function isDiskEncrypted(ownerId: DocumentOwner, filePath: string): boolean {
  return diskEncryptedPaths.get(ownerId)?.has(filePath) ?? false
}

/** Renderer torn down (tab closed): its passwords must not outlive it. */
export function forgetDocPasswords(ownerId: DocumentOwner): void {
  diskPasswords.delete(ownerId)
  desiredPasswords.delete(ownerId)
  pendingNewDocPasswords.delete(ownerId)
  diskEncryptedPaths.delete(ownerId)
}
