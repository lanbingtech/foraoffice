import { expect, it, vi } from 'vitest'

it.each(
  ['MacIntel', 'Win32', 'Linux x86_64'].flatMap((platform) =>
    [false, true].map((inTab) => ({ platform, inTab })),
  ),
)(
  'reserves window chrome only for standalone $platform (tab=$inTab)',
  async ({ platform, inTab }) => {
    vi.resetModules()
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('desktop', { onLanguageChanged: () => () => {} })
    window.history.replaceState(null, '', inTab ? '/?mode=tab' : '/')
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Editor } = await import('@tiptap/core')
    const { editorExtensions } = await import('../src/renderer/editor/extensions')
    const { computeFormatState } = await import('../src/renderer/components/ribbon-format-state')
    const { Ribbon } = await import('../src/renderer/components/Ribbon')
    const { LocaleProvider } = await import('../src/renderer/i18n/locale')
    const { ribbonProps } = await import('./helpers/ribbon-props')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: { type: 'doc', content: [{ type: 'docParagraph' }] },
    })
    try {
      for (const embedded of [false, true]) {
        act(() =>
          root.render(
            createElement(LocaleProvider, {
              initial: 'en',
              children: createElement(Ribbon, {
                ...ribbonProps(editor, computeFormatState(editor)),
                embedded,
                quickActions: createElement('button', { className: 'qa-btn' }, 'Save'),
              }),
            }),
          ),
        )
        const tabs = container.querySelector('.ribbon-tabs')!
        const standalone = !embedded && !inTab
        expect(tabs.classList.contains('ribbon-tabs-mac')).toBe(
          standalone && platform === 'MacIntel',
        )
        expect(tabs.classList.contains('ribbon-tabs-win')).toBe(
          standalone && platform !== 'MacIntel',
        )
        expect(tabs.classList.contains('ribbon-tabs-embedded')).toBe(embedded)
        const file = tabs.querySelector('.file-tab-wrap')
        expect(file !== null).toBe(embedded || platform !== 'MacIntel')
        if (file) {
          expect(tabs.firstElementChild).toBe(file)
          expect(file.nextElementSibling?.textContent).toBe('Save')
        }
      }
    } finally {
      act(() => root.unmount())
      editor.destroy()
      container.remove()
      window.history.replaceState(null, '', '/')
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  },
)
