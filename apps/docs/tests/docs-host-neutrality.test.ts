import { afterEach, expect, it, vi } from 'vitest'
import {
  createExternalDocsHost,
  getDocsHost,
  getNativeAgentServices,
  type DocsEditorServices,
} from '../src/renderer/host/docs-host'

afterEach(() => vi.unstubAllGlobals())

it('adapts a frozen preload service object without changing its property invariants', async () => {
  const getTheme = vi.fn(async () => 'light' as const)
  const runCli = vi.fn(async () => ({ ok: true, code: 0, stdout: 'file result', stderr: '' }))
  const services: Pick<DocsEditorServices, 'getTheme' | 'runCli'> = Object.freeze({
    getTheme,
    runCli,
  })
  vi.stubGlobal('desktop', services)
  const external = createExternalDocsHost('electron', services as DocsEditorServices)
  expect(await external.services.getTheme()).toBe('light')
  expect(await getDocsHost().getTheme()).toBe('light')
  expect(await external.services.runCli(['docs', 'read', 'example.docx'])).toMatchObject({
    ok: true,
  })
  expect(getDocsHost()).toBe(getDocsHost())
})

it.each(['search', 'image', 'media', 'capabilities'])(
  'keeps the %s CLI provider route outside editor services',
  async (command) => {
    const runCli = vi.fn(async () => ({ ok: true, code: 0, stdout: 'result', stderr: '' }))
    vi.stubGlobal('desktop', { runCli })
    const services: Pick<DocsEditorServices, 'runCli'> = { runCli }
    const external = createExternalDocsHost('browser', services as DocsEditorServices)
    await expect(external.services.runCli([command, 'example'])).rejects.toThrow(/file-only/)
    await expect(getDocsHost().runCli([command, 'example'])).rejects.toThrow(/file-only/)
    expect(runCli).not.toHaveBeenCalled()
    await getDocsHost().runCli(['docs', 'read', 'example.docx'])
    await getNativeAgentServices().runCli([command, 'example'])
    expect(runCli).toHaveBeenCalledTimes(2)
  },
)
