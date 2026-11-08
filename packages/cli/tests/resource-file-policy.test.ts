import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, writeMinimalPdf } from './helpers'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-resource-policy-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function policy(readRoots: string[], writeRoots: string[], deniedWriteFiles: string[] = []) {
  return {
    GENOFFICE_AUDIT_LOG: 'off',
    GENOFFICE_FILE_POLICY: JSON.stringify({
      readRoots,
      writeRoots,
      readFiles: [],
      writeFiles: [],
      deniedRoots: [],
      deniedWriteFiles,
    }),
  }
}

it('checks each rendered output against private/open-file exclusions before writing', async () => {
  const pdf = writeMinimalPdf(join(dir, 'source.pdf'))
  const shots = join(dir, 'shots')
  mkdirSync(shots)
  const protectedPage = join(shots, 'source-01.png')
  writeFileSync(protectedPage, 'protected')
  const result = await run(['render', pdf, '--out', shots, '--json'], {
    env: policy([dir], [shots], [protectedPage]),
  })
  expect(result.code).toBe(2)
  expect(result.json().message).toContain('refusing to write')
  expect(readFileSync(protectedPage, 'utf8')).toBe('protected')
})

it('checks grid output independently of its authorized directory', async () => {
  const pdf = writeMinimalPdf(join(dir, 'source.pdf'))
  const shots = join(dir, 'shots')
  mkdirSync(shots)
  const protectedGrid = join(shots, 'source-grid.png')
  writeFileSync(protectedGrid, 'protected')
  const result = await run(['render', pdf, '--out', shots, '--grid', '--json'], {
    env: policy([dir], [shots], [protectedGrid]),
  })
  expect(result.code).toBe(2)
  expect(readFileSync(protectedGrid, 'utf8')).toBe('protected')
})

it('requires individual page authorization rather than broadening an exact directory grant', async () => {
  const sources = join(dir, 'sources')
  mkdirSync(sources)
  writeFileSync(join(sources, '01.json'), JSON.stringify({ title: 'secret', elements: [] }))
  const env = policy([], [dir])
  const grants = JSON.parse(env.GENOFFICE_FILE_POLICY)
  grants.readFiles = [sources]
  env.GENOFFICE_FILE_POLICY = JSON.stringify(grants)
  const result = await run(
    ['create', '--type', 'pptx', '--spec', sources, '--out', join(dir, 'out.pptx'), '--json'],
    { env },
  )
  expect(result.code).toBe(2)
  expect(result.json().message).toContain('refusing to read')
})
