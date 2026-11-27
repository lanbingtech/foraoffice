import { Extension, Node, type Editor } from '@tiptap/core'
import { history, undoDepth } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, expect, it, vi } from 'vitest'
import { documentPresentation } from '../src/renderer/editor/document-presentation'
import { startDocumentViewportSession } from '../src/renderer/editor/document-viewport-session'
import * as desktopLayout from '../src/renderer/editor/layout-client'
import type { LayoutMessage, LayoutReply } from '../src/renderer/editor/layout-client'
import type { ViewportContent } from '../src/renderer/editor/viewport-layout'

class TestPort extends EventTarget {
  readonly sent: LayoutMessage[] = []
  readonly close = vi.fn()
  start() {}

  postMessage(message: LayoutMessage) {
    this.sent.push(message)
  }

  receive(data: LayoutReply) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

const firstParagraph = { type: 'paragraph', content: [{ type: 'text', text: 'first' }] }
const secondParagraph = { type: 'paragraph', content: [{ type: 'text', text: 'second' }] }
const canvas = { left: 0, top: 0, width: 160, height: 500 }
const firstPage: ViewportContent = {
  canvas,
  blocks: [{ from: 0, to: 7, box: { left: 0, top: 0, width: 160, height: 40 } }],
  model: { document: { type: 'doc', content: [firstParagraph] }, from: 0, to: 7 },
}
const secondPage: ViewportContent = {
  canvas,
  blocks: [{ from: 7, to: 15, box: { left: 0, top: 200, width: 160, height: 40 } }],
  model: { document: { type: 'doc', content: [secondParagraph] }, from: 7, to: 15 },
}
const pageFrames = [
  { left: 0, top: 0, width: 160, height: 85, cutIndex: 0, sourceStart: 0 },
  { left: 0, top: 100, width: 160, height: 80, cutIndex: 4, sourceStart: null },
  { left: 0, top: 200, width: 160, height: 280, cutIndex: 5, sourceStart: 7 },
]

function setup() {
  const port = new TestPort()
  vi.spyOn(desktopLayout, 'connectDesktopLayout').mockImplementation(
    (_open, events) => new desktopLayout.LayoutClient(port as unknown as MessagePort, events),
  )
  const scroller = document.createElement('div')
  const mount = scroller.appendChild(document.createElement('div'))
  document.body.append(scroller)
  Object.defineProperty(scroller, 'clientHeight', { value: 100 })
  vi.spyOn(mount, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, -scroller.scrollTop, 160, 500),
  )
  const onReady = vi.fn<(editor: Editor) => void>()
  const onFailure = vi.fn<(reason: string, takeEditor: () => Editor | undefined) => void>()
  const onPage = vi.fn<(page: number, total: number) => void>()
  const configure = vi.fn<(editor: Editor) => void>()
  const session = startDocumentViewportSession(
    {
      type: 'open',
      file: { path: '', name: 'document.docx', dataUrl: '', hash: '', data: new ArrayBuffer(0) },
      width: 160,
      height: 100,
      language: 'en',
    },
    {
      scroller,
      mount,
      extensions: [
        Node.create({ name: 'doc', topNode: true, content: 'paragraph+' }),
        Node.create({ name: 'paragraph', content: 'text*', renderHTML: () => ['p', 0] }),
        Node.create({ name: 'text' }),
        Extension.create({ name: 'undo', addProseMirrorPlugins: () => [history()] }),
      ],
      configure,
      onReady,
      onFailure,
      onPage,
    },
  )
  const source = () =>
    port.receive({
      type: 'source',
      revision: 0,
      root: { type: 'doc' },
      blocks: new ReadableStream({
        start(controller) {
          controller.enqueue([firstParagraph, secondParagraph])
          controller.close()
        },
      }),
    })
  return { port, source, session, configure, onReady, onFailure, onPage, scroller, mount }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

it('opens a verified early viewport only after the complete source and replaces it at the latest visible bounds', async () => {
  const { port, source, session, onReady, onFailure, onPage, scroller, mount } = setup()
  port.receive({
    type: 'layout',
    revision: 0,
    publication: 1,
    opening: true,
    pages: [],
    initial: firstPage,
  })
  expect(mount.querySelector('.ProseMirror')).toBeNull()
  source()
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  const editor = onReady.mock.calls[0][0]
  expect(editor.state.doc.textContent).toBe('firstsecond')
  expect(mount.textContent).toBe('first')
  const view = documentPresentation(editor).dom
  const focused = vi.fn()
  editor.on('focus', focused)
  documentPresentation(editor).focus()
  expect(editor.isFocused).toBe(true)
  expect(focused).toHaveBeenCalledTimes(1)
  view?.blur()
  expect(editor.isFocused).toBe(false)

  port.receive({
    type: 'layout',
    revision: 0,
    publication: 2,
    pages: [],
    initial: firstPage,
    pageFrames,
  })
  expect(onPage).toHaveBeenCalledExactlyOnceWith(1, 3)
  scroller.scrollTop = 185
  scroller.dispatchEvent(new Event('scroll'))
  scroller.scrollTop = 200
  scroller.dispatchEvent(new Event('scroll'))
  expect(port.sent.slice(-2)).toEqual([
    { type: 'viewport', publication: 2, sequence: 1, bounds: { top: 185, bottom: 285 } },
    { type: 'viewport', publication: 2, sequence: 2, bounds: { top: 200, bottom: 300 } },
  ])
  port.receive({
    type: 'viewport',
    revision: 0,
    publication: 2,
    sequence: 1,
    content: { ...secondPage, blocks: [{ ...secondPage.blocks[0], from: 8 }] },
  })
  expect(mount.textContent).toBe('first')
  expect(onPage).toHaveBeenCalledTimes(1)
  expect(onFailure).not.toHaveBeenCalled()
  port.receive({ type: 'viewport', revision: 0, publication: 2, sequence: 2, content: secondPage })
  expect(mount.textContent).toBe('second')
  expect(onPage).toHaveBeenLastCalledWith(3, 3)
  expect(documentPresentation(editor).dom).toBe(view)
  expect(onReady).toHaveBeenCalledTimes(1)
  session.dispose()
  session.dispose()
  expect(editor.isDestroyed).toBe(true)
  expect(port.close).toHaveBeenCalledTimes(1)
})

it('releases an opening session that never publishes its first usable viewport', () => {
  vi.useFakeTimers()
  const { port, session, onReady, onFailure } = setup()
  vi.advanceTimersByTime(30_000)
  expect(onReady).not.toHaveBeenCalled()
  expect(onFailure).toHaveBeenCalledTimes(1)
  expect(port.close).toHaveBeenCalledTimes(1)
  session.dispose()
})

it('carries the latest navigation through invalidation and ignores superseded unavailable geometry', async () => {
  const { port, source, session, onReady, onFailure, onPage, scroller, mount } = setup()
  port.receive({ type: 'layout', revision: 0, publication: 1, pages: [], initial: firstPage })
  source()
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  const editor = onReady.mock.calls[0][0]
  const body = documentPresentation(editor)
  body.select(TextSelection.create(editor.state.doc, 8, 10), true)
  expect(port.sent.at(-1)).toMatchObject({ type: 'reveal', revision: 0, position: 10 })
  port.receive({ type: 'invalidated', publication: 2 })
  body.scrollTo(8, 10)
  body.scrollTo(11, 13)
  editor.commands.insertContentAt(1, '!', { updateSelection: false })

  port.receive({ type: 'layout', revision: 1, publication: 3, pages: [], pageFrames })
  const reveal = port.sent.at(-1) as Extract<LayoutMessage, { type: 'reveal' }>
  expect(reveal).toMatchObject({ type: 'reveal', revision: 1, publication: 3, position: 12 })
  body.scrollTo(12, 14)
  const next = port.sent.at(-1) as Extract<LayoutMessage, { type: 'reveal' }>
  port.receive({ ...reveal, type: 'reveal-unavailable', position: 12 })
  expect(onFailure).not.toHaveBeenCalled()
  expect(mount.textContent).toBe('first')
  expect(scroller.scrollTop).toBe(0)
  expect(editor.state.selection.from).toBe(9)

  port.receive({
    ...next,
    type: 'viewport',
    reveal: { position: 12, top: 180 },
    content: {
      ...secondPage,
      blocks: [{ ...secondPage.blocks[0], from: 8, to: 16 }],
      model: { ...secondPage.model!, from: 8, to: 16 },
    },
  })
  expect(mount.textContent).toBe('second')
  expect(scroller.scrollTop).toBe(180)
  expect(onPage).toHaveBeenCalledExactlyOnceWith(3, 3)
  expect(editor.state.selection.from).toBe(9)
  session.dispose()
})

it.each(['unavailable reveal', 'incompatible viewport'])(
  'hands off on a current %s while preserving the frame until takeover',
  async (failure) => {
    const { port, source, session, onReady, onFailure, scroller, mount } = setup()
    port.receive({ type: 'layout', revision: 0, publication: 1, pages: [], initial: firstPage })
    source()
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
    const owner = onReady.mock.calls[0][0]
    const body = documentPresentation(owner)
    const active = body.dom
    onFailure.mockImplementation((_reason, takeEditor) => {
      expect(active?.isConnected).toBe(true)
      expect(mount.textContent).toBe('first')
      expect(takeEditor()).toBe(owner)
      expect(active?.isConnected).toBe(false)
      owner.mount(mount)
    })

    if (failure === 'unavailable reveal') {
      body.scrollTo(8, 10)
      const reveal = port.sent.at(-1) as Extract<LayoutMessage, { type: 'reveal' }>
      port.receive({ ...reveal, type: 'reveal-unavailable' })
    } else {
      scroller.scrollTop = 200
      scroller.dispatchEvent(new Event('scroll'))
      port.receive({
        type: 'viewport',
        revision: 0,
        publication: 1,
        sequence: 1,
        content: { ...secondPage, blocks: [{ ...secondPage.blocks[0], from: 8 }] },
      })
    }

    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(mount.textContent).toBe('firstsecond')
    session.dispose()
    expect(owner.isDestroyed).toBe(false)
    owner.destroy()
  },
)

it('hands the edited source and undo history to the retained body only once on terminal failure', async () => {
  const { port, source, session, onReady, onFailure, mount } = setup()
  port.receive({ type: 'layout', revision: 0, publication: 1, pages: [], initial: firstPage })
  source()
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  const editor = onReady.mock.calls[0][0]
  editor.commands.insertContentAt(1, '!')
  const native = document.createElement('div')
  document.body.append(native)
  onFailure.mockImplementation((_reason, takeEditor) => {
    expect(takeEditor()).toBe(editor)
    expect(takeEditor()).toBeUndefined()
    editor.mount(native)
  })

  port.receive({ type: 'failure', reason: 'layout disconnected' })
  session.dispose()
  expect(onFailure).toHaveBeenCalledTimes(1)
  expect(mount.querySelector('.ProseMirror')).toBeNull()
  expect(native.textContent).toBe('!firstsecond')
  expect(editor.isDestroyed).toBe(false)
  expect(undoDepth(editor.state)).toBe(1)
  editor.destroy()
})

it('reports invalid opening geometry without replacing the retained body', async () => {
  const { port, source, session, configure, onReady, onFailure, mount } = setup()
  const retained = mount.appendChild(document.createElement('p'))
  const geometry = { ...firstPage, blocks: [{ ...firstPage.blocks[0], to: 8 }] }
  port.receive({
    type: 'layout',
    revision: 0,
    publication: 1,
    opening: true,
    pages: [],
    initial: geometry,
  })
  source()
  await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1))
  expect(onFailure).not.toHaveBeenCalled()
  onFailure.mockImplementation((_reason, takeEditor) => expect(takeEditor()).toBeUndefined())
  port.receive({ type: 'layout', revision: 0, publication: 2, pages: [], initial: geometry })
  await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1))
  expect(configure.mock.calls[0][0].isDestroyed).toBe(true)
  expect(onReady).not.toHaveBeenCalled()
  expect(mount.children).toHaveLength(1)
  expect(mount.firstChild).toBe(retained)
  session.dispose()
})

it('retires a deferred viewport when a newer scroll is requested during composition', async () => {
  const { port, source, session, onReady, scroller, mount } = setup()
  port.receive({ type: 'layout', revision: 0, publication: 1, pages: [], initial: firstPage })
  source()
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
  const owner = onReady.mock.calls[0][0]
  const view = documentPresentation(owner).dom!
  view.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  scroller.scrollTop = 200
  scroller.dispatchEvent(new Event('scroll'))
  port.receive({ type: 'viewport', revision: 0, publication: 1, sequence: 1, content: secondPage })
  expect(mount.textContent).toBe('first')
  scroller.scrollTop = 10
  scroller.dispatchEvent(new Event('scroll'))
  view.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  expect(mount.textContent).toBe('first')
  port.receive({ type: 'viewport', revision: 0, publication: 1, sequence: 2, content: firstPage })
  expect(mount.textContent).toBe('first')
  expect(session.takeEditor()).toBe(owner)
  expect(session.takeEditor()).toBeUndefined()
  session.dispose()
  expect(owner.isDestroyed).toBe(false)
  owner.destroy()
})
