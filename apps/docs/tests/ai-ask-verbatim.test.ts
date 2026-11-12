import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { AiAskPopover } from '../src/renderer/components/AiAskPopover'
import { LocaleProvider, setModuleLang } from '../src/renderer/i18n/locale'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  vi.restoreAllMocks()
})

function fixture(queueEnabled = false) {
  Object.assign(window, { desktop: { onLanguageChanged: () => () => {} } })
  setModuleLang('en')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: '<p>Selected text</p>',
  })
  editor.commands.setTextSelection({ from: 1, to: 9 })
  editor.isFocused = true
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 10, right: 50, top: 20, bottom: 35 })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onSendNow = vi.fn<(text: string) => void>()
  const onQueueAdd = vi.fn<(text: string) => void>()
  act(() =>
    root.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(AiAskPopover, {
          editor,
          queueEnabled,
          queueFull: false,
          getItem: () => undefined,
          onSendNow,
          onQueueAdd,
          onQueueUpdate: () => {},
          onQueueRemove: () => {},
        }),
      }),
    ),
  )
  cleanup.push(() => {
    act(() => root.unmount())
    editor.destroy()
    container.remove()
  })
  const trigger = container.querySelector<HTMLButtonElement>('.ai-ask-trigger')!
  expect(trigger).not.toBeNull()
  act(() => trigger.click())
  const input = container.querySelector<HTMLInputElement>('.ai-ask-pop-input')!
  const setText = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  return { container, input, setText, onSendNow, onQueueAdd }
}

describe('Ask AI immediate instructions', () => {
  it.each(['enter', 'confirm', 'local-send'] as const)(
    'preserves leading and trailing spaces with %s',
    (entry) => {
      const { container, input, setText, onSendNow, onQueueAdd } = fixture(entry === 'local-send')
      const instruction = '  Keep these exact words.  '
      setText(instruction)
      act(() => {
        if (entry === 'enter')
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        else
          container
            .querySelector<HTMLButtonElement>(
              entry === 'confirm' ? '.ai-ask-confirm' : '.ai-ask-cancel',
            )!
            .click()
      })
      expect(onSendNow).toHaveBeenCalledExactlyOnceWith(instruction)
      expect(onQueueAdd).not.toHaveBeenCalled()
    },
  )

  it('continues to reject blank instructions', () => {
    const { container, input, setText, onSendNow, onQueueAdd } = fixture()
    setText('   ')
    expect(container.querySelector<HTMLButtonElement>('.ai-ask-confirm')!.disabled).toBe(true)
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSendNow).not.toHaveBeenCalled()
    expect(onQueueAdd).not.toHaveBeenCalled()
  })
})
