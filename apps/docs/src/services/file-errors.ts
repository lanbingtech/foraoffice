import type { DocsErrorCode } from '../shared/operation-result'

export class DocsFileError extends Error {
  constructor(
    message: string,
    readonly errorCode: DocsErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Preserve the actual write outcome and original filesystem code across host adapters. */
export class DocsFileSaveError extends DocsFileError {
  readonly code?: string
  constructor(
    error: unknown,
    readonly committed: boolean | null,
  ) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined
    super(
      error instanceof Error ? error.message : String(error),
      error instanceof DocsFileError
        ? error.errorCode
        : code === 'EACCES' || code === 'EPERM'
          ? 'permission_denied'
          : code === 'EEXIST'
            ? 'invalid_input'
            : 'host_failure',
      { cause: error },
    )
    this.code = code
  }
}
