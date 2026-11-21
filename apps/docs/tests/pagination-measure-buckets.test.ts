import { describe, expect, it, vi } from 'vitest'
import { measureBlocks } from '../src/renderer/pagination'
import { createBlockMeasurer, enterNaturalFlow } from '../src/renderer/pagination-measure'

const rectOf = (top: number, height: number, width = 100) =>
  ({
    top,
    height,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect

/** a flow of top-level blocks; inner gives each block its markup */
function flowOf(specs: Array<{ top: number; height: number; inner: string; tag?: string }>) {
  const pm = document.createElement('div')
  for (const spec of specs) {
    const el = document.createElement(spec.tag ?? 'p')
    el.innerHTML = spec.inner
    el.getBoundingClientRect = () => rectOf(spec.top, spec.height)
    pm.appendChild(el)
  }
  return pm
}

describe('natural-flow measurement state', () => {
  it('changes only pagination widgets and the margins of page-leading blocks', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <p id="one">ordinary</p>
      <div id="two" class="page-gap"></div>
      <p id="three" class="page-break-lead-trim">
        <span id="four" class="page-gap-inline"></span>
      </p>
      <table><tbody><tr id="five" class="page-gap-inline"><td></td></tr></tbody></table>`
    const restore = enterNaturalFlow({ dom: root })
    const marked = () =>
      Array.from(root.querySelectorAll('.measuring-natural'), (element) => element.id)
    expect(root.classList.contains('measuring-natural')).toBe(false)
    expect(marked()).toEqual(['two', 'three', 'four', 'five'])
    restore()
    expect(marked()).toEqual([])
  })
})

describe('incremental flow measurement', () => {
  it.each(['img-wrap-square-left', 'img-wrap-topBottom'])(
    'reads the full flow when the outer image wrapper has %s',
    (name) => {
      const pm = flowOf([
        { top: 0, height: 20, inner: 'prefix' },
        { top: 20, height: 40, tag: 'div', inner: '<img class="doc-protected-img">' },
        { top: 60, height: 20, inner: 'suffix' },
      ])
      pm.children[1].className = `doc-protected ${name}`
      const cached = createBlockMeasurer(pm)
      try {
        const options = { origin: 0, factor: 1, width: 100, allowReuse: true }
        cached.measure(options)
        const prefix = vi.spyOn(pm.children[0], 'getBoundingClientRect')
        cached.measure(options)
        expect(prefix).toHaveBeenCalled()
      } finally {
        cached.dispose()
      }
    },
  )

  it('reuses inline-image blocks until the browser reports new intrinsic geometry', () => {
    const first = { top: 0, height: 20, inner: '<img src="picture.png">' }
    const second = { top: 20, height: 20, inner: 'neighbour' }
    const tail = { top: 40, height: 20, inner: 'tail' }
    const pm = flowOf([first, second, tail])
    let width = 80
    const img = pm.querySelector('img')!
    Object.defineProperty(img, 'naturalWidth', { get: () => width })
    const cached = createBlockMeasurer(pm)
    try {
      const options = { origin: 0, factor: 1, width: 100, allowReuse: true }
      cached.measure(options)
      const prefix = vi.spyOn(pm.children[0], 'getBoundingClientRect')
      pm.children[2].textContent = 'edited tail'
      const afterEdit = cached.measure(options)
      expect(prefix).not.toHaveBeenCalled()
      expect(afterEdit).toEqual(measureBlocks(pm, 0, 1))

      prefix.mockClear()
      width = 100
      first.height = 28
      second.top = 28
      tail.top = 48
      const afterImage = cached.measure(options)
      expect(prefix).toHaveBeenCalled()
      expect(afterImage).toEqual(measureBlocks(pm, 0, 1))
    } finally {
      cached.dispose()
    }
  })

  it('remeasures the published range without reading geometry in the newly mounted tail', () => {
    const pm = flowOf([
      { top: 0, height: 20, inner: 'first' },
      { top: 20, height: 40, tag: 'div', inner: '<table><tr><td>cell</td></tr></table>' },
    ])
    const expected = measureBlocks(pm, 0, 1)
    const tail = flowOf([
      { top: 90, height: 40, inner: 'tail<br class="doc-page-br">' },
    ]).firstElementChild!
    const tailRect = vi.spyOn(tail, 'getBoundingClientRect')
    pm.appendChild(tail)

    expect(measureBlocks(pm, 0, 1, undefined, false, undefined, 2)).toEqual(expected)
    expect(tailRect).not.toHaveBeenCalled()
    expect(measureBlocks(pm, 0, 1).blocks).toHaveLength(3)
  })

  it('measures the changed table and its flow neighbour while keeping an untouched prefix', () => {
    const pm = flowOf([
      { top: 0, height: 20, inner: 'first' },
      { top: 20, height: 20, inner: 'second' },
      { top: 40, height: 20, inner: 'neighbour' },
      {
        top: 60,
        height: 40,
        tag: 'div',
        inner: '<table><tr><td><div class="doc-cell-boxes"></div>cell</td></tr></table>',
      },
    ])
    const cached = createBlockMeasurer(pm)
    try {
      const options = { origin: 0, factor: 1, width: 100, allowReuse: true }
      cached.measure(options)
      const stable = vi.spyOn(pm.children[0], 'getBoundingClientRect')
      pm.querySelector('td')!.textContent = 'edited'
      pm.children[3].getBoundingClientRect = () => rectOf(60, 65)
      const afterEdit = cached.measure(options)
      expect(stable).not.toHaveBeenCalled()
      expect(afterEdit).toEqual(measureBlocks(pm, 0, 1))

      stable.mockClear()
      cached.measure({ ...options, firstChangedChild: () => 0 })
      expect(stable).toHaveBeenCalled()

      stable.mockClear()
      cached.measure({ ...options, width: 110 })
      expect(stable).toHaveBeenCalled()
    } finally {
      cached.dispose()
    }
  })
})

describe('measureBlocks — whole-flow break scan (genoffice#526 bucketing)', () => {
  it('a page-type break in a body paragraph forces the next block to a new page', () => {
    const pm = flowOf([
      { top: 0, height: 20, inner: 'one' },
      { top: 20, height: 20, inner: 'two<br class="doc-page-br">' },
      { top: 40, height: 20, inner: 'after' },
    ])
    const { blocks } = measureBlocks(pm, 0, 1)
    // the trailing break pushes the next block (the slicer consumes breakAfter;
    // measureBlocks itself sets no breakBefore there)
    expect(blocks[1].breakAfter).toBe(true)
    expect(blocks[2].breakBefore).toBeUndefined()
  })

  it('a page-type break inside a table cell never breaks the body flow', () => {
    const pm = flowOf([
      { top: 0, height: 20, inner: 'one' },
      {
        top: 20,
        height: 40,
        inner: '<table><tr><td>cell<br class="doc-page-br">text</td></tr></table>',
        tag: 'div',
      },
      { top: 60, height: 20, inner: 'after' },
    ])
    const { blocks } = measureBlocks(pm, 0, 1)
    expect(blocks[1].breakAfter).toBeUndefined()
    expect(blocks[2].breakBefore).toBeUndefined()
    // the table still marks the block non-reflowable
    expect(blocks[1].fixedWidthPx).toBeDefined()
    expect(blocks[0].fixedWidthPx).toBeUndefined()
  })

  it('a break inside a textbox lays out the box, not the body flow', () => {
    const pm = flowOf([
      { top: 0, height: 20, inner: 'one' },
      { top: 20, height: 30, inner: '<div class="doc-textbox">box<br class="doc-page-br"></div>' },
      { top: 50, height: 20, inner: 'after' },
    ])
    const { blocks } = measureBlocks(pm, 0, 1)
    expect(blocks[1].breakAfter).toBeUndefined()
    expect(blocks[2].breakBefore).toBeUndefined()
  })

  it('in-block inline gap bands subtract from the block height', () => {
    const pm = flowOf([
      {
        top: 0,
        height: 60,
        inner: 'before<div class="page-gap-inline" style="height:18px"></div>after',
      },
      { top: 60, height: 20, inner: 'next' },
    ])
    // jsdom lays out nothing: give the band the rect the browser would
    for (const g of pm.querySelectorAll('.page-gap-inline'))
      (g as HTMLElement).getBoundingClientRect = () => rectOf(40, 18)
    const { blocks } = measureBlocks(pm, 0, 1)
    expect(blocks[0].height).toBe(42)
  })

  it('an image-bearing paragraph is not an empty paragraph', () => {
    const pm = flowOf([
      { top: 0, height: 20, inner: '<img src="x.png">' },
      { top: 20, height: 20, inner: '' },
    ])
    const { blocks } = measureBlocks(pm, 0, 1)
    expect(blocks[0].emptyPara).toBeUndefined()
    expect(blocks[1].emptyPara).toBe(true)
  })

  it('a break-only paragraph keeps its dedicated line height despite the ProseMirror separator img', () => {
    const pm = flowOf([
      { top: 0, height: 20, inner: 'one' },
      {
        top: 20,
        height: 30,
        inner:
          '<img class="ProseMirror-separator" alt=""><br class="doc-page-br"><br class="ProseMirror-trailingBreak">',
      },
      { top: 50, height: 20, inner: 'after' },
    ])
    const { blocks } = measureBlocks(pm, 0, 1)
    expect(blocks[1].breakAfter).toBe(true)
    expect(blocks[1].breakOnlyLineH).toBe(30)
  })

  it('a leading break found through nested markup leads its block to the next page', () => {
    const pm = flowOf([
      {
        top: 0,
        height: 50,
        inner: '<div><span><em><br class="doc-page-br">c</em></span></div>',
      },
      { top: 50, height: 20, inner: 'after' },
    ])
    const { blocks } = measureBlocks(pm, 0, 1)
    // no text before the break, text after: the break leads (Word keeps the
    // break line here and starts the text on the next page). The block has
    // text, so it is not a break-only paragraph (no dedicated line height).
    expect(blocks[0].breakBefore).toBe(true)
    expect(blocks[0].breakOnlyLineH).toBeUndefined()
  })

  it('bucketing agrees with the old per-block scan on a mixed flow', () => {
    const pm = flowOf([
      { top: 0, height: 20, inner: 'plain' },
      { top: 20, height: 20, inner: 'lead<br class="doc-page-br">' },
      {
        top: 40,
        height: 30,
        inner: '<table><tr><td>x</td></tr></table>',
        tag: 'div',
      },
      {
        top: 70,
        height: 40,
        inner: 'a<div class="page-gap-inline" style="height:10px"></div>b<br class="doc-page-br">',
      },
      { top: 110, height: 20, inner: '<img src="y.png">' },
    ])
    for (const g of pm.querySelectorAll('.page-gap-inline'))
      (g as HTMLElement).getBoundingClientRect = () => rectOf(80, 10)
    const { blocks } = measureBlocks(pm, 0, 1)
    expect(blocks).toHaveLength(5)
    expect(blocks[1].breakAfter).toBe(true)
    expect(blocks[2].fixedWidthPx).toBeDefined()
    expect(blocks[3].height).toBe(30)
    expect(blocks[3].breakAfter).toBe(true)
    expect(blocks[4].emptyPara).toBeUndefined()
  })
})
