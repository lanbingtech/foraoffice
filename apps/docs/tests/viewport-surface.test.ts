import { Schema } from '@tiptap/pm/model'
import { AllSelection, EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { columnSplitDecoration, patchSplitNodeViews } from '../src/renderer/editor/column-layout'
import {
  readViewportDecorations,
  viewDecorationWindow,
} from '../src/renderer/editor/viewport-decorations'
import {
  createViewportSurface,
  type ViewportSurface,
} from '../src/renderer/editor/viewport-surface'
import type { ViewportContent } from '../src/renderer/editor/viewport-layout'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    docParagraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0],
    },
    docAnchor: { group: 'block', atom: true, toDOM: () => ['div'], toText: () => 'source atom' },
    docInlineImage: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { name: {}, wrap: { default: null } },
      toDOM: (node) => ['img', { alt: node.attrs.name }],
    },
    text: { group: 'inline' },
  },
})

const paragraph = (text: string) => schema.nodes.docParagraph.create(null, schema.text(text))
const picture = (name: string) => schema.nodes.docInlineImage.create({ name })
const box = (left: number, top: number, width = 120, height = 22) => ({ left, top, width, height })
const canvas = box(0, 0, 500, 1600)

const mounted: ViewportSurface[] = []
afterEach(() => {
  for (const item of mounted.splice(0)) item.destroy()
  document.body.replaceChildren()
})

function fixture(isEditable = true) {
  const doc = schema.node('doc', null, [
    paragraph('abc'),
    paragraph('DEF'),
    schema.nodes.docParagraph.create(null, [picture('one'), picture('two'), picture('three')]),
    paragraph('xyz'),
  ])
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 7, 6) })
  let revision = 0
  const requestRange = vi.fn()
  const dispatch = vi.fn((tr: Transaction) => {
    state = state.apply(tr)
    if (tr.docChanged) revision++
  })
  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const surface = createViewportSurface(mount, {
    readSource: () => ({ state, revision }),
    editable: () => isEditable,
    dispatch,
    requestRange,
    decorations: (_source, editing) => [
      Decoration.node(0, editing.doc.firstChild!.nodeSize, {
        class: 'formatted',
        style: 'border-left:2px solid; border-top:3px solid',
      }),
    ],
    nodeViews: () => ({
      docInlineImage(node, view) {
        const dom = view.dom.ownerDocument.createElement('img')
        dom.alt = node.attrs.name
        dom.dataset.view = 'image'
        return { dom }
      },
    }),
  })
  mounted.push(surface)
  return {
    surface,
    requestRange,
    dispatch,
    read: () => ({ state, revision }),
    setEditable: (value: boolean) => (isEditable = value),
  }
}

function placed(blocks: ViewportContent['blocks']): ViewportContent {
  return { canvas, blocks }
}

