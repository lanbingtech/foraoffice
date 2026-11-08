// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { createDocsFileSession } from '../src/services/document-files'
import { createDocsFileServices } from '../src/services/file-services'
import * as atomic from '@genoffice/electron-utils/atomic-write'

it('reports that bytes were written when the file session closes before its save response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-save-close-'))
  const files = await createDocsFileSession({
    stateDirectory: join(root, '.state'),
    readRoots: [root],
    writeRoots: [root],
  })
  const services = createDocsFileServices({
    files,
    defaultSaveDirectory: root,
    dialogs: {
      pickOpen: async () => null,
      pickSave: async () => null,
      chooseRecovery: async () => 'discard',
      confirmExternalOverwrite: async () => false,
    },
    recentFiles: { list: async () => [], add: async () => {} },
  })
  const write = atomic.atomicWriteFile
  const intercepted = vi
    .spyOn(atomic, 'atomicWriteFile')
    .mockImplementationOnce(async (...args) => {
      await write(...args)
      files.dispose()
    })
  try {
    const bytes = await buildBlankDocx()
    const target = join(root, 'saved.docx')
    expect(
      await services.saveDocxTo(
        target,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        false,
      ),
    ).toMatchObject({ ok: false, committed: true })
    expect(new Uint8Array(await readFile(target))).toEqual(bytes)
  } finally {
    intercepted.mockRestore()
    files.dispose()
  }
})

it('provides pathless protected first-save and dialog-authorized Save As through the common host file contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-file-services-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(workspace), mkdir(outside)])
  const files = await createDocsFileSession({
    stateDirectory: join(root, '.state'),
    readRoots: [workspace],
    writeRoots: [workspace],
  })
  const recent: string[] = []
  const first = join(workspace, 'first.docx')
  const second = join(outside, 'second.docx')
  const services = createDocsFileServices({
    files,
    defaultSaveDirectory: workspace,
    dialogs: {
      pickOpen: async () => second,
      pickSave: async () => second,
      chooseRecovery: async () => 'discard',
      confirmExternalOverwrite: async () => false,
    },
    recentFiles: {
      list: async () => recent,
      add: async (path) => {
        recent.unshift(path)
      },
    },
  })
  try {
    const bytes = await buildBlankDocx()
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    await services.setDocPassword(null, 'first-save-password')
    expect(await services.saveDocxTo(first, buffer, false, null)).toMatchObject({
      ok: true,
      path: first,
    })
    expect((await readFile(first)).subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1')
    expect(await services.saveDocxTo(second, buffer, false, first)).toMatchObject({
      ok: false,
      committed: false,
      errorCode: 'permission_denied',
    })
    expect(await services.saveDocxAs('second.docx', buffer, first)).toMatchObject({
      ok: true,
      path: second,
    })
    expect(await services.openDocx()).toMatchObject({ path: second, encrypted: true })
    const opened = await services.openDocxDecrypt(second, 'first-save-password')
    if (!opened.ok) throw new Error('The protected saved file did not reopen')
    expect((await files.readAsset(opened.result.dataUrl))?.body).toEqual(Buffer.from(bytes))
    expect(await services.getRecentFiles()).toContain(second)
  } finally {
    files.dispose()
  }
})
