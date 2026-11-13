import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'
import { decodeDataUrl } from '@genoffice/electron-utils/image-data'
import type { MarkdownImage } from '../shared/ipc'
import { canonical, inside } from './file-access'
import { DocsFileError } from './file-errors'

export interface MarkdownMediaOptions {
  readAsset(url: string): Promise<{ body: Uint8Array; mime: string } | null>
  authorize?(path: string): Promise<string>
  write?(path: string, bytes: Buffer): Promise<void>
}

/** Shared native/portable Markdown media writer; a file grant permits only its derived assets. */
export async function writeMarkdownMedia(
  mdPath: string,
  images: MarkdownImage[],
  options: MarkdownMediaOptions,
): Promise<number> {
  if (images.length > 1000) throw new DocsFileError('Too many Markdown images', 'invalid_input')
  if (images.length === 0) return 0
  const dir = join(
    await canonical(dirname(mdPath)),
    basename(mdPath).replace(/\.md$/i, '') + '_files',
  )
  let written = 0
  let total = 0
  for (const image of images) {
    if (
      typeof image?.name !== 'string' ||
      !/^image\d+\.\w+$/.test(image.name) ||
      typeof image.src !== 'string'
    )
      continue
    const data = /^data:/i.test(image.src) ? decodeDataUrl(image.src) : null
    const asset =
      data && data.mime?.startsWith('image/')
        ? { body: data.bytes }
        : await options.readAsset(image.src)
    if (!asset?.body.length) continue
    total += asset.body.length
    if (total > 128 * 1024 * 1024)
      throw new DocsFileError('Markdown images exceed the export size limit', 'invalid_input')
    const path = await canonical(join(dir, image.name))
    if ((await canonical(dir)) !== dir || !inside(dir, path))
      throw new DocsFileError(
        'Markdown media path escapes its authorized folder',
        'permission_denied',
      )
    const target = options.authorize ? await options.authorize(path) : path
    if (written === 0) await mkdir(dir, { recursive: true })
    if ((await canonical(dir)) !== dir || !inside(dir, await canonical(target)))
      throw new DocsFileError('Markdown media folder changed', 'permission_denied')
    await (options.write ?? ((path, bytes) => atomicWriteFile(path, bytes)))(
      target,
      Buffer.from(asset.body),
    )
    written++
  }
  return written
}
