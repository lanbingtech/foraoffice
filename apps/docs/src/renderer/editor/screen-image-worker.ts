import { DOCS_IMAGE_MAX_BYTES } from '../../shared/media-policy'
import type { ScreenImageRequest } from './screen-image-readiness'

// APNG declares acTL before the first IDAT. Keep original browser playback for it.
async function isStaticPng(blob: Blob): Promise<boolean> {
  const bytes = new DataView(await blob.arrayBuffer())
  for (let i = 8; i + 8 <= bytes.byteLength;) {
    const length = bytes.getUint32(i)
    const chunk = bytes.getUint32(i + 4)
    if (chunk === 0x6163544c) return false // acTL
    if (chunk === 0x49444154) return true // IDAT
    i += length + 12
  }
  return false
}

async function prepare({ src, width, height }: ScreenImageRequest): Promise<Blob | null> {
  const response = await fetch(src)
  if (!response.ok || !response.body) return null
  const mime = response.headers.get('Content-Type')
  const reader = response.body.getReader()
  if (mime !== 'image/jpeg' && mime !== 'image/png') {
    await reader.cancel()
    return null
  }
  const parts: Uint8Array<ArrayBuffer>[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > DOCS_IMAGE_MAX_BYTES) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const source = new Blob(parts, { type: mime })
  if (mime === 'image/png' && !(await isStaticPng(source))) return null

  const bitmap = await createImageBitmap(source, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  })
  try {
    const canvas = new OffscreenCanvas(width, height)
    const renderer = canvas.getContext('bitmaprenderer')
    if (!renderer) return null
    renderer.transferFromImageBitmap(bitmap)
    return await canvas.convertToBlob()
  } finally {
    bitmap.close()
  }
}

self.onmessage = async ({ data }: MessageEvent<ScreenImageRequest>) => {
  try {
    self.postMessage(await prepare(data))
  } catch {
    // The original image is already active when a presentation copy fails.
    self.postMessage(null)
  }
}
