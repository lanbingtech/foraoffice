import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PARA_ROUNDS,
  PARAGRAPH_MEASUREMENTS_SETTLED_EVENT,
  PhasedParagraphMeasurement,
  SettledParagraphCache,
  hasCoupledWrapGeometry,
  firstChangedParagraphDecoration,
  hasPendingParagraphMeasurements,
  flushPendingParagraphMeasurements,
  measureNatural,
  noteFloatTransaction,
  topLevelBlockDom,
  type ReuseNoOpWhile,
} from '../src/renderer/editor/settled-measure'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { DOC_CSS_COMMITTED_EVENT } from '../src/renderer/editor/cjk-punct-shrink'
import { WRAP_WIDTHS_COMMITTED_EVENT } from '../src/renderer/editor/column-layout'
import { appendStreamedNodes } from '../src/renderer/file-actions'
import {
  cancelPhasedContent,
  PAINTED_FRAME_FALLBACK_MS,
  PHASED_CONTENT_SETTLED_EVENT,
  PHASED_MIN_BLOCKS,
  setContentPhased,
} from '../src/renderer/phased-content'

function fakeView(el: HTMLElement) {
  return {
    dom: document.createElement('div'),
    nodeDOM: () => el,
  } as unknown as EditorView
}

it('keeps the common layout prefix when typography settles with later changes', () => {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: '<p>One two</p><p>Three four</p>',
  })
  try {
    const { doc } = editor.state
    const later = doc.firstChild!.nodeSize + 1
    const style = 'word-spacing:-1px'
    const mark = (from: number, value = style) =>
      Decoration.inline(from, from + 1, { style: value }, { style: value })
    const build = (...marks: Decoration[]) => DecorationSet.create(doc, marks)
    const before = build(mark(1), mark(later))
    expect(firstChangedParagraphDecoration(before, build(mark(later), mark(1)))).toBeNull()
    expect(firstChangedParagraphDecoration(before, build(mark(1)))).toBe(later)
    expect(
      firstChangedParagraphDecoration(before, build(mark(1), mark(later, 'word-spacing:-2px'))),
    ).toBe(later)
  } finally {
    editor.destroy()
  }
})

/** jsdom has no layout: give the paragraph the box the test wants */
function sized(el: HTMLElement, box: () => { width: number; height: number }) {
  Object.defineProperty(el, 'offsetWidth', { get: () => box().width })
  Object.defineProperty(el, 'offsetHeight', { get: () => box().height })
}

const shiftAll = (r: number[], d: number) => r.map((v) => v + d)

/** Editors created during the current test; destroyed in afterEach so ProseMirror's
 * DOMObserver timers can't fire after the JSDOM environment is torn down. */
const liveEditors: Editor[] = []

function makeEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [{ type: 'docParagraph', content: [{ type: 'text', text: 'abc' }] }],
    },
  })
  liveEditors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy()
})

/** a transaction that inserts a node: the float scan runs again on the next pass */
const nodeInsert = (editor: Editor) =>
  editor.state.tr.insert(0, editor.schema.nodes.docParagraph.create())

