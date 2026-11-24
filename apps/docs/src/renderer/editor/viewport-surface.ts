import { getTextBetween, getTextSerializersFromSchema } from '@tiptap/core'
import { redoNoScroll, undoNoScroll } from '@tiptap/pm/history'
import { keydownHandler } from '@tiptap/pm/keymap'
import {
  AllSelection,
  EditorState,
  type Command,
  type Selection,
  type Transaction,
} from '@tiptap/pm/state'
import { Mapping, StepMap } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, EditorView, type EditorProps } from '@tiptap/pm/view'
import { positionViewportColumnSplits, projectViewportDecorations } from './viewport-decorations'
import {
  createViewportEditing,
  projectViewportTransaction,
  type EditingViewport,
} from './viewport-editing'
import type { LayoutBox } from './viewport-fragments'
import type { ViewportContent } from './viewport-layout'

export interface ViewportPacket {
  revision: number
  publication: number
  sequence: number
  content: ViewportContent
}

interface SourceState {
  state: EditorState
  revision: number
}

export interface ViewportRangeRequest {
  /** A selection request must reveal the owner's selection in the measured range. */
  reason: 'layout' | 'geometry' | 'selection' | 'transaction' | 'source'
  revision: number
  selection: Selection
  transaction?: Transaction
}

export interface ViewportSurfaceOptions {
  readSource(): SourceState
  editable?(source: EditorState): boolean
  /** Dispatch into the owner. readSource observes the resulting state before this returns. */
  dispatch(transaction: Transaction): void
  requestRange(request: ViewportRangeRequest): void
  onPublished?(packet: ViewportPacket): void
  attributes?: Record<string, string>
  nodeViews?: (source: EditorState) => EditorProps['nodeViews']
  /** Decorations use viewport-local positions. */
  decorations?: (source: EditorState, editing: EditingViewport) => readonly Decoration[]
}

export interface ViewportSurface {
  readonly view: EditorView | undefined
  publish(packet: ViewportPacket): 'applied' | 'deferred' | 'stale' | 'needs-range'
  /** Retire this publication and any prior answers for the revision. */
  invalidate(publication: number, revision?: number): void
  destroy(): void
}

function positionedBox(box: LayoutBox, left: number, top: number): string {
  return [
    'position:absolute',
    `left:${box.left - left}px`,
    `top:${box.top - top}px`,
    `width:${box.width}px`,
    `height:${box.height}px`,
    'right:auto',
    'bottom:auto',
    'margin:0',
    'min-width:0',
    'min-height:0',
    'max-width:none',
    'max-height:none',
    'box-sizing:border-box',
    'transform:none',
  ]
    .map((value) => `${value} !important`)
    .join(';')
}

type BorderOffsets = Map<number, { left: number; top: number }>

function placementDecorations(
  content: ViewportContent,
  editing: EditingViewport,
  borders?: BorderOffsets,
): DecorationSet {
  const decorations = projectViewportDecorations(content.decorations ?? [], editing, content.blocks)
  editing.doc.forEach((node, position, index) => {
    const block = content.blocks[index]
    decorations.push(
      Decoration.node(
        position,
        position + node.nodeSize,
        {
          style:
            positionedBox(block.box, content.canvas.left, content.canvas.top) +
            (block.hidden ? ';visibility:hidden !important;pointer-events:none !important' : ''),
        },
        { viewportBlock: true },
      ),
    )
    for (const picture of block.pictures ?? []) {
      const from = editing.toLocal(picture.from)!
      const to = editing.toLocal(picture.to)!
      const border = borders?.get(position)
      decorations.push(
        Decoration.node(
          from,
          to,
          {
            style: positionedBox(
              picture.box,
              block.box.left + (border?.left ?? 0),
              block.box.top + (border?.top ?? 0),
            ),
          },
          { viewportPicture: true },
        ),
      )
    }
  })
  return DecorationSet.create(editing.doc, decorations)
}

