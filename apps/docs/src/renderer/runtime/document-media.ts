import type { Editor } from '@tiptap/core'
import type { ToolExecution } from '@genoffice/agent-core'
import type { DocsOperationResult, DocsErrorCode } from '../../shared/operation-result'
import { imageBlockSource } from '../ai/tools'
import { DOCS_IMAGE_MAX_BYTES } from '../../shared/media-policy'

type MediaResult = ToolExecution & Pick<DocsOperationResult, 'media' | 'errorCode'>
const refused = (output: string, errorCode: DocsErrorCode): MediaResult => ({
  output,
  errorCode,
  summary: 'Document image',
  isError: true,
  mutated: false,
})

/** Reads bytes only; media inference is owned by the Harness. */
export async function readDocumentMedia(
  editor: Editor,
  blockIndex: number,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<MediaResult> {
  const image = imageBlockSource(editor, blockIndex)
  if (!image)
    return refused(
      'The block is not an accessible document image; read fresh document context.',
      'invalid_input',
    )
  if (!isCurrent())
    return refused('Read fresh document context before accessing this image.', 'stale_target')
  try {
    const response = await fetch(image.src, { signal })
    if (!response.ok)
      return refused(
        `The host could not read this image (HTTP ${response.status}).`,
        'host_failure',
      )
    const mimeType = response.headers.get('content-type')?.split(';')[0] ?? ''
    if (!mimeType.startsWith('image/'))
      return refused('The host did not return an image resource.', 'host_failure')
    const reader = response.body?.getReader()
    if (!reader) return refused('The host returned no image bytes.', 'host_failure')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > DOCS_IMAGE_MAX_BYTES) {
        await reader.cancel()
        return refused('The image exceeds the 25 MB media-read limit.', 'unavailable')
      }
      chunks.push(value)
    }
    if (size === 0) return refused('The host returned an empty image resource.', 'host_failure')
    if (signal.aborted) return refused('The image read was canceled.', 'canceled')
    if (!isCurrent())
      return refused(
        'The document changed while the image was read; read fresh context.',
        'stale_target',
      )
    let binary = ''
    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.length; offset += 32_768)
        binary += String.fromCharCode(...chunk.subarray(offset, offset + 32_768))
    }
    return {
      output: `Image from document block ${blockIndex}.`,
      summary: 'Document image',
      mutated: false,
      media: { data: btoa(binary), mimeType },
    }
  } catch {
    return refused(
      signal.aborted
        ? 'The image read was canceled.'
        : 'The host image resource could not be read.',
      signal.aborted ? 'canceled' : 'host_failure',
    )
  }
}
