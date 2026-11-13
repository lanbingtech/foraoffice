import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { PickImageResult } from '../shared/ipc'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const mimeTypes: Record<string, PickImageResult['mime']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
}

/** Only call with the exact result of a trusted native file picker. */
export async function readPickedImage(path: string): Promise<PickImageResult> {
  const mime = mimeTypes[extname(path).toLowerCase()]
  if (!mime) throw new Error('Choose a PNG, JPEG or GIF image')
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
      throw new Error('The image must be a file of at most 20 MB')
    // Bound the read even if another process grows the selected file after stat.
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) throw new Error('The selected image changed while being read')
      offset += result.bytesRead
    }
    const valid =
      mime === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    if (!valid) throw new Error('The selected file is not a supported image')
    return { base64: bytes.toString('base64'), mime, name: basename(path) }
  } finally {
    await file.close()
  }
}