function retainsPlacements(
  previous: EditingViewport,
  next: EditingViewport,
  content: ViewportContent,
  geometry: DecorationSet,
): boolean {
  if (previous.doc.childCount !== next.doc.childCount) return false
  const blocks = new Set<number>()
  const pictures = new Set<number>()
  for (const decoration of geometry.find()) {
    if (decoration.spec.viewportBlock) blocks.add(decoration.from)
    if (decoration.spec.viewportPicture) pictures.add(decoration.from)
  }
  let complete = true
  next.doc.forEach((node, position, index) => {
    if (!blocks.has(position) || previous.doc.child(index).type !== node.type) complete = false
    if (content.blocks[index].pictures) {
      node.forEach((_child, offset) => {
        if (!pictures.has(position + 1 + offset)) complete = false
      })
    }
  })
  return complete
}

// Descendants positioned absolutely start from a paragraph's padding edge.
function pictureBorders(view: EditorView, content: ViewportContent): BorderOffsets {
  const borders: BorderOffsets = new Map()
  view.state.doc.forEach((_node, position, index) => {
    if (!content.blocks[index].pictures?.length) return
    const element = view.nodeDOM(position)
    if (!element || element.nodeType !== 1) return
    const style = view.dom.ownerDocument.defaultView!.getComputedStyle(element as Element)
    const left = Number.parseFloat(style.borderLeftWidth) || 0
    const top = Number.parseFloat(style.borderTopWidth) || 0
    if (left || top) borders.set(position, { left, top })
  })
  return borders
}

function positionTocLeaders(view: EditorView, content: ViewportContent): void {
  view.state.doc.forEach((_node, position, index) => {
    const root = view.nodeDOM(position)
    if (!(root instanceof HTMLElement)) return
    const widths = content.blocks[index].tocLeaders
    const tails = root.querySelectorAll<HTMLElement>('.doc-toc-tail')
    tails.forEach((tail, i) => {
      const width = widths?.length === tails.length ? widths[i] : null
      if (typeof width === 'number' && Number.isFinite(width) && width >= 0)
        tail.style.setProperty('--doc-toc-gap', `${width}px`)
      else tail.style.removeProperty('--doc-toc-gap')
    })
  })
}

function localSelection(selection: Selection, editing: EditingViewport): Selection | undefined {
  if (selection instanceof AllSelection) return new AllSelection(editing.doc)
  const anchor = editing.toLocal(selection.anchor)
  const head = editing.toLocal(selection.head)
  if (anchor === undefined || head === undefined) return
  if (
    selection.ranges.some(
      ({ $from, $to }) =>
        editing.toLocal($from.pos) === undefined || editing.toLocal($to.pos) === undefined,
    )
  )
    return
  const result = selection.map(
    editing.doc,
    new Mapping([StepMap.offset(anchor - selection.anchor)]),
  )
  if (
    result.anchor === anchor &&
    result.head === head &&
    result.constructor === selection.constructor
  )
    return result
}

function confirmedEditing(
  previous: EditingViewport,
  transaction: Transaction,
  source: EditorState['doc'],
): EditingViewport {
  // The mapper already checked the resulting slice. Its left edge and
  // synthetic boundary tokens are unchanged; accepted edits move the right edge.
  const delta = transaction.doc.content.size - previous.doc.content.size
  const sourceRange = { from: previous.sourceRange.from, to: previous.sourceRange.to + delta }
  const localRange = { from: previous.localRange.from, to: previous.localRange.to + delta }
  const offset = sourceRange.from - localRange.from
  return {
    source,
    doc: transaction.doc,
    sourceRange,
    localRange,
    toSource: (position) =>
      Number.isInteger(position) && position >= localRange.from && position <= localRange.to
        ? position + offset
        : undefined,
    toLocal: (position) =>
      Number.isInteger(position) && position >= sourceRange.from && position <= sourceRange.to
        ? position - offset
        : undefined,
  }
}