describe('viewport surface', () => {
  it('refreshes native editability when the owner republishes the same placements', () => {
    const { surface, setEditable } = fixture()
    const content = placed([{ from: 5, to: 10, box: box(30, 400) }])
    surface.publish({ revision: 0, publication: 1, sequence: 1, content })
    const view = surface.view!
    expect(view.dom.getAttribute('contenteditable')).toBe('true')

    setEditable(false)
    surface.publish({ revision: 0, publication: 1, sequence: 2, content })
    expect(view.dom.getAttribute('contenteditable')).toBe('false')

    setEditable(true)
    surface.publish({ revision: 0, publication: 1, sequence: 3, content })
    expect(view.dom.getAttribute('contenteditable')).toBe('true')
  })

  it.each(['Backspace', 'Delete'])('routes %s after Select All to the whole source', (key) => {
    const { surface, read, dispatch } = fixture()
    const before = read().state
    dispatch(before.tr.setSelection(new AllSelection(before.doc)))
    surface.publish({
      revision: 0,
      publication: 1,
      sequence: 1,
      content: placed([{ from: 5, to: 10, box: box(30, 400) }]),
    })
    const view = surface.view!
    view.focus()
    surface.invalidate(1)
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    expect(read().state.doc.childCount).toBe(1)
    expect(read().state.doc.textContent).toBe('')
  })

  it.each([
    { isEditable: true, canWrite: false, expectedDelete: false },
    { isEditable: false, canWrite: true, expectedDelete: false },
    { isEditable: true, canWrite: true, expectedDelete: true },
  ])(
    'copies the full selection before cutting ($isEditable, $canWrite)',
    ({ isEditable, canWrite, expectedDelete }) => {
      const { surface, read, dispatch } = fixture(isEditable)
      const before = read().state
      dispatch(before.tr.setSelection(new AllSelection(before.doc)))
      surface.publish({
        revision: 0,
        publication: 1,
        sequence: 1,
        content: placed([{ from: 5, to: 10, box: box(30, 400) }]),
      })
      const event = new Event('cut', { bubbles: true, cancelable: true })
      const setData = vi.fn()
      if (canWrite) Object.defineProperty(event, 'clipboardData', { value: { setData } })
      surface.view!.dom.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(read().state.doc.textContent).toBe(expectedDelete ? '' : 'abcDEFxyz')
      if (canWrite)
        expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('xyz'))
    },
  )

  it('uses Tiptap text serializers for selected source atoms outside the viewport', () => {
    const first = paragraph('abc')
    const doc = schema.node('doc', null, [first, schema.nodes.docAnchor.create()])
    const state = EditorState.create({ doc, selection: new AllSelection(doc) })
    const surface = createViewportSurface(
      document.body.appendChild(document.createElement('div')),
      {
        readSource: () => ({ state, revision: 0 }),
        dispatch: vi.fn(),
        requestRange: vi.fn(),
      },
    )
    mounted.push(surface)
    surface.publish({
      revision: 0,
      publication: 1,
      sequence: 1,
      content: placed([{ from: 0, to: first.nodeSize, box: box(30, 400) }]),
    })
    const event = new Event('copy', { bubbles: true, cancelable: true })
    const setData = vi.fn()
    Object.defineProperty(event, 'clipboardData', { value: { setData } })
    surface.view!.dom.dispatchEvent(event)
    expect(setData).toHaveBeenCalledWith('text/plain', 'abc\n\nsource atom')
  })

  it('selects and copies the whole document while painting only its visible range', () => {
    const { surface, read, requestRange } = fixture()
    const content = placed([{ from: 5, to: 10, box: box(33, 318) }])
    surface.publish({ publication: 1, revision: 0, sequence: 1, content })
    const view = surface.view!
    view.focus()
    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(read().state.selection).toBeInstanceOf(AllSelection)
    expect(read().state.selection.to).toBe(read().state.doc.content.size)
    expect(view.state.selection).toBeInstanceOf(AllSelection)
    expect(view.state.doc.textContent).toBe('DEF')

    const copy = new Event('copy', { bubbles: true, cancelable: true })
    const setData = vi.fn()
    Object.defineProperty(copy, 'clipboardData', { value: { setData } })
    view.dom.dispatchEvent(copy)
    expect(copy.defaultPrevented).toBe(true)
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      expect.stringMatching(/abc[\s\S]*DEF[\s\S]*xyz/),
    )

    view.dispatch(view.state.tr.insertText('new body'))
    expect(read().state.doc.textContent).toBe('new body')
    expect(requestRange).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'geometry' }))
  })

  it('preserves the source when a displayed Select All has already been cleared by the owner', () => {
    const { surface, read, dispatch, requestRange } = fixture()
    const { doc } = read().state
    dispatch(read().state.tr.setSelection(new AllSelection(doc)))
    const blocks: ViewportContent['blocks'][number][] = []
    doc.forEach((node, from) => blocks.push({ from, to: from + node.nodeSize, box: box(30, 400) }))
    surface.publish({ revision: 0, publication: 1, sequence: 1, content: placed(blocks) })
    dispatch(read().state.tr.setSelection(TextSelection.create(doc, 2)))

    const view = surface.view!
    const event = new Event('cut', { bubbles: true, cancelable: true })
    const setData = vi.fn()
    Object.defineProperty(event, 'clipboardData', { value: { setData } })
    view.dom.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(setData).not.toHaveBeenCalled()
    expect(requestRange).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'selection' }))

    view.dispatch(view.state.tr.insertText('replacement'))
    expect(read().state.doc).toBe(doc)
    expect(read().state.selection.from).toBe(2)
    expect(requestRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'transaction' }),
    )
  })

  it('keeps a split float inside the last atomic block and clears it with the next layout', () => {
    const first = paragraph('abc')
    const doc = schema.node('doc', null, [first, schema.nodes.docAnchor.create()])
    const state = EditorState.create({ doc })
    const surface = createViewportSurface(
      document.body.appendChild(document.createElement('div')),
      {
        readSource: () => ({ state, revision: 0 }),
        dispatch: vi.fn(),
        requestRange: vi.fn(),
      },
    )
    mounted.push(surface)
    const authority = new EditorView(document.body, {
      state,
      decorations: () =>
        DecorationSet.create(doc, [
          columnSplitDecoration(doc.content.size, 'float:left;width:40px'),
        ]),
    })
    try {
      const from = first.nodeSize
      const to = doc.content.size
      const content = placed([{ from, to, box: box(33, 318) }])
      patchSplitNodeViews(
        authority,
        new Map([[authority.nodeDOM(from) as HTMLElement, 'float:left;width:40px']]),
      )
      const decorations = viewDecorationWindow(readViewportDecorations(authority), from, to)
      surface.publish({
        publication: 1,
        revision: 0,
        sequence: 1,
        content: { ...content, decorations },
      })
      const block = surface.view!.nodeDOM(0) as HTMLElement
      expect(block.querySelector<HTMLElement>('.doc-col-split-float')?.style.width).toBe('40px')
      expect(surface.view!.dom.querySelectorAll('.doc-col-split-float')).toHaveLength(1)
      surface.publish({ publication: 2, revision: 0, sequence: 2, content })
      expect(
        (surface.view!.nodeDOM(0) as HTMLElement).querySelector('.doc-col-split-float'),
      ).toBeNull()
    } finally {
      authority.destroy()
    }
  })

  it('maps only measured owner styles to the visible document range', () => {
    const { surface, read } = fixture()
    const state = read().state
    const authority = new EditorView(document.body, {
      state,
      decorations: () =>
        DecorationSet.create(state.doc, [
          Decoration.node(
            5,
            10,
            {},
            {
              paintInViewport: true,
              frame: { class: 'layout-frame', style: '--doc-grid-pitch:26px' },
            },
          ),
          columnSplitDecoration(6, 'float:left;width:40px'),
          Decoration.node(5, 10, { class: 'owner-selection' }),
        ]),
    })
    try {
      const content = {
        ...placed([{ from: 5, to: 10, box: box(33, 318) }]),
        decorations: readViewportDecorations(authority),
      }
      expect(surface.publish({ publication: 1, revision: 0, sequence: 1, content })).toBe('applied')
      const el = surface.view!.nodeDOM(0) as HTMLElement
      expect(el.classList.contains('layout-frame')).toBe(true)
      expect(el.classList.contains('owner-selection')).toBe(false)
      expect(el.style.getPropertyValue('--doc-grid-pitch')).toBe('26px')
      expect(el.querySelector<HTMLElement>('.doc-col-split-float')?.style.width).toBe('40px')
    } finally {
      authority.destroy()
    }
  })

  it('keeps the overlapping DOM when the window advances past several blocks', () => {
    const nodes = Array.from({ length: 24 }, (_, index) => paragraph(`Block ${index}`))
    const doc = schema.node('doc', null, nodes)
    const state = EditorState.create({ doc })
    const mount = document.body.appendChild(document.createElement('div'))
    const surface = createViewportSurface(mount, {
      readSource: () => ({ state, revision: 0 }),
      dispatch: vi.fn(),
      requestRange: vi.fn(),
    })
    mounted.push(surface)
    const blocks: ViewportContent['blocks'] = []
    doc.forEach((node, from, index) => {
      blocks.push({ from, to: from + node.nodeSize, box: box(20, index * 48) })
    })
    surface.publish({
      publication: 1,
      revision: 0,
      sequence: 1,
      content: placed(blocks.slice(0, 16)),
    })
    const view = surface.view!
    const overlap = view.nodeDOM(blocks[8].from)
    surface.publish({ publication: 1, revision: 0, sequence: 2, content: placed(blocks.slice(8)) })
    expect(view.nodeDOM(0)).toBe(overlap)
  })

  it('keeps the same editor state while scrolling within identical placements', () => {
    const { surface } = fixture()
    const middle = { from: 5, to: 10, box: box(33, 318) }
    surface.publish({ publication: 1, revision: 0, sequence: 1, content: placed([middle]) })
    const view = surface.view!
    const state = view.state
    expect(
      surface.publish({
        publication: 1,
        revision: 0,
        sequence: 2,
        content: placed([{ ...middle }]),
      }),
    ).toBe('applied')
    expect(view.state).toBe(state)
  })

  it('does not project fresh input from a retired layout before replacement', () => {
    const { surface, dispatch, requestRange } = fixture()
    const content = placed([{ from: 5, to: 10, box: box(33, 318) }])
    surface.publish({ publication: 1, revision: 0, sequence: 1, content })
    const view = surface.view!
    surface.invalidate(1)
    view.dispatch(view.state.tr.insertText('!'))
    expect(dispatch).not.toHaveBeenCalled()
    expect(requestRange).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'layout' }))
    surface.publish({ publication: 2, revision: 0, sequence: 2, content })
    view.dispatch(view.state.tr.insertText('!'))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('replaces a window without replacing its editor root and keeps the native selection mapped', () => {
    const { surface } = fixture()
    const middle = { from: 5, to: 10, box: box(33, 318) }
    expect(
      surface.publish({ publication: 1, revision: 0, sequence: 1, content: placed([middle]) }),
    ).toBe('applied')
    const view = surface.view!
    const node = view.nodeDOM(0) as HTMLElement
    expect(node.style.top).toBe('318px')
    expect(node.style.left).toBe('33px')
    expect(node.style.width).toBe('120px')
    expect(node.style.height).toBe('22px')
    expect(node.classList.contains('formatted')).toBe(true)
    expect(view.dom.style.height).toBe('1600px')

    view.focus()
    expect(
      surface.publish({
        publication: 1,
        revision: 0,
        sequence: 2,
        content: placed([{ from: 0, to: 5, box: box(33, 280) }, middle]),
      }),
    ).toBe('applied')
    expect(surface.view).toBe(view)
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([7, 6])
    const native = document.getSelection()!
    expect(view.posAtDOM(native.anchorNode!, native.anchorOffset)).toBe(7)
    expect(view.posAtDOM(native.focusNode!, native.focusOffset)).toBe(6)
  })

  it('keeps exact positions for visible picture fragments and their styled parent border', () => {
    const { surface } = fixture()
    expect(
      surface.publish({
        publication: 2,
        revision: 0,
        sequence: 1,
        content: {
          ...placed([
            {
              from: 10,
              to: 15,
              box: box(31, 500, 220, 700),
              pictures: [{ from: 12, to: 13, box: box(61, 810, 80, 120) }],
            },
          ]),
          decorations: [{ from: 10, to: 15, attrs: { class: 'picture-frame' }, through: 15 }],
        },
      }),
    ).toBe('applied')
    const view = surface.view!
    expect(view.dom.querySelectorAll('img[data-view=image]')).toHaveLength(1)
    expect((view.nodeDOM(0) as HTMLElement).classList.contains('picture-frame')).toBe(true)
    const image = view.nodeDOM(1) as HTMLImageElement
    expect(image.alt).toBe('two')
    expect(image.dataset.view).toBe('image')
    expect(image.style.left).toBe('28px')
    expect(image.style.top).toBe('307px')
    expect(image.style.width).toBe('80px')
    expect(image.style.height).toBe('120px')
  })

  it('writes edits through to the current source and ignores old revisions and older geometry', () => {
    const { surface, dispatch, read } = fixture()
    const content = placed([{ from: 5, to: 10, box: box(30, 400) }])
    expect(surface.publish({ publication: 2, revision: 0, sequence: 2, content })).toBe('applied')
    expect(surface.publish({ publication: 1, revision: 0, sequence: 3, content })).toBe('stale')
    expect(surface.publish({ publication: 2, revision: 0, sequence: 1, content })).toBe('stale')

    const view = surface.view!
    view.dispatch(view.state.tr.insertText('中', 2))
    expect(read().state.doc.child(1).textContent).toBe('D中EF')
    expect(view.state.doc.textContent).toBe('D中EF')
    view.dispatch(view.state.tr.insertText('!', 3))
    expect(read().state.doc.child(1).textContent).toBe('D中!EF')
    expect(view.state.doc.textContent).toBe('D中!EF')
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(surface.publish({ publication: 3, revision: 0, sequence: 3, content })).toBe('stale')
  })

  it('requests rehydration for parked-caret edits and leaves the full source untouched', () => {
    const { surface, requestRange, dispatch, read } = fixture()
    const initial = read().state.doc
    const content = placed([{ from: 15, to: 20, box: box(30, 1250) }])
    expect(surface.publish({ publication: 1, revision: 0, sequence: 1, content })).toBe('applied')
    const view = surface.view!
    view.dispatch(view.state.tr.insertText('!', 2))
    expect(requestRange).toHaveBeenCalledWith(expect.objectContaining({ reason: 'selection' }))
    expect(dispatch).not.toHaveBeenCalled()
    expect(read().state.doc).toBe(initial)
  })

  it('refuses a mismatched model at the current revision without repainting the active window', () => {
    const { surface, requestRange } = fixture()
    const content = placed([{ from: 5, to: 10, box: box(30, 400) }])
    expect(surface.publish({ publication: 1, revision: 0, sequence: 1, content })).toBe('applied')
    const view = surface.view!
    const block = view.nodeDOM(0)
    const otherDoc = schema.node('doc', null, [paragraph('XYZ')])
    expect(
      surface.publish({
        publication: 2,
        revision: 0,
        sequence: 2,
        content: { ...content, model: { document: otherDoc.toJSON(), from: 5, to: 10 } },
      }),
    ).toBe('needs-range')
    expect(view.nodeDOM(0)).toBe(block)
    expect(view.state.doc.textContent).toBe('DEF')
    expect(requestRange).toHaveBeenCalledWith(expect.objectContaining({ reason: 'layout' }))
  })

  it('commits a split but keeps measured placement until the split blocks have authoritative boxes', () => {
    const { surface, dispatch, requestRange, read } = fixture()
    const content = placed([{ from: 5, to: 10, box: box(30, 400) }])
    expect(surface.publish({ publication: 1, revision: 0, sequence: 1, content })).toBe('applied')
    const view = surface.view!
    const measured = view.nodeDOM(0) as HTMLElement

    view.dispatch(view.state.tr.split(2))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(read().state.doc.child(1).textContent).toBe('D')
    expect(read().state.doc.child(2).textContent).toBe('EF')
    expect(requestRange).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'geometry', revision: 1, transaction: undefined }),
    )
    expect(view.nodeDOM(0)).toBe(measured)
    expect(measured.style.top).toBe('400px')
    expect(view.dom.querySelectorAll('p')).toHaveLength(1)

    expect(
      surface.publish({
        publication: 2,
        revision: 1,
        sequence: 2,
        content: placed([
          { from: 5, to: 8, box: box(30, 400) },
          { from: 8, to: 12, box: box(30, 430) },
        ]),
      }),
    ).toBe('applied')
    expect(surface.view).toBe(view)
    expect(
      Array.from(view.dom.querySelectorAll('p')).map((p) => [p.textContent, p.style.top]),
    ).toEqual([
      ['D', '400px'],
      ['EF', '430px'],
    ])
  })

  it('invalidates queued and in-flight geometry on the same revision without replacing active composition', async () => {
    const { surface } = fixture()
    const content = placed([{ from: 5, to: 10, box: box(30, 400) }])
    expect(surface.publish({ publication: 1, revision: 0, sequence: 1, content })).toBe('applied')
    const view = surface.view!
    const node = view.nodeDOM(0) as HTMLElement
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    expect(
      surface.publish({
        publication: 2,
        revision: 0,
        sequence: 2,
        content: placed([{ from: 5, to: 10, box: box(30, 420) }]),
      }),
    ).toBe('deferred')
    surface.invalidate(2)
    expect(surface.publish({ publication: 2, revision: 0, sequence: 3, content })).toBe('stale')
    expect(view.composing).toBe(true)
    expect(view.nodeDOM(0)).toBe(node)
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    expect((view.nodeDOM(0) as HTMLElement).style.top).toBe('400px')
    expect(
      surface.publish({
        publication: 3,
        revision: 0,
        sequence: 4,
        content: placed([{ from: 5, to: 10, box: box(30, 440) }]),
      }),
    ).toBe('applied')
    expect((view.nodeDOM(0) as HTMLElement).style.top).toBe('440px')
  })

  it('gives composition its DOM and applies only the newest deferred window on completion', async () => {
    const { surface } = fixture()
    const content = placed([{ from: 5, to: 10, box: box(30, 400) }])
    expect(surface.publish({ publication: 1, revision: 0, sequence: 1, content })).toBe('applied')
    const view = surface.view!
    const node = view.nodeDOM(0) as HTMLElement
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    expect(view.composing).toBe(true)
    expect(
      surface.publish({
        publication: 1,
        revision: 0,
        sequence: 3,
        content: placed([{ from: 5, to: 10, box: box(30, 440) }]),
      }),
    ).toBe('deferred')
    expect(
      surface.publish({
        publication: 1,
        revision: 0,
        sequence: 2,
        content: placed([{ from: 5, to: 10, box: box(30, 420) }]),
      }),
    ).toBe('stale')
    expect(view.nodeDOM(0)).toBe(node)
    expect(node.style.top).toBe('400px')
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await vi.waitFor(() => expect((view.nodeDOM(0) as HTMLElement).style.top).toBe('440px'))
    expect(surface.view).toBe(view)
  })
})
