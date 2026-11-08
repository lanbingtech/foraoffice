import { DOCS_IMAGE_MAX_BYTES, DOCS_IMAGE_MAX_BASE64_CHARS } from '../../shared/media-policy'

/** Embedded images are document data, never an instruction to read a local file. */
export function embeddedImageBytes(url: string): { base64: string } {
  if (url.length > DOCS_IMAGE_MAX_BASE64_CHARS + 64)
    throw new Error('Embedded images must not exceed 25 MB')
  const match = /^data:image\/(?:png|jpeg|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url)
  const base64 = match?.[1]
  if (!base64 || base64.length % 4 !== 0)
    throw new Error('Supply a PNG, JPEG or GIF data URL with valid base64 image bytes')
  const bytes = (base64.length / 4) * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (bytes > DOCS_IMAGE_MAX_BYTES) throw new Error('Embedded images must not exceed 25 MB')
  return { base64 }
}