describe('SettledParagraphCache', () => {
  const node = {} as ProseMirrorNode

  it('invalidates text inside a changed block and keeps unrelated settled results', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>first</p><table><tbody><tr><td><p>cell</p></td></tr></tbody></table>'
    const elements = Array.from(root.querySelectorAll('p'))
    const widths = elements.map((element) => {
      const width = vi.fn(() => 200)
      Object.defineProperty(element, 'offsetWidth', { get: width })
      return width
    })
    const view = {
      dom: root,
      nodeDOM: (pos: number) => elements[pos],
    } as unknown as EditorView
    const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))
    const cache = new SettledParagraphCache<number[]>(shiftAll, () => true)
    const measure = vi.fn(({ pos }: { pos: number }) => [pos])
    expect(cache.measurePass(view, paragraphs, measure)).toEqual([[0], [1]])
    cache.invalidateBlocks(view, new Set([root.querySelector('table')!]))
    widths.forEach((read) => read.mockClear())
    measure.mockClear()
    expect(cache.measurePass(view, paragraphs, measure)).toEqual([[0], [1]])
    expect(measure).toHaveBeenCalledTimes(1)
    expect(measure.mock.calls[0][0].pos).toBe(1)
    expect(widths[0]).not.toHaveBeenCalled()
  })

  it('rechecks a neighbouring paragraph when a committed split float changes its wrap', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>first</p><p>second</p>'
    document.body.appendChild(root)
    try {
      const elements = Array.from(root.querySelectorAll('p'))
      elements[1].getBoundingClientRect = () => ({ top: 10, bottom: 30 }) as DOMRect
      const view = {
        dom: root,
        state: {},
        nodeDOM: (pos: number) => elements[pos],
      } as unknown as EditorView
      const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))
      const cache = new SettledParagraphCache<number[]>(shiftAll, () => true)
      const measure = vi.fn(({ pos }: { pos: number }) => [pos])
      cache.measurePass(view, paragraphs, measure)

      const split = document.createElement('span')
      split.className = 'doc-col-split-float'
      split.style.cssFloat = 'left'
      split.getBoundingClientRect = () => ({ top: 0, bottom: 20 }) as DOMRect
      elements[0].prepend(split)
      cache.invalidateBlocks(view, new Set([elements[0]]))
      measure.mockClear()
      cache.measurePass(view, paragraphs, measure)
      expect(measure.mock.calls.map(([para]) => para.pos)).toEqual([0, 1])

      split.remove()
      cache.invalidateBlocks(view, new Set([elements[0]]))
      measure.mockClear()
      cache.measurePass(view, paragraphs, measure)
      expect(measure.mock.calls.map(([para]) => para.pos)).toEqual([0, 1])
    } finally {
      root.remove()
    }
  })

  it('reads independent paragraphs with their inline gaps hidden in one pass', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p><span class="page-gap-inline"></span></p>'.repeat(2)
    const gaps = Array.from(root.querySelectorAll<HTMLElement>('.page-gap-inline'))
    const elements = Array.from(root.children)
    const viewOf = (dom: HTMLElement) =>
      ({ dom, nodeDOM: (pos: number) => elements[pos] }) as unknown as EditorView
    const view = viewOf(root)
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))

    const result = cache.measurePass(view, paragraphs, ({ pos }) => {
      expect(gaps.map((gap) => gap.style.display)).toEqual(['none', 'none'])
      return [pos]
    })
    expect(result).toEqual([[0], [1]])
    expect(gaps.map((gap) => gap.style.display)).toEqual(['', ''])

    const individually = ({ pos }: { pos: number }) => {
      expect(gaps[pos].style.display).toBe('none')
      expect(gaps[1 - pos].style.display).toBe('')
      return [pos]
    }
    root.style.columnCount = '2'
    cache.clear()
    document.body.appendChild(root)
    try {
      cache.measurePass(view, paragraphs, individually)
    } finally {
      root.remove()
    }
    expect(gaps.map((gap) => gap.style.display)).toEqual(['', ''])

    const float = document.createElement('div')
    float.className = 'doc-table-float-left'
    float.style.cssFloat = 'left'
    const withFloat = viewOf(document.createElement('div'))
    withFloat.dom.append(float, ...root.childNodes)
    cache.clear()
    cache.measurePass(withFloat, paragraphs, individually)
    expect(gaps.map((gap) => gap.style.display)).toEqual(['', ''])
  })

  it('only changes gap styles for paragraphs read before the next frame', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<p>ordinary text</p>' + '<p><span class="page-gap-inline"></span></p>'.repeat(9)
    const elements = Array.from(root.querySelectorAll('p'))
    const view = { dom: root, nodeDOM: (pos: number) => elements[pos] } as unknown as EditorView
    const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))
    const gaps = Array.from(root.querySelectorAll<HTMLElement>('.page-gap-inline'))
    const observer = new MutationObserver(() => {})
    observer.observe(root, { attributes: true, attributeFilter: ['style'], subtree: true })
    try {
      const cache = new SettledParagraphCache<number[]>(shiftAll)
      const read = vi.fn(({ pos }: { pos: number }) => {
        if (pos > 0) expect(gaps[pos - 1].style.display).toBe('none')
        return [pos]
      })
      const pass = cache.startMeasurePass(view, paragraphs, read)
      // The first read stands in for Blink spending the entire slice budget.
      expect(pass(-1)).toBeUndefined()
      expect(read.mock.calls.map(([{ pos }]) => pos)).toEqual([0])
      expect(observer.takeRecords()).toEqual([])

      let measured: Array<number[] | null> | undefined
      for (let i = 0; measured === undefined && i < gaps.length; i++) {
        read.mockClear()
        measured = pass(-1)
        const readGaps = read.mock.calls.map(([{ pos }]) => gaps[pos - 1])
        const mutated = new Set(observer.takeRecords().map((record) => record.target))
        expect(mutated).toEqual(new Set(readGaps))
        expect(readGaps.length).toBeGreaterThan(0)
        expect(gaps.every((gap) => gap.style.display === '')).toBe(true)
        if (i === 0) expect(measured).toBeUndefined()
      }
      expect(measured).toEqual(paragraphs.map(({ pos }) => [pos]))
    } finally {
      observer.disconnect()
    }
  })

  it('batches body gaps independently of a cell float and keeps cell gaps local', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <p><span class="page-gap-inline"></span></p>
      <table><tbody><tr><td>
        <span class="doc-cell-boxes" style="float:left"></span>
        <p><span class="page-gap-inline"></span></p>
        <p><span class="page-gap-inline"></span></p>
      </td></tr></tbody></table>
      <p><span class="page-gap-inline"></span></p>`
    const paragraphs = Array.from(root.querySelectorAll('p'), (_, pos) => ({
      node: {} as ProseMirrorNode,
      pos,
    }))
    const elements = Array.from(root.querySelectorAll('p'))
    const gaps = Array.from(root.querySelectorAll<HTMLElement>('.page-gap-inline'))
    const view = { dom: root, nodeDOM: (pos: number) => elements[pos] } as unknown as EditorView
    const cache = new SettledParagraphCache<number[]>(shiftAll, () => true)
    const gapDisplays = [
      ['none', '', '', 'none'],
      ['', 'none', '', ''],
      ['', '', 'none', ''],
      ['none', '', '', 'none'],
    ]
    const read = vi.fn(({ pos }: { pos: number }) => {
      expect(gaps.map((gap) => gap.style.display)).toEqual(gapDisplays[pos])
      return [pos]
    })
    expect(cache.measurePass(view, paragraphs, read)).toEqual([[0], [1], [2], [3]])
    expect(gaps.map((gap) => gap.style.display)).toEqual(['', '', '', ''])

    const unaffected = [0, 3].map((pos) => vi.spyOn(elements[pos], 'getBoundingClientRect'))
    cache.invalidateBlocks(view, new Set([root.querySelector('table')!]))
    read.mockImplementation(({ pos }) => [pos])
    read.mockClear()
    expect(cache.measurePass(view, paragraphs, read)).toEqual([[0], [1], [2], [3]])
    expect(read.mock.calls.map(([{ pos }]) => pos)).toEqual([1, 2])
    for (const spy of unaffected) expect(spy).not.toHaveBeenCalled()
  })

  it('batches body gaps ahead of a float while keeping its anchor and later gaps local', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <p><span class="page-gap-inline"></span></p>
      <p><span class="page-gap-inline"></span></p>
      <p><span class="doc-inline-img--wrap-square-right" style="float: right"></span>
        <span class="page-gap-inline"></span></p>
      <p><span class="page-gap-inline"></span></p>`
    const elements = Array.from(root.querySelectorAll('p'))
    const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))
    const gaps = Array.from(root.querySelectorAll<HTMLElement>('.page-gap-inline'))
    const view = { dom: root, nodeDOM: (pos: number) => elements[pos] } as unknown as EditorView
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const gapDisplays = [
      ['none', 'none', '', ''],
      ['none', 'none', '', ''],
      ['', '', 'none', ''],
      ['', '', '', 'none'],
    ]

    expect(
      cache.measurePass(view, paragraphs, ({ pos }) => {
        expect(gaps.map((gap) => gap.style.display)).toEqual(gapDisplays[pos])
        return [pos]
      }),
    ).toEqual([[0], [1], [2], [3]])
  })

  it('uses known column geometry without flushing CSS for floats confined to table cells', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<table><tr><td><div class="doc-cell-boxes" style="float:left"></div></td></tr></table>'
    const computed = vi.spyOn(window, 'getComputedStyle')
    try {
      expect(hasCoupledWrapGeometry({ dom: root }, false)).toBe(false)
      expect(computed).not.toHaveBeenCalled()
      root.insertAdjacentHTML(
        'beforeend',
        '<div class="img-wrap-square-left" style="float:left"></div>',
      )
      expect(hasCoupledWrapGeometry({ dom: root }, false)).toBe(true)
    } finally {
      computed.mockRestore()
    }
  })

  it('does not read or couple paragraphs to a wrap marker that CSS does not float', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="img-wrap-square-left" style="position:absolute"></div>
      <p><span class="page-gap-inline"></span></p>
      <p><span class="page-gap-inline"></span></p>`
    const elements = Array.from(root.querySelectorAll('p'))
    const gaps = Array.from(root.querySelectorAll<HTMLElement>('.page-gap-inline'))
    const view = { dom: root, nodeDOM: (pos: number) => elements[pos] } as unknown as EditorView
    const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))
    const rect = vi.spyOn(root.children[0], 'getBoundingClientRect')
    const cache = new SettledParagraphCache<number[]>(shiftAll)

    expect(hasCoupledWrapGeometry(view)).toBe(false)
    expect(
      cache.measurePass(view, paragraphs, ({ pos }) => {
        expect(gaps.map((gap) => gap.style.display)).toEqual(['none', 'none'])
        return [pos]
      }),
    ).toEqual([[0], [1]])
    expect(rect).not.toHaveBeenCalled()
  })

  it('reads a cell float only when measuring a paragraph in its cell', () => {
    const root = document.createElement('div')
    root.innerHTML = `<p>body</p><table><tbody><tr>
      <td><div class="doc-cell-boxes" style="float:left"></div><p>anchored cell</p></td>
      <td><p>other cell</p></td>
      </tr></tbody></table>`
    const elements = Array.from(root.querySelectorAll('p'))
    const view = { dom: root, nodeDOM: (pos: number) => elements[pos] } as unknown as EditorView
    const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))
    const rect = vi.spyOn(root.querySelector('.doc-cell-boxes')!, 'getBoundingClientRect')
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const read = ({ pos }: { pos: number }) => [pos]

    expect(cache.measurePass(view, [paragraphs[0], paragraphs[2]], read)).toEqual([[0], [2]])
    expect(rect).not.toHaveBeenCalled()
    expect(cache.measurePass(view, paragraphs, read)).toEqual([[0], [1], [2]])
    expect(rect).toHaveBeenCalledTimes(1)
  })

  it('re-measures until two consecutive passes agree, then reuses the result', () => {
    const el = document.createElement('p')
    const view = fakeView(el)
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const fn = vi.fn<() => number[]>()
    const pass = () => {
      cache.beginPass(view)
      return cache.measure(view, node, 1, fn)
    }
    fn.mockReturnValueOnce([1]).mockReturnValueOnce([2]).mockReturnValueOnce([2])
    expect(pass()).toEqual([1])
    expect(pass()).toEqual([2])
    expect(pass()).toEqual([2])
    expect(fn).toHaveBeenCalledTimes(3)
    expect(pass()).toEqual([2])
    expect(pass()).toEqual([2])
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('discards partial measurements instead of reusing them after a layout revision', () => {
    const first = document.createElement('p')
    const second = document.createElement('p')
    const view = fakeView(first)
    view.dom.append(first, second)
    const elements = [first, second]
    view.nodeDOM = (pos) => elements[pos]
    const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))
    const cache = new SettledParagraphCache<number[]>(shiftAll, () => true)
    const oldRead = vi.fn(() => [1])
    const pass = cache.startMeasurePass(view, paragraphs, oldRead, { trackProposal: true })

    expect(pass(-1)).toBeUndefined()
    expect(oldRead).toHaveBeenCalledTimes(1)
    cache.discardMeasuredResults()
    expect(cache.measurePass(view, paragraphs, () => [2])).toEqual([[2], [2]])
  })

  it('keeps the published result when a measurement would restart a layout cycle', () => {
    const el = document.createElement('p')
    const view = fakeView(el)
    let width = 554
    let height = 95
    sized(el, () => ({ width, height }))
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const read = vi.fn<() => number[]>().mockReturnValueOnce([1]).mockReturnValueOnce([2])
    const pass = (pos: number) =>
      cache.measurePass(view, [{ node, pos }], read, { trackProposal: true })

    expect(pass(1)).toEqual([[1]])
    // The published decoration changed the measured height. The next proposal
    // would return to the previous layout, so the view retains the current one.
    height = 126
    expect(pass(1)).toEqual([[2]])
    cache.retainPublishedResults()
    expect(pass(4)).toEqual([[4]])
    expect(read).toHaveBeenCalledTimes(2)

    width++
    read.mockReturnValueOnce([5])
    expect(pass(4)).toEqual([[5]])
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('keeps the last answer of a paragraph that never repeats itself', () => {
    const el = document.createElement('p')
    const view = fakeView(el)
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    let n = 0
    const fn = vi.fn(() => [++n])
    const pass = () => {
      cache.beginPass(view)
      return cache.measure(view, node, 1, fn)
    }
    for (let i = 1; i <= MAX_PARA_ROUNDS; i++) expect(pass()).toEqual([i])
    expect(pass()).toEqual([MAX_PARA_ROUNDS])
    expect(pass()).toEqual([MAX_PARA_ROUNDS])
    expect(fn).toHaveBeenCalledTimes(MAX_PARA_ROUNDS)
    // a layout change (box) measures afresh and the count starts over
    cache.clear()
    expect(pass()).toEqual([MAX_PARA_ROUNDS + 1])
    expect(pass()).toEqual([MAX_PARA_ROUNDS + 2])
  })

  it('invalidates on clear(), a different node, a box change or an unmeasurable pass', () => {
    const el = document.createElement('p')
    const view = fakeView(el)
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    let rect = { top: 0, bottom: 10, height: 10, width: 100 }
    sized(el, () => rect)
    const fn = vi.fn<() => number[] | null>(() => [7])
    const pass = (n: ProseMirrorNode = node) => {
      cache.beginPass(view)
      return cache.measure(view, n, 1, fn)
    }
    pass()
    pass()
    pass()
    expect(fn).toHaveBeenCalledTimes(2)
    rect = { ...rect, height: 20 }
    pass()
    expect(fn).toHaveBeenCalledTimes(3)
    pass()
    expect(fn).toHaveBeenCalledTimes(3)
    pass({} as ProseMirrorNode)
    expect(fn).toHaveBeenCalledTimes(4)
    cache.clear()
    pass()
    pass()
    pass()
    expect(fn).toHaveBeenCalledTimes(6)
    fn.mockReturnValueOnce(null)
    cache.clear()
    expect(pass()).toBeNull()
    pass()
    pass()
    pass()
    expect(fn).toHaveBeenCalledTimes(9)
  })

  it('keys on vertical position only beside a float', () => {
    const editor = makeEditor()
    const el = document.createElement('p')
    const view = fakeView(el)
    let top = 0
    el.getBoundingClientRect = () => ({ top, bottom: top + 10, height: 10, width: 100 }) as DOMRect
    sized(el, () => ({ width: 100, height: 10 }))
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const fn = vi.fn<() => number[]>(() => [1])
    const pass = () => {
      cache.beginPass(view)
      return cache.measure(view, node, 1, fn)
    }
    pass()
    pass()
    top = 50
    pass()
    expect(fn).toHaveBeenCalledTimes(2)
    const float = document.createElement('div')
    float.className = 'doc-table doc-table-float-left'
    float.style.cssFloat = 'left'
    float.getBoundingClientRect = () => ({ top: 40, bottom: 80 }) as DOMRect
    view.dom.appendChild(float)
    noteFloatTransaction(nodeInsert(editor))
    // flowed in place by the paginator: not a float until that class goes
    float.classList.add('doc-table-float-flow')
    pass()
    expect(fn).toHaveBeenCalledTimes(2)
    float.classList.remove('doc-table-float-flow')
    pass()
    expect(fn).toHaveBeenCalledTimes(3)
    top = 60
    pass()
    expect(fn).toHaveBeenCalledTimes(4)
    top = 200
    pass()
    pass()
    pass()
    expect(fn).toHaveBeenCalledTimes(5)
  })

  it('remeasures a paragraph when the adjacent exclusion changes shape without resizing it', () => {
    const el = document.createElement('p')
    const view = fakeView(el)
    const float = document.createElement('div')
    float.className = 'doc-table-float-left'
    float.style.cssFloat = 'left'
    let right = 25
    float.getBoundingClientRect = () => ({ top: 0, bottom: 20, left: 0, right }) as DOMRect
    el.getBoundingClientRect = () => ({ top: 0, bottom: 20, width: 100 }) as DOMRect
    sized(el, () => ({ width: 100, height: 20 }))
    view.dom.append(float, el)
    const cache = new SettledParagraphCache<number[]>(shiftAll, () => true)
    const pass = () => cache.measurePass(view, [{ node, pos: 0 }], () => [right])

    expect(pass()).toEqual([[25]])
    right = 26.5
    expect(pass()).toEqual([[26.5]])
  })

  it('keeps a settled paragraph across an edit elsewhere and re-bases its positions', () => {
    const el = document.createElement('p')
    const view = fakeView(el)
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const fn = vi.fn<() => number[]>(() => [12, 15])
    const pass = (pos: number) => {
      cache.beginPass(view)
      return cache.measure(view, node, pos, fn)
    }
    expect(pass(10)).toEqual([12, 15])
    expect(pass(10)).toEqual([12, 15])
    expect(fn).toHaveBeenCalledTimes(2)
    // text inserted above the paragraph: same node, new position, no re-measure
    expect(pass(13)).toEqual([15, 18])
    expect(pass(13)).toEqual([15, 18])
    expect(fn).toHaveBeenCalledTimes(2)
    // a result re-measured at a new position settles against the position-independent key
    const other = {} as ProseMirrorNode
    fn.mockReturnValueOnce([3]).mockReturnValueOnce([5])
    cache.beginPass(view)
    expect(cache.measure(view, other, 1, fn)).toEqual([3])
    cache.beginPass(view)
    expect(cache.measure(view, other, 3, fn)).toEqual([5])
    cache.beginPass(view)
    expect(cache.measure(view, other, 3, fn)).toEqual([5])
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it('reuses a style-excluded no-op without hiding gaps and remeasures after its style changes', () => {
    const el = document.createElement('p')
    el.style.cssText = 'display: block; float: none; position: static; writing-mode: horizontal-tb'
    const gap = Object.assign(document.createElement('span'), { className: 'page-gap-inline' })
    el.append(gap)
    const view = fakeView(el)
    view.dom.append(el)
    document.body.append(view.dom)
    sized(el, () => ({ width: 100, height: 20 }))
    el.getBoundingClientRect = () => ({ width: 100 }) as DOMRect
    const cache = new SettledParagraphCache<number[]>(shiftAll, (result) => result.length === 0)
    const fn = vi.fn((paragraph: HTMLElement, reuseWhile: ReuseNoOpWhile) => {
      const excluded = (style: CSSStyleDeclaration) => style.textAlign !== 'justify'
      if (!excluded(getComputedStyle(paragraph))) return [1]
      reuseWhile(excluded)
      return []
    })
    const gapSearch = vi.spyOn(el, 'querySelectorAll')
    const pass = () => {
      cache.beginPass(view)
      return cache.measure(view, node, 1, fn, el)
    }

    expect(pass()).toEqual([])
    expect(pass()).toEqual([])
    expect(gapSearch).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledTimes(1)
    el.style.textAlign = 'justify'
    expect(pass()).toEqual([1])
    expect(gapSearch).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenCalledTimes(2)
    view.dom.remove()
  })

  it('keeps natural-layout retries when a previously style-excluded paragraph becomes hidden', () => {
    const el = document.createElement('p')
    el.style.cssText = 'display: block; float: none; position: static; writing-mode: horizontal-tb'
    const view = fakeView(el)
    view.dom.append(el)
    let width = 100
    sized(el, () => ({ width, height: 20 }))
    el.getBoundingClientRect = () => ({ width }) as DOMRect
    const cache = new SettledParagraphCache<number[]>(shiftAll, (result) => result.length === 0)
    const fn = (_: HTMLElement, reuseWhile: ReuseNoOpWhile) => {
      if (!width) return null
      reuseWhile(() => true)
      return []
    }
    cache.beginPass(view)
    expect(cache.measure(view, node, 1, fn, el)).toEqual([])
    width = 0
    cache.beginPass(view)
    expect(cache.measure(view, node, 1, fn, el)).toBeNull()
  })

  it('prunes paragraphs a pass does not visit (deleted nodes)', () => {
    const el = document.createElement('p')
    const view = fakeView(el)
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const fn = vi.fn<() => number[]>(() => [1])
    const a = {} as ProseMirrorNode
    const b = {} as ProseMirrorNode
    for (let i = 0; i < 2; i++) {
      cache.beginPass(view)
      cache.measure(view, a, 1, fn)
      cache.measure(view, b, 5, fn)
    }
    expect(fn).toHaveBeenCalledTimes(4)
    // b disappears for two passes → its entry is dropped; a stays settled
    cache.beginPass(view)
    cache.measure(view, a, 1, fn)
    cache.beginPass(view)
    cache.measure(view, a, 1, fn)
    expect(fn).toHaveBeenCalledTimes(4)
    cache.beginPass(view)
    cache.measure(view, b, 5, fn)
    expect(fn).toHaveBeenCalledTimes(5)
  })

  it('reads top-level block DOM off the view descriptors', () => {
    const view = fakeView(document.createElement('p'))
    const a = {} as ProseMirrorNode
    const b = {} as ProseMirrorNode
    const pa = document.createElement('p')
    const pb = document.createElement('p')
    ;(pa as unknown as { pmViewDesc: unknown }).pmViewDesc = { node: a }
    ;(pb as unknown as { pmViewDesc: unknown }).pmViewDesc = { node: b }
    const widget = document.createElement('span') // no desc node
    view.dom.append(pa, widget, pb, document.createTextNode('x'))
    const map = topLevelBlockDom(view)
    expect(map.get(a)).toBe(pa)
    expect(map.get(b)).toBe(pb)
    expect(map.size).toBe(2)
    // the hint replaces nodeDOM for the lookup
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const fn = vi.fn<(el: HTMLElement) => number[]>(() => [1])
    cache.beginPass(view)
    cache.measure(view, a, 1, fn, pa)
    expect(fn).toHaveBeenCalledWith(pa, expect.any(Function))
  })

  it('omits model nodes with more than one top-level view descriptor', () => {
    const first = document.createElement('p')
    const duplicate = document.createElement('p')
    const unique = document.createElement('p')
    const sharedNode = {} as ProseMirrorNode
    const uniqueNode = {} as ProseMirrorNode
    Object.assign(first, { pmViewDesc: { node: sharedNode } })
    Object.assign(duplicate, { pmViewDesc: { node: sharedNode } })
    Object.assign(unique, { pmViewDesc: { node: uniqueNode } })
    const view = fakeView(first)
    view.dom.append(
      first,
      duplicate,
      unique,
      Object.assign(first.cloneNode(), { pmViewDesc: { node: sharedNode } }),
    )

    expect(topLevelBlockDom(view)).toEqual(new Map([[uniqueNode, unique]]))
  })

  it('measures distinct DOM occurrences of one model node separately', () => {
    const first = document.createElement('p')
    const duplicate = document.createElement('p')
    const view = fakeView(first)
    const cache = new SettledParagraphCache<number[]>(shiftAll, () => true)
    const measure = (el: HTMLElement) => (el === first ? [1] : [10])

    cache.beginPass(view)
    expect(cache.measure(view, node, 1, measure, first)).toEqual([1])
    expect(cache.measure(view, node, 4, measure, duplicate)).toEqual([10])
  })

  it('scans for floats once per editor state and only again after a node insert', () => {
    const editor = makeEditor()
    const dom = document.createElement('div')
    const el = document.createElement('p')
    const view = { dom, nodeDOM: () => el, state: {} } as unknown as EditorView
    const scan = vi.spyOn(dom, 'querySelectorAll')
    const pass = () => new SettledParagraphCache<number[]>(shiftAll).beginPass(view)
    noteFloatTransaction(nodeInsert(editor))
    pass()
    pass()
    expect(scan).toHaveBeenCalledTimes(1)
    ;(view as unknown as { state: object }).state = {}
    noteFloatTransaction(editor.state.tr.insertText('x', 2))
    pass()
    expect(scan).toHaveBeenCalledTimes(1)
    ;(view as unknown as { state: object }).state = {}
    noteFloatTransaction(nodeInsert(editor))
    pass()
    expect(scan).toHaveBeenCalledTimes(2)
  })
})

it('does not remeasure a Docs editor when it has no phased layout waiting to settle', () => {
  const editor = makeEditor()
  document.body.append(editor.view.dom)
  try {
    editor.storage.cjkPunctShrink.enabled = true
    editor.storage.justifyShrink.enabled = true
    editor.commands.setContent('<p>文字，文字</p><p>one two three</p>')
    const width = vi.fn(() => 100)
    Object.defineProperty(editor.view.dom, 'offsetWidth', { get: width })
    document.dispatchEvent(new Event(DOC_CSS_COMMITTED_EVENT))
    expect(width).toHaveBeenCalledTimes(2)
    width.mockClear()

    document.dispatchEvent(new Event(PHASED_CONTENT_SETTLED_EVENT))
    expect(width).not.toHaveBeenCalled()
  } finally {
    editor.view.dom.remove()
  }
})

it('leaves settlement free of geometry reads and measures across browser frames', () => {
  const editor = makeEditor()
  document.body.append(editor.view.dom)
  const width = vi.fn(() => 100)
  Object.defineProperty(editor.view.dom, 'offsetWidth', { get: width })
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const request = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((frame) => {
    frames.delete(frame)
  })
  const read = vi.fn()
  const settled = vi.fn()
  editor.view.dom.addEventListener(PARAGRAPH_MEASUREMENTS_SETTLED_EVENT, settled)
  let clock = 0
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  editor.storage.cjkPunctShrink.enabled = true
  editor.storage.justifyShrink.enabled = true
  const tasks: Array<() => void> = []
  const content = Array.from({ length: PHASED_MIN_BLOCKS + 1 }, (_, i) => ({
    type: 'docParagraph',
    content: [{ type: 'text', text: i % 2 === 0 ? '文字，文字' : 'one two three' }],
  }))
  try {
    setContentPhased(
      {
        owner: editor,
        setContent: (doc) => editor.commands.setContent(doc),
        appendNodes: (nodes) => {
          appendStreamedNodes(editor, nodes)
          expect(width).not.toHaveBeenCalled()
        },
        isDestroyed: () => false,
        resetHistory: () => {
          // Reconfiguring editor plugins recreates the measurement views.
          editor.view.updateState(editor.state.reconfigure({ plugins: [...editor.state.plugins] }))
          expect(width).not.toHaveBeenCalled()
        },
        setLoading: () => {},
        getDirty: () => false,
        setDirty: () => {},
      },
      { type: 'doc', content },
      (task) => tasks.push(task),
    )
    width.mockClear()
    while (tasks.length) tasks.shift()?.()
    expect(width).not.toHaveBeenCalled()
    expect(editor.state.doc.childCount).toBe(content.length)
    expect(hasPendingParagraphMeasurements(editor.view)).toBe(true)
    for (const paragraph of editor.view.dom.querySelectorAll<HTMLElement>('p')) {
      sized(paragraph, () => {
        read()
        clock++
        return { width: 100, height: 20 }
      })
      paragraph.getBoundingClientRect = () => ({ width: 100, height: 20 }) as DOMRect
      paragraph.style.direction = 'rtl'
    }
    const readFrame = () => {
      const queued = [...frames.values()]
      frames.clear()
      for (const callback of queued) callback(clock)
    }
    readFrame()
    expect(read).toHaveBeenCalled()
    expect(read.mock.calls.length).toBeLessThan(content.length)
    expect(width).not.toHaveBeenCalled()
    const queuedFrames = [...frames.keys()]
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
    expect(queuedFrames.every((frame) => frames.has(frame))).toBe(true)
    const partialReads = read.mock.calls.length
    const changedBlock = new Set([editor.view.dom.querySelector('p')!])
    const commitWrap = () =>
      editor.view.dom.dispatchEvent(
        new CustomEvent(WRAP_WIDTHS_COMMITTED_EVENT, {
          detail: changedBlock,
        }),
      )
    commitWrap()
    expect(read).toHaveBeenCalledTimes(partialReads)
    readFrame()
    expect(hasPendingParagraphMeasurements(editor.view)).toBe(true)
    expect(read.mock.calls.length).toBeGreaterThan(partialReads)
    expect(settled).not.toHaveBeenCalled()
    flushPendingParagraphMeasurements(editor.view)
    expect(hasPendingParagraphMeasurements(editor.view)).toBe(false)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(width).toHaveBeenCalledTimes(2)
    expect(frames.size).toBe(0)
    const completedReads = read.mock.calls.length
    commitWrap()
    expect(read).toHaveBeenCalledTimes(completedReads)
    expect(hasPendingParagraphMeasurements(editor.view)).toBe(true)
    flushPendingParagraphMeasurements(editor.view)
    expect(settled).toHaveBeenCalledTimes(2)
  } finally {
    cancelPhasedContent()
    editor.view.dom.remove()
    editor.destroy()
    request.mockRestore()
    cancel.mockRestore()
    now.mockRestore()
  }
})

it('uses the bounded frame fallback for background views and publishes only after all reads', () => {
  const view = fakeView(document.createElement('p'))
  document.body.append(view.dom)
  const publish = vi.fn()
  const discard = vi.fn()
  const settled = vi.fn()
  view.dom.addEventListener(PARAGRAPH_MEASUREMENTS_SETTLED_EVENT, settled)
  vi.useFakeTimers()
  const request = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1)
  const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  let reads = 0
  const measurement = new PhasedParagraphMeasurement(
    view,
    () => () => {
      if (++reads === 2) return publish
    },
    discard,
  )
  try {
    measurement.start()
    expect(reads).toBe(0)
    vi.advanceTimersByTime(PAINTED_FRAME_FALLBACK_MS)
    expect(reads).toBe(1)
    expect(publish).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    expect(hasPendingParagraphMeasurements(view)).toBe(true)
    vi.advanceTimersByTime(PAINTED_FRAME_FALLBACK_MS)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(hasPendingParagraphMeasurements(view)).toBe(false)
    expect(discard).not.toHaveBeenCalled()
  } finally {
    measurement.destroy()
    view.dom.remove()
    request.mockRestore()
    cancel.mockRestore()
    vi.useRealTimers()
  }
})

it('discards a partial read and keeps the job pending when export parks the editor between frames', () => {
  const view = fakeView(document.createElement('p'))
  const app = document.createElement('div')
  app.className = 'app'
  app.append(view.dom)
  document.body.append(app)
  vi.useFakeTimers()
  const request = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1)
  const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  const read = vi.fn()
  const discard = vi.fn()
  const publish = vi.fn()
  const settled = vi.fn()
  view.dom.addEventListener(PARAGRAPH_MEASUREMENTS_SETTLED_EVENT, settled)
  let version = 0
  const measurement = new PhasedParagraphMeasurement(
    view,
    () => {
      const snapshot = ++version
      let slices = 0
      return () => {
        read(snapshot)
        if (++slices === 2) return () => publish(snapshot)
      }
    },
    discard,
  )
  try {
    measurement.start()
    vi.advanceTimersByTime(PAINTED_FRAME_FALLBACK_MS)
    expect(read.mock.calls).toEqual([[1]])
    app.classList.add('pv-exporting')
    flushPendingParagraphMeasurements(view)
    expect(discard).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(2 * PAINTED_FRAME_FALLBACK_MS)
    expect(read.mock.calls).toEqual([[1]])
    expect(publish).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    expect(hasPendingParagraphMeasurements(view)).toBe(true)

    app.classList.remove('pv-exporting')
    vi.advanceTimersByTime(PAINTED_FRAME_FALLBACK_MS)
    expect(read.mock.calls).toEqual([[1], [2]])
    flushPendingParagraphMeasurements(view)
    expect(read.mock.calls).toEqual([[1], [2], [2]])
    expect(publish.mock.calls).toEqual([[2]])
    expect(settled).toHaveBeenCalledOnce()
    expect(hasPendingParagraphMeasurements(view)).toBe(false)
  } finally {
    measurement.destroy()
    app.remove()
    request.mockRestore()
    cancel.mockRestore()
    vi.useRealTimers()
  }
})

describe('measureNatural', () => {
  it('hides the inline page gaps of the paragraph while measuring and restores them', () => {
    const el = document.createElement('p')
    const gap = document.createElement('span')
    gap.className = 'page-gap page-gap-inline'
    gap.style.display = 'inline-block'
    el.append('before', gap, 'after')
    const seen = measureNatural(el, () => gap.style.display)
    expect(seen).toBe('none')
    expect(gap.style.display).toBe('inline-block')
  })

  it('restores the gaps when the measurement throws', () => {
    const el = document.createElement('p')
    const gap = document.createElement('span')
    gap.className = 'page-gap-inline'
    el.append(gap)
    expect(() =>
      measureNatural(el, () => {
        throw new Error('x')
      }),
    ).toThrow('x')
    expect(gap.style.display).toBe('')
  })

  it('keys the cache on the natural box, not the box with the gap in it', () => {
    const el = document.createElement('p')
    const gap = document.createElement('span')
    gap.className = 'page-gap-inline'
    el.append(gap)
    sized(el, () => ({
      width: 100,
      height: !gap.isConnected || gap.style.display === 'none' ? 20 : 120,
    }))
    const view = fakeView(el)
    const node = {} as ProseMirrorNode
    const cache = new SettledParagraphCache<number[]>(shiftAll)
    const fn = vi.fn<() => number[]>().mockReturnValue([1])
    cache.beginPass(view)
    cache.measure(view, node, 1, fn)
    cache.beginPass(view)
    cache.measure(view, node, 1, fn)
    cache.beginPass(view)
    gap.remove()
    cache.measure(view, node, 1, fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
