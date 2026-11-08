/// "Save Image As…" for any image the renderer displays: data URLs are decoded
/// in place, everything else (http(s), app asset schemes) goes through
/// net.fetch so custom protocol handlers keep enforcing their own access rules.
import { writeFile } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { showSaveDialogWithMemory } from './dialog-memory'
import { MAX_REMOTE_IMAGE_BYTES, readBodyCapped } from './remote-image'
import {
  decodeDataUrl,
  isSavableImageUrl,
  suggestImageFileName,
  type SaveImageResult,
} from './image-data'
export {
  decodeDataUrl,
  isSavableImageUrl,
  suggestImageFileName,
  type SaveImageResult,
} from './image-data'

async function fetchImageBytes(url: string): Promise<{ bytes: Buffer; mime: string | null }> {
  if (/^data:/i.test(url)) {
    const decoded = decodeDataUrl(url)
    if (!decoded) throw new Error('malformed or oversized data URL')
    return decoded
  }
  const { net } = await import('electron')
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`)
  return {
    bytes: Buffer.from(await readBodyCapped(res, MAX_REMOTE_IMAGE_BYTES)),
    mime: res.headers.get('content-type'),
  }
}

export async function saveImageFromUrl(
  parent: BrowserWindow | null | undefined,
  url: string,
  opts: { title: string; fallbackDir?: string },
): Promise<SaveImageResult> {
  if (!isSavableImageUrl(url)) return { ok: false, error: 'unsupported image url' }
  try {
    const { bytes, mime } = await fetchImageBytes(url)
    const name = suggestImageFileName(url, mime)
    const ext = name.slice(name.lastIndexOf('.') + 1)
    const { dialog } = await import('electron')
    const picked = await showSaveDialogWithMemory(
      dialog,
      parent,
      {
        title: opts.title,
        defaultPath: name,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      },
      opts.fallbackDir,
    )
    if (picked.canceled || !picked.filePath) return { ok: false }
    await writeFile(picked.filePath, bytes)
    return { ok: true, path: picked.filePath }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
