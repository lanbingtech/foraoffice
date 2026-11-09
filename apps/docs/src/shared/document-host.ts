import type { DocsSaveOutcome } from './operation-result'

export type DocsDocumentOperation = 'new' | 'open' | 'save' | 'saveAs' | 'export' | 'create'
export interface DocsHostedIdentity {
  id: string
  name: string
  readOnly?: boolean
}
export interface DocsHostedDocument extends DocsHostedIdentity {
  /** Omit for a new blank document. Opened content is complete DOCX bytes. */
  data?: ArrayBuffer
}
export interface DocsHostedSaveRequest {
  document: DocsHostedIdentity
  data: ArrayBuffer
  kind: 'save' | 'saveAs'
  auto: boolean
  /** A caller proposal, never authority to write a local file. */
  requestedPath?: string
  overwrite?: boolean
}
export interface DocsHostedSaveOutcome extends DocsSaveOutcome {
  document?: DocsHostedIdentity
  /** Required for Save As. true also requires document; false preserves current identity and dirty state. */
  adopt?: boolean
}
export interface DocsDocumentHost {
  capabilities?: Partial<Record<DocsDocumentOperation, boolean>>
  autoSave?: { enabled: boolean; intervalMs?: number; onBlur?: boolean }
  initialDocument?(): Promise<DocsHostedDocument | null>
  newDocument?(): Promise<DocsHostedDocument | null>
  openDocument?(id?: string): Promise<DocsHostedDocument | null>
  recentDocuments?(): Promise<DocsHostedIdentity[]>
  saveDocument?(request: DocsHostedSaveRequest): Promise<DocsHostedSaveOutcome>
  createDocument?(request: { type: string; title: string; content: string }): Promise<{
    ok: boolean
    committed?: boolean | null
    pending?: boolean
    error?: string
    opened?: boolean
  }>
}

export interface DocsDocumentCommands {
  new: () => Promise<boolean>
  open(id?: string): Promise<boolean>
  save(saveAs?: boolean): Promise<boolean>
  state(): (DocsHostedIdentity & { path: string | null; dirty: boolean }) | null
}

export function assertDocumentOperation(
  host: DocsDocumentHost,
  operation: DocsDocumentOperation,
): void {
  if (host.capabilities?.[operation] === false)
    throw new Error(`The host disabled the ${operation} document operation`)
}

export function validateHostedIdentity(document: DocsHostedIdentity): void {
  if (
    !document ||
    typeof document.id !== 'string' ||
    !document.id ||
    typeof document.name !== 'string' ||
    !document.name ||
    (document.readOnly !== undefined && typeof document.readOnly !== 'boolean')
  )
    throw new Error('The host returned an invalid document identity')
}
