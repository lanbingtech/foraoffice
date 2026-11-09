// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDocsFileAccess } from '../src/services/file-access'
import { readAuthorizedImage } from '../src/services/image-source'

it('reads existing image bytes under file grants and refuses revoked, outside or invalid sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-image-source-'))
  const allowed = join(root, 'allowed')
  await mkdir(allowed)
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfVkAAAAASUVORK5CYII=',
    'base64',
  )
  const path = join(allowed, 'picture.png')
  const outside = join(root, 'outside.png')
  await writeFile(path, bytes)
  await writeFile(outside, bytes)
  const access = await createDocsFileAccess({
    stateDirectory: join(root, '.state'),
    readRoots: [allowed],
    writeRoots: [],
  })
  expect((await readAuthorizedImage(access, path)).base64).toBe(bytes.toString('base64'))
  await expect(readAuthorizedImage(access, outside)).rejects.toThrow(/outside/)
  await access.grantFile(outside, { read: true })
  expect((await readAuthorizedImage(access, outside)).mime).toBe('image/png')
  await access.revokeFile(outside)
  await expect(readAuthorizedImage(access, outside)).rejects.toThrow(/outside/)
  await writeFile(path, 'not an image')
  await expect(readAuthorizedImage(access, path)).rejects.toThrow(/not a supported image/)
  access.dispose()
})
