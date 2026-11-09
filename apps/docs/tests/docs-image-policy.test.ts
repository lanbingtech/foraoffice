import { expect, it } from 'vitest'
import { embeddedImageBytes } from '../src/renderer/ai/image-input'
import { DOCS_COMMAND_MAX_BYTES, DOCS_IMAGE_MAX_BYTES } from '../src/shared/media-policy'
import { MAX_GENERATED_IMAGE_BYTES } from '@genoffice/electron-utils/generated-images'
import { z } from 'zod'
import { docsToolCatalog } from '../src/shared/tool-catalog'

it.each(['insert_image', 'insert_picture'])(
  'accepts exactly one supported source through the %s public schema',
  (name) => {
    const schema = z.fromJSONSchema(
      docsToolCatalog().find((tool) => tool.name === name)!.inputSchema,
    )
    expect(schema.safeParse({ source: { path: 'D:/images/picture.png' } }).success).toBe(true)
    expect(schema.safeParse({ source: { asset: 'asset:picture' } }).success).toBe(true)
    expect(schema.safeParse({ url: 'https://example.test/picture.png' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(
      schema.safeParse({ source: { path: 'x' }, url: 'https://example.test/a.png' }).success,
    ).toBe(false)
  },
)

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
