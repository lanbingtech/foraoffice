import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useDocsAutoSave } from '../src/renderer/auto-save'
import { installDocsHost, type DocsEditorServices } from '../src/renderer/host/docs-host'
import type { DocsDocumentHost } from '../src/shared/document-host'

let root: Root | undefined
let release: (() => void) | undefined
let state: ReturnType<typeof useDocsAutoSave>
let readOnly = false
function View() {
  state = useDocsAutoSave(readOnly)
  return null
}
async function mount(documents?: DocsDocumentHost) {
  release = installDocsHost({
    kind: 'browser',
    documents,
    services: {
      getAutoSaveDefault: async () => ({ on: true, updatedAt: 0 }),
      onAutoSaveDefaultChanged: () => () => {},
    } as unknown as DocsEditorServices,
  })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(View)))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  readOnly = false
})
afterEach(() => {
  act(() => root?.unmount())
  release?.()
  root = undefined
  release = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it.each([undefined, { enabled: false }, { enabled: true }])(
  'allows managed users to toggle from initial policy %j without changing standalone preferences',
  async (autoSave) => {
    localStorage.setItem('aidocs.autoSave', '1')
    const host: DocsDocumentHost = { autoSave, saveDocument: vi.fn() }
    await mount(host)
    expect(state.autoSave).toBe(autoSave?.enabled === true)
    expect(state.canToggle).toBe(true)
    act(() => state.setAutoSave(true))
    expect(state.autoSave).toBe(true)
    act(() => state.setAutoSave(false))
    expect(state.autoSave).toBe(false)
    expect(localStorage.getItem('aidocs.autoSave')).toBe('1')
    expect(host.autoSave).toBe(autoSave)
  },
)

it.each([true, false])(
  'honors an explicit host toggle lock while preserving its initial enabled=%s',
  async (enabled) => {
    await mount({ autoSave: { enabled, allowToggle: false }, saveDocument: vi.fn() })
    expect(state.canToggle).toBe(false)
    expect(state.autoSave).toBe(enabled)
    act(() => state.setAutoSave(!enabled))
    expect(state.autoSave).toBe(enabled)
  },
)

it.each(['readOnly', 'saveDenied', 'missingSave'] as const)(
  'does not advertise automatic saving when %s prevents persistence',
  async (reason) => {
    readOnly = reason === 'readOnly'
    await mount({
      autoSave: { enabled: true },
      capabilities: reason === 'saveDenied' ? { save: false } : undefined,
      saveDocument: reason === 'missingSave' ? undefined : vi.fn(),
    })
    expect(state.autoSave).toBe(false)
    expect(state.canToggle).toBe(false)
    act(() => state.setAutoSave(true))
    expect(state.autoSave).toBe(false)
  },
)

it('retains the user preference across a read-only document and resets it on editor remount', async () => {
  const host: DocsDocumentHost = { saveDocument: vi.fn() }
  await mount(host)
  act(() => state.setAutoSave(true))
  readOnly = true
  act(() => root!.render(createElement(View)))
  expect(state.autoSave).toBe(false)
  readOnly = false
  act(() => root!.render(createElement(View)))
  expect(state.autoSave).toBe(true)
  act(() => root!.unmount())
  release!()
  await mount(host)
  expect(state.autoSave).toBe(false)
})

it('keeps an explicit host lock authoritative after an earlier user override', async () => {
  const host: DocsDocumentHost = { autoSave: { enabled: false }, saveDocument: vi.fn() }
  await mount(host)
  act(() => state.setAutoSave(true))
  host.autoSave = { enabled: false, allowToggle: false }
  act(() => root!.render(createElement(View)))
  expect(state.canToggle).toBe(false)
  expect(state.autoSave).toBe(false)
})

it('preserves standalone preference persistence and the global default', async () => {
  await mount()
  expect(state.autoSave).toBe(true)
  act(() => state.setAutoSave(false))
  expect(state.autoSave).toBe(false)
  expect(JSON.parse(localStorage.getItem('aidocs.autoSave')!)).toMatchObject({ on: false })
})
