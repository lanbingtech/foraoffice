import { getDocsHost } from '../host/docs-host'
import { embeddedImageBytes } from './image-input'

export type DocsImageSource = { path: string } | { asset: string }
export function toolImageSource(input: Record<string, unknown>): string | DocsImageSource {
  if (input.source !== undefined) {
    if (input.url !== undefined) throw new Error('Specify an image URL or source, not both')
    const source = input.source as Record<string, unknown> | null
    if (
      !source ||
      typeof source !== 'object' ||
      Object.keys(source).length !== 1 ||
      !(
        (typeof source.path === 'string' && source.path) ||
        (typeof source.asset === 'string' && source.asset)
      )
    )
      throw new Error('An image source must specify a path or asset reference')
    return source as DocsImageSource
  }
  const url = String(input.url ?? '')
  if (!/^https?:\/\/|^data:image\//.test(url))
    throw new Error('An http(s)/data image URL or authorized source is required')
  return url
}
export async function readToolImage(source: string | DocsImageSource) {
  if (typeof source === 'string')
    return source.startsWith('data:')
      ? embeddedImageBytes(source)
      : getDocsHost().fetchImage(source)
  const host = getDocsHost()
  if (!host.readImageSource) throw new Error('The host does not provide image source access')
  const image = await host.readImageSource(source)
  if (!image) return null
  // Apply the existing byte limit even when an external resolver supplies the resource.
  return embeddedImageBytes(`data:${image.mime};base64,${image.base64}`)
}
