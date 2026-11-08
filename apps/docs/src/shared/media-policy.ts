/** Supports the existing native generated-image limit through every document caller. */
export const DOCS_IMAGE_MAX_BYTES = 25 * 1024 * 1024
export const DOCS_IMAGE_MAX_BASE64_CHARS = Math.ceil(DOCS_IMAGE_MAX_BYTES / 3) * 4

/** One embedded image plus bounded JSON/tool metadata. */
export const DOCS_COMMAND_MAX_BYTES = DOCS_IMAGE_MAX_BASE64_CHARS + 1024 * 1024
