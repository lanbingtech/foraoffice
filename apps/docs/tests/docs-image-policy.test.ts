import { expect, it } from 'vitest'
import { embeddedImageBytes } from '../src/renderer/ai/image-input'
import { DOCS_COMMAND_MAX_BYTES, DOCS_IMAGE_MAX_BYTES } from '../src/shared/media-policy'
import { MAX_GENERATED_IMAGE_BYTES } from '@genoffice/electron-utils/generated-images'

it('carries the existing native image limit through the same ordinary byte-input and host envelope', () => {
  expect(DOCS_IMAGE_MAX_BYTES).toBe(MAX_GENERATED_IMAGE_BYTES)
  const base64 = Buffer.alloc(DOCS_IMAGE_MAX_BYTES).toString('base64')
  const url = `data:image/png;base64,${base64}`
  expect(embeddedImageBytes(url).base64).toBe(base64)
  expect(
    Buffer.byteLength(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'image',
        method: 'docs.request',
        params: {
          message: { command: 'execute_tool', payload: { name: 'insert_image', input: { url } } },
        },
      }),
    ),
  ).toBeLessThan(DOCS_COMMAND_MAX_BYTES)
  const oversized = Buffer.alloc(DOCS_IMAGE_MAX_BYTES + 1).toString('base64')
  expect(() => embeddedImageBytes(`data:image/png;base64,${oversized}`)).toThrow(/25 MB/)
})
