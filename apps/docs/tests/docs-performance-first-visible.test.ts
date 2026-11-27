import { expect, it, vi } from 'vitest'
import { observeFirstVisibleSource } from '../../../e2e/docs-performance-first-visible'

it('requires the matching source paragraph to intersect the actual pane and viewport', () => {
  document.body.innerHTML =
    '<div class="editor-scroll"><div class="ProseMirror doc-page">' +
    '<p style="visibility:visible"><span>Source</span><b> headline</b></p></div></div>'
  vi.stubGlobal('innerWidth', 800)
  vi.stubGlobal('innerHeight', 600)
  const win = window as unknown as Record<string, unknown>
  win.__docsLayoutActivity = { snapshot: () => ({ version: 1, generation: 2 }) }
  const pane = document.querySelector<HTMLElement>('.editor-scroll')!
  const paragraph = document.querySelector('p')!
  pane.getBoundingClientRect = () => new DOMRect(0, 100, 800, 400)
  paragraph.getBoundingClientRect = () => new DOMRect(10, 900, 300, 30)
  try {
    expect(observeFirstVisibleSource({ head: 'Sourceheadline', newerThan: 1 })).toBe(false)
    paragraph.getBoundingClientRect = () => new DOMRect(10, 200, 300, 30)
    expect(observeFirstVisibleSource({ head: 'Sourceheadline', newerThan: 1 })).toMatchObject({
      observation: 'source-block-geometry',
      scrollTop: 0,
      generation: 2,
      sourceRect: { x: 10, y: 200, width: 300, height: 30 },
    })
    expect(observeFirstVisibleSource({ head: 'Sourceheadline', newerThan: 2 })).toBe(false)
  } finally {
    document.body.innerHTML = ''
    delete win.__docsLayoutActivity
    vi.unstubAllGlobals()
  }
})
