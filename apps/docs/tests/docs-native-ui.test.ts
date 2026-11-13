import { afterEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { nativeDocsAgentUi } from '../src/renderer/ai/native-ui'
import { AI_PROVIDERS, type AiSettings } from '@genoffice/ai-provider/browser'

vi.mock('../src/renderer/ai/AiPanel', () => ({
  AiPanel: () => createElement('input', { 'data-native-conversation': true, defaultValue: '' }),
}))
afterEach(() => vi.unstubAllGlobals())

it('shows settings failures and preserves a loaded conversation when a refresh fails', async () => {
  let refresh!: () => void
  const settings: AiSettings = {
    provider: 'anthropic',
    providers: Object.fromEntries(
      AI_PROVIDERS.map((provider) => [provider.id, { apiKey: '', model: provider.defaultModel }]),
    ) as AiSettings['providers'],
  }
  const getAiSettings = vi
    .fn<() => Promise<AiSettings>>()
    .mockRejectedValue(new Error('Settings unavailable'))
  vi.stubGlobal('desktop', {
    getAiSettings,
    onAiSettingsChanged: (listener: () => void) => {
      refresh = listener
      return () => {}
    },
  })
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(createElement(nativeDocsAgentUi.Panel, { editor, blocks: [] })),
    )
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Settings unavailable')
    expect(container.querySelector('input')).toBeNull()
    getAiSettings.mockResolvedValueOnce(settings)
    await act(async () => refresh())
    expect(container.querySelector('[role=alert]')).toBeNull()
    const conversation = container.querySelector('input')!
    conversation.value = 'Unsent draft'
    await act(async () => refresh())
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Settings unavailable')
    expect(container.querySelector('input')).toBe(conversation)
    expect(conversation.value).toBe('Unsent draft')
  } finally {
    act(() => root.unmount())
    editor.destroy()
  }
})
