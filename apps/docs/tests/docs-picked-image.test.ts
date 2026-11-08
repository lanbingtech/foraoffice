import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPickedImage } from '../src/services/picked-image'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(name: string, bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'docs-picked-image-'))
  roots.push(root)
  const path = join(root, name)
  await writeFile(path, bytes)
  return path
}

it('reads a user-picked image into portable bytes without Electron', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=',
    'base64',
  )
  expect(await readPickedImage(await fixture('picture.PNG', png))).toEqual({
    name: 'picture.PNG',
    mime: 'image/png',
    base64: png.toString('base64'),
  })
})

it('rejects a renamed non-image and an oversized picked file before returning bytes', async () => {
  await expect(
    readPickedImage(await fixture('secret.png', Buffer.from('not an image'))),
  ).rejects.toThrow(/image/)
  const large = await fixture('large.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const handle = await open(large, 'r+')
  try {
    await handle.truncate(20 * 1024 * 1024 + 1)
  } finally {
    await handle.close()
  }
  await expect(readPickedImage(large)).rejects.toThrow(/20 MB/)
})
