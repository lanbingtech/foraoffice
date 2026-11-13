import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAllowed, resolveOutput } from '../src/fs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-policy-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('enforces directional/exact grants and exclusions at the actual CLI file boundary', () => {
  const read = join(dir, 'read'),
    write = join(dir, 'write'),
    state = join(read, 'private')
  mkdirSync(state, { recursive: true })
  mkdirSync(write)
  const exact = join(dir, 'approved.txt'),
    secret = join(state, 'secret.txt'),
    open = join(write, 'open.txt')
  const env = {
    GENOFFICE_ALLOWED_ROOTS: dir,
    GENOFFICE_FILE_POLICY: JSON.stringify({
      readRoots: [read],
      writeRoots: [write],
      readFiles: [exact],
      writeFiles: [],
      deniedRoots: [state],
      deniedWriteFiles: [open],
    }),
  }
  expect(assertAllowed(join(read, 'a.txt'), env, 'read')).toBe(join(read, 'a.txt'))
  expect(() => assertAllowed(join(read, 'a.txt'), env, 'write')).toThrow(/refusing/)
  expect(() => assertAllowed(join(write, 'a.txt'), env, 'read')).toThrow(/refusing/)
  expect(assertAllowed(exact, env, 'read')).toBe(exact)
  expect(() => assertAllowed(join(dir, 'sibling.txt'), env, 'read')).toThrow(/refusing/)
  expect(() => assertAllowed(secret, env, 'read')).toThrow(/refusing/)
  expect(() => assertAllowed(open, env, 'write')).toThrow(/refusing/)
  const link = join(read, 'escape')
  symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => assertAllowed(join(link, 'sibling.txt'), env, 'read')).toThrow(/refusing/)
  expect(() => resolveOutput(secret, { cwd: dir, env })).toThrow(/refusing/)
})

it('fails closed on malformed or empty explicit policy even with permissive legacy roots', () => {
  for (const policy of ['', '{}', 'null', '{', JSON.stringify({ readRoots: ['relative'] })]) {
    expect(() =>
      assertAllowed(
        join(dir, 'x'),
        { GENOFFICE_ALLOWED_ROOTS: dir, GENOFFICE_FILE_POLICY: policy },
        'read',
      ),
    ).toThrow()
  }
  const empty = {
    readRoots: [],
    writeRoots: [],
    readFiles: [],
    writeFiles: [],
    deniedRoots: [],
    deniedWriteFiles: [],
  }
  expect(() =>
    assertAllowed(join(dir, 'x'), { GENOFFICE_FILE_POLICY: JSON.stringify(empty) }, 'read'),
  ).toThrow()
})

it('keeps the existing GUI-open document guard with explicit grants', () => {
  const open = join(dir, 'open.docx')
  writeFileSync(
    join(dir, 'open-documents.json'),
    JSON.stringify({ pid: process.pid, paths: [open] }),
  )
  const env = {
    GENOFFICE_USER_DATA: dir,
    GENOFFICE_FILE_POLICY: JSON.stringify({
      readRoots: [dir],
      writeRoots: [dir],
      readFiles: [],
      writeFiles: [],
      deniedRoots: [],
      deniedWriteFiles: [],
    }),
  }
  expect(() => resolveOutput(open, { cwd: dir, env })).toThrow(/file open/)
})

it('does not follow a grant directory replaced by a junction after host authorization', () => {
  const grant = join(dir, 'grant'),
    outside = join(dir, 'outside')
  mkdirSync(grant)
  mkdirSync(outside)
  const env = {
    GENOFFICE_FILE_POLICY: JSON.stringify({
      readRoots: [grant],
      writeRoots: [],
      readFiles: [],
      writeFiles: [],
      deniedRoots: [],
      deniedWriteFiles: [],
    }),
  }
  renameSync(grant, join(dir, 'old-grant'))
  symlinkSync(outside, grant, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => assertAllowed(join(grant, 'secret.txt'), env, 'read')).toThrow(/refusing/)
})
