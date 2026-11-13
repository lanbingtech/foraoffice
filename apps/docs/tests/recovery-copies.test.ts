// @vitest-environment node
import { expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecoveryCopies } from '../src/services/recovery-copies'

it('does not let an invalidated recovery tick remove a later valid copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'foraoffice-recovery-'))
  const store = new RecoveryCopies(directory)
  const document = join(directory, 'source.docx')
  const obsolete = store.write(
    document,
    () => Buffer.from('obsolete'),
    () => true,
  )
  store.clear(document)
  const current = store.write(
    document,
    () => Buffer.from('current'),
    () => true,
  )
  expect(await obsolete).toBe(false)
  expect(await current).toBe(true)
  expect(await readFile(store.pathFor(document), 'utf8')).toBe('current')
})
