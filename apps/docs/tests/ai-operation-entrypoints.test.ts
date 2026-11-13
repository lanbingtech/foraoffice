import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { LocaleProvider, setModuleLang, t } from '../src/renderer/i18n/locale'
import { ReviewTab, AI_REWRITE_ACK_KEY } from '../src/renderer/components/ribbon-tabs'
import { Ribbon } from '../src/renderer/components/Ribbon'
import { EditorContextMenu } from '../src/renderer/components/ContextMenu'
import { computeFormatState } from '../src/renderer/components/ribbon-format-state'
import type { DocsAiOperation } from '../src/shared/editor-action'
import { ribbonProps } from './helpers/ribbon-props'

const cleanup: Array<() => void> = []
const noop = () => {}
type Preset = (instruction: string, operation: DocsAiOperation) => void
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  localStorage.clear()
  setModuleLang('zh')
})

function editorFixture() {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    editorProps: { handleScrollToSelection: () => true },
    content: '<p>EVs market research</p>',
  })
  cleanup.push(() => editor.destroy())
  return editor
}

function mount(language: 'en' | 'zh', element: ReactElement) {
  Object.assign(window, { desktop: { onLanguageChanged: () => () => {} } })
  setModuleLang(language)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(createElement(LocaleProvider, { initial: language, children: element })))
  cleanup.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  return container
}

function button(container: HTMLElement, label: string) {
  const target = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) =>
      element.querySelector('.ctx-label')?.textContent === label ||
      element.textContent?.trim() === label,
  )
  expect(target, `button ${label}`).toBeDefined()
  return target!
}

function Review({ editor, onAiPreset }: { editor: Editor; onAiPreset: Preset }) {
  const [dropdown, setDropdown] = useState<string | null>(null)
  return createElement(ReviewTab, {
    ...ribbonProps(editor, computeFormatState(editor)),
    dropdown,
    setDropdown,
    onAiPreset,
    openCommentCount: 1,
    revisionCount: 1,
  })
}

describe.each(['en', 'zh'] as const)('built-in AI operation descriptors in %s', (language) => {
  it('distinguishes whole-document and selected proofreading without inspecting instruction text', () => {
    const editor = editorFixture()
    const onAiPreset = vi.fn<Preset>()
    localStorage.setItem(AI_REWRITE_ACK_KEY, '1')
    const container = mount(language, createElement(Review, { editor, onAiPreset }))
    act(() => button(container, t('ribbonEditorBtn')).click())
    expect(onAiPreset).toHaveBeenLastCalledWith(t('ribbonEditorPrompt'), {
      operationId: 'proofread_document',
      parameters: {},
    })
    editor.commands.setTextSelection({ from: 1, to: 4 })
    act(() => button(container, t('ribbonEditorBtn')).click())
    expect(onAiPreset).toHaveBeenLastCalledWith(t('ribbonEditorSelectionPrompt'), {
      operationId: 'proofread_selection',
      parameters: {},
    })
  })

  it('passes the original target language code for both translation scopes', () => {
    const editor = editorFixture()
    const onAiPreset = vi.fn<Preset>()
    localStorage.setItem(AI_REWRITE_ACK_KEY, '1')
    const container = mount(language, createElement(Review, { editor, onAiPreset }))
    for (const selection of [false, true]) {
      if (selection) editor.commands.setTextSelection({ from: 1, to: 4 })
      act(() => button(container, t('ribbonTranslate')).click())
      act(() => button(container, t('ribbonTranslateTo', { lang: t('ribbonLangFrench') })).click())
      expect(onAiPreset).toHaveBeenLastCalledWith(
        t(selection ? 'ribbonTranslateSelectionPrompt' : 'ribbonTranslatePrompt', {
          lang: t('ribbonLangFrench'),
        }),
        {
          operationId: selection ? 'translate_selection' : 'translate_document',
          parameters: { targetLanguage: 'fr' },
        },
      )
    }
  })

  it('identifies comment processing and revision summarizing independently', () => {
    const editor = editorFixture()
    const onAiPreset = vi.fn<Preset>()
    const container = mount(language, createElement(Review, { editor, onAiPreset }))
    act(() => button(container, t('ribbonAiComments')).click())
    expect(onAiPreset).toHaveBeenLastCalledWith(t('ribbonAiCommentsPrompt'), {
      operationId: 'resolve_comments',
      parameters: {},
    })
    act(() => button(container, t('ribbonAiRevisions')).click())
    expect(onAiPreset).toHaveBeenLastCalledWith(t('ribbonAiRevisionsPrompt'), {
      operationId: 'summarize_revisions',
      parameters: {},
    })
  })

  it('uses the same selection-translation operation in the context menu and carries synonyms metadata', () => {
    const editor = editorFixture()
    editor.commands.setTextSelection({ from: 1, to: 4 })
    const onAiPreset = vi.fn<Preset>()
    const container = mount(
      language,
      createElement(EditorContextMenu, {
        editor,
        menu: { x: 10, y: 10 },
        onClose: noop,
        onFontDialog: noop,
        onParagraphDialog: noop,
        onLink: noop,
        onNewComment: noop,
        onViewImage: noop,
        onSaveImageAs: noop,
        onAiPreset,
      }),
    )
    act(() => button(container, t('appSynonyms')).click())
    expect(onAiPreset).toHaveBeenLastCalledWith(t('appSynonymsPrompt', { text: 'EVs' }), {
      operationId: 'suggest_synonyms',
      parameters: {},
    })
    act(() =>
      button(container, t('appTranslate')).dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      ),
    )
    act(() => button(container, t('appTranslateTo', { lang: t('appLangFrench') })).click())
    expect(onAiPreset).toHaveBeenLastCalledWith(
      t('appTranslateSelectionPrompt', { text: 'EVs', lang: t('appLangFrench') }),
      { operationId: 'translate_selection', parameters: { targetLanguage: 'fr' } },
    )
  })

  it('marks existing Home shortcuts as built-ins while preserving their default instructions', () => {
    const editor = editorFixture()
    const onAiPreset = vi.fn<Preset>()
    const container = mount(
      language,
      createElement(Ribbon, { ...ribbonProps(editor, computeFormatState(editor)), onAiPreset }),
    )
    const actions = [
      ['aiSummarizeBtn', 'aiSummarizePrompt', 'summarize_document'],
      ['aiPolishBtn', 'aiPolishPrompt', 'polish_document'],
      ['aiTidyBtn', 'aiTidyPrompt', 'format_document'],
      ['aiMindMapBtn', 'aiMindMapPrompt', 'create_mind_map'],
    ] as const
    for (const [label, prompt, operationId] of actions) {
      act(() => button(container, t(label)).click())
      expect(onAiPreset).toHaveBeenLastCalledWith(t(prompt), { operationId, parameters: {} })
    }
    editor.commands.setTextSelection({ from: 1, to: 4 })
    act(() => button(container, t('aiPolishBtn')).click())
    expect(onAiPreset).toHaveBeenLastCalledWith(t('aiPolishSelectionPrompt'), {
      operationId: 'polish_selection',
      parameters: {},
    })
  })
})