function validBox(box: LayoutBox): boolean {
  return (
    [box.left, box.top, box.width, box.height].every(Number.isFinite) &&
    box.width >= 0 &&
    box.height >= 0
  )
}

/** Content picked from the same placement index shares immutable boxes and
 * fragments. Scrolling within this window moves the canvas without updating PM. */
function samePlacements(previous: ViewportContent, next: ViewportContent): boolean {
  return (
    previous.canvas === next.canvas &&
    previous.decorations?.length === next.decorations?.length &&
    (previous.decorations?.every((decoration, index) => decoration === next.decorations?.[index]) ??
      true) &&
    previous.blocks.length === next.blocks.length &&
    previous.blocks.every((block, index) => {
      const other = next.blocks[index]
      if (block === other) return true
      return (
        block.from === other.from &&
        block.to === other.to &&
        block.box === other.box &&
        block.hidden === other.hidden &&
        block.tocLeaders === other.tocLeaders &&
        block.pictures?.length === other.pictures?.length &&
        (block.pictures?.every((picture, i) => picture === other.pictures?.[i]) ?? true)
      )
    })
  )
}

// ProseMirror's ViewTreeUpdater looks ahead five siblings for an exact match.
const VIEW_REUSE_LOOKAHEAD = 5

export function createViewportSurface(
  mount: HTMLElement,
  options: ViewportSurfaceOptions,
): ViewportSurface {
  const window = mount.ownerDocument.defaultView!
  let view: EditorView | undefined
  let disposed = false
  let endingComposition = false
  let compositionTimer: number | undefined
  const pendingHistory: Command[] = []
  let newest: ViewportPacket | undefined
  let deferred: ViewportPacket | undefined
  let invalidated: Pick<ViewportPacket, 'revision' | 'publication'> | undefined
  let current:
    | {
        content: ViewportContent
        editing: EditingViewport
        geometry: DecorationSet
        parked: boolean
        source: EditorState
        stamp: Pick<ViewportPacket, 'revision' | 'publication'>
      }
    | undefined

  const request = (
    reason: ViewportRangeRequest['reason'],
    source: SourceState,
    transaction?: Transaction,
  ) =>
    options.requestRange({
      reason,
      revision: source.revision,
      selection: source.state.selection,
      transaction,
    })

  const retired = (packet: Pick<ViewportPacket, 'revision' | 'publication'>) =>
    invalidated?.revision === packet.revision && packet.publication <= invalidated.publication

  const editable = () => options.editable?.(options.readSource().state) ?? true

  const attributes = () => {
    const { content, parked } = current!
    const { width, height } = content.canvas
    return {
      ...options.attributes,
      style: [
        options.attributes?.style,
        'position:relative !important',
        'box-sizing:border-box !important',
        'padding:0 !important',
        'border-width:0 !important',
        `width:${width}px !important`,
        `height:${height}px !important`,
        `min-height:${height}px !important`,
        parked ? 'caret-color:transparent !important' : '',
      ]
        .filter(Boolean)
        .join(';'),
    }
  }

  const decorations = (state: EditorState) => {
    const { editing, geometry, source } = current!
    const formatted = options.decorations?.(source, editing)
    return formatted?.length ? geometry.add(state.doc, [...formatted]) : geometry
  }

  const dispatchTransaction = (transaction: Transaction) => {
    const mounted = current
    if (!mounted || !view) return
    const source = options.readSource()
    if (transaction.docChanged && !editable()) return
    if (retired(mounted.stamp) && !view.composing && transaction.getMeta('composition') == null) {
      return request('layout', source)
    }
    if (source.state.doc !== mounted.editing.source) return request('source', source, transaction)
    if (mounted.parked && (transaction.docChanged || !transaction.selectionSet))
      return request('selection', source, transaction)
    const projected = projectViewportTransaction(
      mounted.editing,
      source.state,
      transaction,
      view.state.selection,
    )
    if (!projected) return request('transaction', source, transaction)

    options.dispatch(projected)
    if (current !== mounted || !view) return
    const confirmed = options.readSource()
    if (!confirmed.state.doc.eq(projected.doc)) return request('source', confirmed, transaction)
    if (
      transaction.docChanged &&
      source.state.selection instanceof AllSelection &&
      mounted.editing.sourceRange.to - mounted.editing.sourceRange.from !==
        source.state.doc.content.size
    )
      return request('geometry', confirmed)

    // Reflect only confirmed changes from the owner in this view.
    const editing = confirmedEditing(mounted.editing, transaction, confirmed.state.doc)
    const geometry = mounted.geometry.map(transaction.mapping, editing.doc)
    if (
      transaction.docChanged &&
      !retainsPlacements(mounted.editing, editing, mounted.content, geometry)
    ) {
      // The owner has the edit. Keep the last measured window until a new
      // publication can place the resulting blocks rather than flowing them
      // at the canvas origin.
      request('geometry', confirmed)
      return
    }
    const selection = localSelection(confirmed.state.selection, editing)
    current = {
      ...mounted,
      editing,
      geometry,
      parked: !selection,
      source: confirmed.state,
    }
    const local = EditorState.create({
      doc: editing.doc,
      selection,
      storedMarks: selection && !view.composing ? confirmed.state.storedMarks : null,
    })
    view.updateState(local)
  }

  const selectAll = (_view: EditorView, event: KeyboardEvent): boolean => {
    if (
      (!event.ctrlKey && !event.metaKey) ||
      event.shiftKey ||
      event.altKey ||
      event.key.toLowerCase() !== 'a'
    )
      return false
    const mounted = current
    if (!view || !mounted) return false
    const source = options.readSource()
    options.dispatch(source.state.tr.setSelection(new AllSelection(source.state.doc)))
    if (current !== mounted || !view) return true
    const confirmed = options.readSource()
    if (
      confirmed.state.doc === mounted.editing.source &&
      confirmed.state.selection instanceof AllSelection
    ) {
      current = { ...mounted, parked: false, source: confirmed.state }
      view.updateState(
        view.state.apply(view.state.tr.setSelection(new AllSelection(view.state.doc))),
      )
    } else request('source', confirmed)
    return true
  }

  const deleteDocumentSelection = (
    editor: EditorView,
    source: SourceState,
    mounted: typeof current,
    cut = false,
  ) => {
    if (
      !editor.editable ||
      !mounted ||
      current !== mounted ||
      mounted.editing.source !== source.state.doc ||
      !(editor.state.selection instanceof AllSelection) ||
      options.readSource().state !== source.state ||
      !editable()
    )
      return
    // The owner's full selection is independent of page geometry.
    const transaction = source.state.tr.deleteSelection()
    if (cut) transaction.setMeta('uiEvent', 'cut')
    options.dispatch(transaction)
    const updated = options.readSource()
    if (updated.state.doc !== source.state.doc) request('geometry', updated)
  }

  const canRunHistory = () => !disposed && editable()

  const applyHistory = (command: Command) => {
    if (!canRunHistory()) return
    const source = options.readSource()
    // History belongs to the whole document and can target an unmounted page.
    command(source.state, (transaction) => {
      options.dispatch(transaction)
      if (disposed) return
      const updated = options.readSource()
      if (
        updated.state.doc !== source.state.doc ||
        !updated.state.selection.eq(source.state.selection)
      )
        request('selection', updated)
    })
  }

  const drainHistory = () => {
    if (view?.composing) return
    for (const command of pendingHistory.splice(0)) applyHistory(command)
  }

  const runHistory = (command: Command) => {
    if (!endingComposition) applyHistory(command)
    else if (canRunHistory() && pendingHistory.push(command) === 1) {
      // ProseMirror may flush the final composition mutation in its own
      // microtask. Run after that flush and before another input task.
      window.queueMicrotask(() => window.queueMicrotask(drainHistory))
    }
    return true
  }

  const undo = () => runHistory(undoNoScroll)
  const redo = () => runHistory(redoNoScroll)
  const historyKeyDown = keydownHandler({
    'Mod-z': undo,
    'Shift-Mod-z': redo,
    'Mod-y': redo,
    'Mod-я': undo,
    'Shift-Mod-я': redo,
  })

  const historyInput = (editor: EditorView, event: InputEvent) => {
    const command =
      event.inputType === 'historyUndo' ? undo : event.inputType === 'historyRedo' ? redo : null
    if (!command || editor.composing || event.isComposing) return false
    event.preventDefault()
    return command()
  }

  const handleKeyDown = (editor: EditorView, event: KeyboardEvent): boolean => {
    if (event.isComposing || editor.composing) return false
    if (historyKeyDown(editor, event)) return true
    if (selectAll(editor, event)) return true
    if (event.key !== 'Backspace' && event.key !== 'Delete') return false
    const source = options.readSource()
    const selectedAll = source.state.selection instanceof AllSelection
    const locallySelectedAll = editor.state.selection instanceof AllSelection
    if (!selectedAll && !locallySelectedAll) return false
    if (selectedAll !== locallySelectedAll) request('selection', source)
    else deleteDocumentSelection(editor, source, current)
    return true
  }

  const copySelection = (editor: EditorView, event: ClipboardEvent): boolean => {
    const source = options.readSource()
    const selectedAll = source.state.selection instanceof AllSelection
    const locallySelectedAll = editor.state.selection instanceof AllSelection
    if (!selectedAll && !locallySelectedAll) return false
    event.preventDefault()
    const mounted = current
    if (selectedAll !== locallySelectedAll || mounted?.editing.source !== source.state.doc) {
      request('selection', source)
      return true
    }
    if (!event.clipboardData) return true
    try {
      const { doc, selection, schema } = source.state
      const { dom } = editor.serializeForClipboard(selection.content())
      const text = getTextBetween(doc, selection, {
        textSerializers: getTextSerializersFromSchema(schema),
      })
      event.clipboardData.setData('text/html', dom.innerHTML)
      event.clipboardData.setData('text/plain', text)
    } catch {
      return true
    }
    if (event.type === 'cut') deleteDocumentSelection(editor, source, mounted, true)
    return true
  }

  const finishComposition = () => {
    endingComposition = true
    window.clearTimeout(compositionTimer)
    compositionTimer = window.setTimeout(() => {
      compositionTimer = undefined
      endingComposition = false
      if (view?.composing) return
      drainHistory()
      if (!deferred) return
      const packet = deferred
      deferred = undefined
      if (!retired(packet) && packet.revision === options.readSource().revision) paint(packet)
    }, 0)
    return false
  }

  const discardDepartedPrefix = (next: EditingViewport, source: SourceState) => {
    const mounted = current
    if (!mounted || !view || mounted.editing.source !== next.source) return
    const start = next.sourceRange.from
    const index = mounted.content.blocks.findIndex((block) => block.from === start)
    if (index < VIEW_REUSE_LOOKAHEAD || next.sourceRange.to <= mounted.editing.sourceRange.to)
      return
    const from = mounted.editing.toLocal(start)
    if (from === undefined || view.state.doc.resolve(from).depth !== 0) return

    const content = { ...mounted.content, blocks: mounted.content.blocks.slice(index) }
    const tail = createViewportEditing(next.source, content.blocks)
    const trim = view.state.tr.delete(0, from)
    if (!tail || !tail.doc.eq(trim.doc)) return

    // Keep the overlap as the suffix of the old view before adding new nodes.
    // The local trim never dispatches to the owner or changes the document.
    current = {
      ...mounted,
      content,
      editing: { ...tail, doc: trim.doc },
      geometry: mounted.geometry.map(trim.mapping, trim.doc),
      parked: !localSelection(source.state.selection, tail),
      source: source.state,
    }
    view.updateState(view.state.apply(trim))
  }

  const paint = (packet: ViewportPacket): 'applied' | 'needs-range' => {
    const { content } = packet
    const source = options.readSource()
    const stamp = { revision: packet.revision, publication: packet.publication }
    if (
      current?.source === source.state &&
      view?.editable === (options.editable?.(source.state) ?? true) &&
      !content.model &&
      samePlacements(current.content, content)
    ) {
      current.stamp = stamp
      options.onPublished?.(packet)
      return 'applied'
    }
    const editing = createViewportEditing(source.state.doc, content.blocks)
    let matches = true
    if (content.model && editing) {
      try {
        matches =
          content.model.from === editing.sourceRange.from &&
          content.model.to === editing.sourceRange.to &&
          editing.doc.eq(source.state.schema.nodeFromJSON(content.model.document))
      } catch {
        matches = false
      }
    }
    if (
      !editing ||
      !matches ||
      !validBox(content.canvas) ||
      content.blocks.some(
        ({ box, pictures }) =>
          !validBox(box) || pictures?.some((picture) => !validBox(picture.box)),
      )
    ) {
      request('layout', source)
      return 'needs-range'
    }
    const selection = localSelection(source.state.selection, editing)
    const state = EditorState.create({
      doc: editing.doc,
      selection,
      storedMarks: selection ? source.state.storedMarks : null,
    })
    discardDepartedPrefix(editing, source)
    current = {
      content,
      editing,
      geometry: placementDecorations(content, editing),
      parked: !selection,
      source: source.state,
      stamp,
    }
    const props = {
      state,
      attributes,
      editable,
      decorations,
      nodeViews: options.nodeViews?.(source.state),
      handleKeyDown,
      handleDOMEvents: {
        beforeinput: historyInput,
        compositionend: finishComposition,
        copy: copySelection,
        cut: copySelection,
      },
      dispatchTransaction,
    }
    if (view) view.update(props)
    else view = new EditorView(mount, props)
    const borders = pictureBorders(view, content)
    if (borders.size) {
      current.geometry = placementDecorations(content, editing, borders)
      view.updateState(state)
    }
    positionViewportColumnSplits(view, content.decorations ?? [], editing)
    positionTocLeaders(view, content)
    options.onPublished?.(packet)
    return 'applied'
  }

  return {
    get view() {
      return view
    },
    publish(packet) {
      if (
        disposed ||
        [packet.revision, packet.publication, packet.sequence].some(
          (value) => !Number.isSafeInteger(value) || value < 0,
        ) ||
        packet.revision !== options.readSource().revision ||
        retired(packet) ||
        (newest &&
          (packet.revision < newest.revision ||
            (packet.revision === newest.revision &&
              (packet.publication < newest.publication ||
                (packet.publication === newest.publication &&
                  packet.sequence <= newest.sequence)))))
      )
        return 'stale'
      newest = packet
      if (view?.composing || endingComposition) {
        deferred = packet
        return 'deferred'
      }
      deferred = undefined
      return paint(packet)
    },
    invalidate(publication, revision = options.readSource().revision) {
      if (
        disposed ||
        !Number.isSafeInteger(publication) ||
        publication < 0 ||
        revision !== options.readSource().revision ||
        (invalidated?.revision === revision && invalidated.publication >= publication)
      )
        return
      invalidated = { publication, revision }
      if (deferred && retired(deferred)) deferred = undefined
    },
    destroy() {
      disposed = true
      window.clearTimeout(compositionTimer)
      pendingHistory.length = 0
      deferred = undefined
      current = undefined
      view?.destroy()
      view = undefined
    },
  }
}
