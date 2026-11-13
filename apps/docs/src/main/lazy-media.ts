// Modified for ForaOffice from GenOffice v0.12.852.
import { protocol } from 'electron'
import { DOCX_MEDIA_SCHEME_PRIVILEGE } from '@genoffice/electron-utils'
import { LAZY_MEDIA_SCHEME } from '@genoffice/docx-engine/lazy-media'
import { takeHandoff } from '../services/byte-handoff'
import { readLazyMedia } from '../services/lazy-media'
export * from '../services/lazy-media'

export function registerLazyMediaProtocol(): void {
  if (DOCX_MEDIA_SCHEME_PRIVILEGE.scheme !== LAZY_MEDIA_SCHEME) {
    throw new Error('lazy media scheme privilege registered under another name')
  }
  if (protocol.isProtocolHandled(LAZY_MEDIA_SCHEME)) return
  protocol.handle(LAZY_MEDIA_SCHEME, async (request) => {
    const handed = takeHandoff(request.url)
    if (handed) {
      return new Response(new Uint8Array(handed), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(handed.byteLength),
          'Access-Control-Allow-Origin': '*',
        },
      })
    }
    const media = await readLazyMedia(request.url)
    if (!media) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(media.body), { headers: { 'Content-Type': media.mime } })
  })
}
