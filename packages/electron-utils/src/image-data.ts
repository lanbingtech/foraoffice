import { MAX_REMOTE_IMAGE_BYTES } from './remote-image'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/tiff': 'tif',
}
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$/i

export interface SaveImageResult {
  ok: boolean
  path?: string
  error?: string
}

/** file:// would let a page read arbitrary local files; blob: lives in the renderer only */
export function isSavableImageUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(file|blob|javascript|about):/i.test(url)
}

function urlFileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).split('/').pop() ?? ''
  } catch {
    return ''
  }
}

/** The URL's own file name when it carries an image extension, else image.<ext from the MIME type> */
export function suggestImageFileName(url: string, mime: string | null | undefined): string {
  const name = urlFileName(url)
  if (name && IMAGE_FILE.test(name)) return name
  const key = (mime ?? '').split(';')[0]!.trim().toLowerCase()
  return `image.${EXT_BY_MIME[key] ?? 'png'}`
}

/** Same byte budget as remote image downloads, checked on the encoded text before allocating. */
const MAX_DATA_URL_PAYLOAD_CHARS = Math.ceil((MAX_REMOTE_IMAGE_BYTES * 4) / 3)

export function decodeDataUrl(url: string): { bytes: Buffer; mime: string | null } | null {
  // The parameter run is `;`-prefixed and its body excludes `;`, so each
  // iteration has exactly one possible length. With `;[^,]*` instead, one
  // iteration could swallow several parameters or several could cover one, and
  // a URL with no comma made the engine try every split - exponential, so a
  // ~100-character data: URL in a document froze the main process when the user
  // chose "Save image".
  const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/i.exec(url)
  if (!m) return null
  const mime = m[1] || null
  const payload = m[3] ?? ''
  if (payload.length > MAX_DATA_URL_PAYLOAD_CHARS) return null
  const isBase64 = (m[2] ?? '').split(';').some((param) => param.toLowerCase() === 'base64')
  // A stray `%` in a non-base64 payload (an unencoded SVG or text URL copied
  // from the web, for example) makes decodeURIComponent throw a URIError.
  // This function's contract is `null` for malformed URLs - the caller turns
  // that into "malformed or oversized data URL" - so trap the throw here
  // instead of leaking "URIError: URI malformed" through every caller.
  let decodedPayload = payload
  if (!isBase64) {
    try {
      decodedPayload = decodeURIComponent(payload)
    } catch {
      return null
    }
  }
  const bytes = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodedPayload, 'utf8')
  if (bytes.length > MAX_REMOTE_IMAGE_BYTES) return null
  return { bytes, mime }
}
