// @vitest-environment jsdom
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOC_CSS_COMMITTED_EVENT } from '../src/renderer/editor/cjk-punct-shrink'
import { WRAP_WIDTHS_COMMITTED_EVENT } from '../src/renderer/editor/column-layout'
import { editorExtensions } from '../src/renderer/editor/extensions'

describe('tab and TOC layout after a wrap-width commit', () => {
  let host: HTMLDivElement
  let editor: Editor
  let blocks: HTMLElement[]
  const widths = new WeakMap<HTMLElement, number>()
  const reads = new Map<HTMLElement, number>()
  const clientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')

  beforeEach(() => {
    reads.clear()
    const layoutWidth = (el: HTMLElement) => {
      const block = el.closest<HTMLElement>('.ProseMirror > *')
      return (block && widths.get(block)) || 0
    }
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return layoutWidth(this)
    })
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return layoutWidth(this)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const block = this.closest<HTMLElement>('.ProseMirror > *')
      if (block) reads.set(block, (reads.get(block) ?? 0) + 1)
      return new DOMRect(0, 0, this.matches('.doc-toc-page') ? 20 : layoutWidth(this), 20)
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        return this.startContainer instanceof Element &&
          this.startContainer.matches('.doc-toc-title')
          ? [new DOMRect(0, 0, 160, 20)]
          : []
      },
    })
    const tab = {
      type: 'docParagraph',
      attrs: { tabStops: JSON.stringify([{ val: 'left', pos: 50, rel: 'margin' }]) },
      content: [{ type: 'text', text: 'a\tb' }],
    }
    const toc = {
      type: 'docProtected',
      attrs: {
        blockType: 'field',
        fieldDisplay: { kind: 'tocLine', left: 'Title', right: '3', level: 1 },
      },
    }
    host = document.body.appendChild(document.createElement('div'))
    editor = new Editor({
      editable: false,
      element: host,
      extensions: editorExtensions,
      content: { type: 'doc', content: [tab, toc, tab, toc] },
    })
    blocks = Array.from(editor.view.dom.children) as HTMLElement[]
    blocks.forEach((block) => widths.set(block, 600))
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
      left: 20,
      right: 20,
      top: 0,
      bottom: 20,
    })
    document.dispatchEvent(new Event(DOC_CSS_COMMITTED_EVENT))
    reads.clear()
  })

  afterEach(() => {
    editor.destroy()
    host.remove()
    vi.restoreAllMocks()
    if (clientRects) Object.defineProperty(Range.prototype, 'getClientRects', clientRects)
    else Reflect.deleteProperty(Range.prototype, 'getClientRects')
  })

  const tabSize = (block: HTMLElement) =>
    block.querySelector<HTMLElement>('.doc-tab')?.style.getPropertyValue('tab-size')
  const tocGap = (block: HTMLElement) =>
    block.querySelector<HTMLElement>('.doc-toc-tail')?.style.getPropertyValue('--doc-toc-gap')

  const commit = (...changed: HTMLElement[]) => {
    editor.view.dom.dispatchEvent(
      new CustomEvent(WRAP_WIDTHS_COMMITTED_EVENT, { detail: new Set(changed) }),
    )
  }

  it('reflows only the changed tab and TOC blocks in a read-only editor', () => {
    expect(blocks.map((b) => tabSize(b) ?? tocGap(b))).toEqual([
      '300px',
      '419.00px',
      '300px',
      '419.00px',
    ])
    const stableTab = blocks[2].querySelector('.doc-tab')
    widths.set(blocks[0], 400)
    widths.set(blocks[1], 400)
    commit(blocks[0], blocks[1])
    expect(blocks.map((b) => tabSize(b) ?? tocGap(b))).toEqual([
      '200px',
      '219.00px',
      '300px',
      '419.00px',
    ])
    expect(blocks[2].querySelector('.doc-tab')).toBe(stableTab)
    expect(Array.from(reads.keys())).toEqual([blocks[1], blocks[0]])
  })

  it('remeasures neighbouring tabs and TOC entries when CSS columns couple their flow', () => {
    editor.view.dom.style.columnCount = '2'
    widths.set(blocks[2], 400)
    widths.set(blocks[3], 400)
    commit(blocks[0])
    expect(tabSize(blocks[2])).toBe('200px')
    expect(tocGap(blocks[3])).toBe('219.00px')
  })

  it('starts a new scope on a subsequent geometry commit', () => {
    widths.set(blocks[0], 400)
    widths.set(blocks[2], 480)
    commit(blocks[0])
    reads.clear()
    commit(blocks[2])
    expect(tabSize(blocks[0])).toBe('200px')
    expect(tabSize(blocks[2])).toBe('240px')
    expect(Array.from(reads.keys())).toEqual([blocks[2]])
  })

  it('keeps a temporarily unmeasurable tab until its pending scope can settle', () => {
    widths.set(blocks[0], 0)
    widths.set(blocks[2], 480)
    commit(blocks[0], blocks[2])
    expect(tabSize(blocks[0])).toBe('300px')
    expect(tabSize(blocks[2])).toBe('240px')

    widths.set(blocks[0], 400)
    commit(blocks[2])
    expect(tabSize(blocks[0])).toBe('200px')
  })

  it('measures an inline edit without reading other tab paragraphs or TOC entries', () => {
    const outside = blocks[2].querySelector('.doc-tab')
    editor.view.dispatch(editor.state.tr.insertText('x', 1))
    expect(tabSize(blocks[0])).toBe('300px')
    expect(blocks[2].querySelector('.doc-tab')).toBe(outside)
    expect(reads.has(blocks[1])).toBe(false)
    expect(reads.has(blocks[2])).toBe(false)
    expect(reads.has(blocks[3])).toBe(false)
  })

  it('clears the local geometry when an inline edit removes the paragraph’s last tab', () => {
    editor.view.dispatch(editor.state.tr.delete(2, 3))
    expect(blocks[0].classList.contains('has-tab-stops')).toBe(false)
    expect(blocks[0].querySelector('.doc-tab')).toBeNull()
    expect(tabSize(blocks[2])).toBe('300px')
    expect(reads.has(blocks[2])).toBe(false)
  })

  it('rechecks the full flow on an inline edit when CSS columns couple its blocks', () => {
    editor.view.dom.style.columnCount = '2'
    widths.set(blocks[2], 400)
    editor.view.dispatch(editor.state.tr.insertText('x', 1))
    expect(tabSize(blocks[2])).toBe('200px')
    expect(reads.has(blocks[2])).toBe(true)
  })
})
