import {
  extensions as coreExtensions,
  getTextBetween,
  getTextSerializersFromSchema,
  type Editor,
} from '@tiptap/core'
import { redoNoScroll, undoNoScroll } from '@tiptap/pm/history'
import { keydownHandler } from '@tiptap/pm/keymap'
import { DOMSerializer } from '@tiptap/pm/model'
import {
  AllSelection,
  EditorState,
  TextSelection,
  type Command,
  type Selection,
  type Transaction,
} from '@tiptap/pm/state'
import { Mapping, StepMap } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, EditorView, type EditorProps } from '@tiptap/pm/view'
import { sourceCompositionKey } from './source-composition'
import { mountDocumentPresentation } from './document-presentation'
import { positionViewportColumnSplits, projectViewportDecorations } from './viewport-decorations'
import {
  createViewportEditing,
  projectViewportFollowUps,
  projectViewportTransaction,
  type EditingViewport,
} from './viewport-editing'
import type { LayoutBox } from './viewport-fragments'
import type { ViewportContent } from './viewport-layout'
import { renderTablePaint } from './viewport-table-paint'

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
  reason: 'layout' | 'geometry' | 'selection' | 'transaction' | 'source' | 'navigation'
  revision: number
  selection: Selection
  /** A UI navigation target can differ from the owner's selection. */
  target?: { from: number; to: number; align: 'node' | 'caret' }
  transaction?: Transaction
}

export interface ViewportSurfaceOptions {
  ownerEditor?: Editor
  readSource(): SourceState
  editable?(source: EditorState): boolean
  /** Dispatch synchronously. Return the applied chain when the owner appends steps. */
  dispatch(transaction: Transaction): readonly Transaction[] | void
  requestRange(request: ViewportRangeRequest): void
  /** A newer request may supersede a frame that was deferred during composition. */
  isCurrent?(packet: ViewportPacket): boolean
  onPublished?(packet: ViewportPacket): void
  attributes?: Record<string, string>
  clipboard?: Pick<
    EditorProps,
    'clipboardTextParser' | 'handlePaste' | 'transformPasted' | 'transformPastedHTML'
  > & { beforePaste?: NonNullable<EditorProps['handleDOMEvents']>['paste'] }
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
    const continuation =
      (block.paragraph && block.paragraph.from > block.from + 1) ||
      (block.tableCellText && block.tableCellText.from > block.tableCellText.position + 1)
    decorations.push(
      Decoration.node(
        position,
        position + node.nodeSize,
        {
          style:
            (block.tableCellTypography ? `${block.tableCellTypography};` : '') +
            positionedBox(block.box, content.canvas.left, content.canvas.top) +
            (continuation ? ';text-indent:0 !important' : '') +
            (content.surrounding ? ';pointer-events:auto;overflow:clip' : '') +
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
    cellTextblock: previous.cellTextblock,
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

function readWindow(source: EditorState, content: ViewportContent): EditingViewport | undefined {
  if (
    !validBox(content.canvas) ||
    content.blocks.some(
      ({ box, pictures }) => !validBox(box) || pictures?.some((picture) => !validBox(picture.box)),
    )
  )
    return
  const editing = createViewportEditing(source.doc, content.blocks)
  if (!editing || !content.model) return editing
  try {
    if (
      content.model.from === editing.sourceRange.from &&
      content.model.to === editing.sourceRange.to &&
      editing.doc.eq(source.schema.nodeFromJSON(content.model.document))
    )
      return editing
  } catch {
    // A packet for a different schema cannot enter the view.
  }
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
        (block.box === other.box ||
          (block.paragraph &&
            block.box.top === other.box.top &&
            block.box.left === other.box.left &&
            block.box.width === other.box.width &&
            block.box.height === other.box.height)) &&
        block.paragraph?.from === other.paragraph?.from &&
        block.paragraph?.to === other.paragraph?.to &&
        block.tableCellText?.position === other.tableCellText?.position &&
        block.tableCellText?.from === other.tableCellText?.from &&
        block.tableCellText?.to === other.tableCellText?.to &&
        block.tableCellTypography === other.tableCellTypography &&
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
  const root = mount.ownerDocument.createElement('div')
  root.style.cssText = 'position:relative;isolation:isolate;margin-inline:auto'
  mount.append(root)
  let view: EditorView | undefined
  let surroundingView: EditorView | undefined
  let disposed = false
  let endingComposition = false
  let compositionSession: symbol | undefined
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

  const ownerFocusEvent = (type: 'focus' | 'blur') => (_view: EditorView, event: FocusEvent) => {
    const owner = options.ownerEditor
    if (!owner) return false
    const focus = coreExtensions.focusEventsPluginKey.get(owner.state)
    return focus?.props.handleDOMEvents?.[type]?.call(focus, owner.view, event) ?? false
  }

  const canvasAttributes = (content: ViewportContent, extra?: string) => {
    const { width, height } = content.canvas
    return {
      ...options.attributes,
      style: [
        options.attributes?.style,
        'position:relative !important',
        'box-sizing:border-box !important',
        'margin:0 !important',
        'padding:0 !important',
        'border-width:0 !important',
        `width:${width}px !important`,
        `height:${height}px !important`,
        `min-height:${height}px !important`,
        extra,
      ]
        .filter(Boolean)
        .join(';'),
    }
  }

  const attributes = () => {
    const { content, parked } = current!
    return canvasAttributes(
      content,
      [
        parked ? 'caret-color:transparent !important' : '',
        content.surrounding
          ? 'z-index:1;background:transparent !important;box-shadow:none !important;pointer-events:none'
          : '',
      ].join(';'),
    )
  }

  const decorations = (state: EditorState) => {
    const { editing, geometry, source } = current!
    const formatted = options.decorations?.(source, editing)
    return formatted?.length ? geometry.add(state.doc, [...formatted]) : geometry
  }

  const showConfirmed = (
    mounted: NonNullable<typeof current>,
    confirmed: SourceState,
    visible: Transaction,
  ): boolean => {
    if (current !== mounted || !view) return false
    const editing = confirmedEditing(mounted.editing, visible, confirmed.state.doc)
    const geometry = mounted.geometry.map(visible.mapping, editing.doc)
    if (
      visible.docChanged &&
      !retainsPlacements(mounted.editing, editing, mounted.content, geometry)
    )
      return false
    const selection = localSelection(confirmed.state.selection, editing)
    current = {
      ...mounted,
      editing,
      geometry,
      parked: !selection,
      source: confirmed.state,
    }
    view.updateState(
      EditorState.create({
        doc: editing.doc,
        selection,
        storedMarks: selection && !view.composing ? confirmed.state.storedMarks : null,
      }),
    )
    if (visible.docChanged && mounted.content.surrounding) {
      const paragraph = view.nodeDOM(0)
      if (paragraph instanceof HTMLElement && paragraph.scrollHeight > paragraph.clientHeight)
        request('geometry', confirmed)
    }
    return true
  }

  const commit = (source: SourceState, transaction: Transaction, projected: Transaction) => {
    const mounted = current
    const applied = options.dispatch(projected)
    if (!mounted || current !== mounted || !view) return
    const confirmed = options.readSource()
    if (mounted.editing.source !== source.state.doc) return request('source', confirmed)
    if (
      !transaction.docChanged &&
      !transaction.selectionSet &&
      !transaction.storedMarksSet &&
      confirmed.state.doc === source.state.doc &&
      confirmed.state.selection.eq(source.state.selection) &&
      confirmed.state.storedMarks === source.state.storedMarks
    )
      return
    let visible = transaction
    if (!confirmed.state.doc.eq(projected.doc)) {
      const completed =
        applied &&
        applied[0] === projected &&
        applied.at(-1)?.doc === confirmed.state.doc &&
        projectViewportFollowUps(mounted.editing, view.state, transaction, applied.slice(1))
      if (!completed) return request('source', confirmed)
      visible = completed
    }
    if (
      transaction.docChanged &&
      source.state.selection instanceof AllSelection &&
      mounted.editing.sourceRange.to - mounted.editing.sourceRange.from !==
        source.state.doc.content.size
    )
      return request('geometry', confirmed)

    if (!showConfirmed(mounted, confirmed, visible)) {
      // The owner has the edit. Keep the last measured window until a new
      // publication can place the resulting blocks rather than flowing them
      // at the canvas origin.
      request('geometry', confirmed)
    }
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
    commit(source, transaction, projected)
  }

  const adoptParkedCaret = (local: EditorView, event: MouseEvent): boolean => {
    if (
      !current?.parked ||
      event.button !== 0 ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return false
    const hit = local.posAtCoords({ left: event.clientX, top: event.clientY })
    if (!hit || current.editing.toSource(hit.pos) === undefined) return false
    const position = local.state.doc.resolve(hit.pos)
    if (position.parent.inlineContent)
      dispatchTransaction(
        local.state.tr
          .setSelection(TextSelection.create(local.state.doc, hit.pos))
          .setMeta('pointer', true),
      )
    return false
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
    const mounted = current
    // History belongs to the whole document and can target an unmounted page.
    command(source.state, (transaction) => {
      const applied = options.dispatch(transaction)
      if (disposed) return
      const updated = options.readSource()
      if (
        updated.state.doc === source.state.doc &&
        updated.state.selection.eq(source.state.selection)
      )
        return
      const accepted =
        applied ?? (transaction.doc === updated.state.doc ? [transaction] : undefined)
      if (
        mounted &&
        current === mounted &&
        view &&
        mounted.editing.source === source.state.doc &&
        !retired(mounted.stamp) &&
        accepted &&
        accepted[0] === transaction &&
        accepted.at(-1)?.doc === updated.state.doc
      ) {
        const visible = projectViewportFollowUps(
          mounted.editing,
          view.state,
          view.state.tr,
          accepted,
        )
        if (visible) showConfirmed(mounted, updated, visible)
      }
      // The caret can map to a mounted range that extends beyond the screen.
      request('selection', updated)
    })
  }

  const closeComposition = (
    source: SourceState,
    session = compositionSession,
  ): Transaction | undefined => {
    if (compositionSession === session) compositionSession = undefined
    if (session && sourceCompositionKey.getState(source.state)?.token === session)
      return source.state.tr.setMeta(sourceCompositionKey, null)
  }

  const settleInput = () => {
    if (!view || view.composing) return
    if (compositionSession) {
      const source = options.readSource()
      const transaction = closeComposition(source)
      // The browser may finish with no further DOM mutation. Let the source
      // finalize the input before a queued command reads its history.
      if (transaction) commit(source, view.state.tr, transaction)
    }
    for (const command of pendingHistory.splice(0)) applyHistory(command)
  }

  const runHistory = (command: Command) => {
    if (!endingComposition) applyHistory(command)
    else if (canRunHistory() && pendingHistory.push(command) === 1) {
      // ProseMirror may flush the final composition mutation in its own
      // microtask. Run after that flush and before another input task.
      window.queueMicrotask(() => window.queueMicrotask(settleInput))
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

  const startComposition = (activeView: EditorView) => {
    const source = options.readSource()
    if (
      activeView.editable &&
      (options.editable?.(source.state) ?? true) &&
      current?.editing.source === source.state.doc &&
      sourceCompositionKey.getState(source.state) === null
    ) {
      const session = Symbol()
      compositionSession = session
      options.dispatch(source.state.tr.setMeta(sourceCompositionKey, session))
      if (disposed || activeView.isDestroyed) {
        const transaction = closeComposition(options.readSource(), session)
        if (transaction) options.dispatch(transaction)
        return true
      }
    }
    return false
  }

  const finishComposition = () => {
    endingComposition = true
    // ProseMirror's microtask publishes the final DOM mutation first.
    window.queueMicrotask(() => window.queueMicrotask(settleInput))
    window.clearTimeout(compositionTimer)
    compositionTimer = window.setTimeout(() => {
      compositionTimer = undefined
      endingComposition = false
      if (view?.composing) return
      settleInput()
      if (!deferred) return
      const packet = deferred
      deferred = undefined
      if (
        !retired(packet) &&
        packet.revision === options.readSource().revision &&
        options.isCurrent?.(packet) !== false
      )
        paint(packet)
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

  const paintSurrounding = (
    content: ViewportContent,
    active: EditingViewport,
    source: EditorState,
  ): boolean => {
    const paper = content.surrounding
    if (!paper) {
      surroundingView?.destroy()
      surroundingView = undefined
      return true
    }
    const scene = readWindow(source, paper)
    const position = active.cellTextblock
    const local = position === undefined ? undefined : scene?.toLocal(position)
    const paragraph = local === undefined ? undefined : scene?.doc.nodeAt(local)
    if (
      !scene ||
      local === undefined ||
      position === undefined ||
      paragraph?.type.name !== 'docParagraph' ||
      !active.doc.firstChild?.sameMarkup(paragraph) ||
      active.sourceRange.from !== position + 1 ||
      active.sourceRange.to !== position + paragraph.nodeSize - 1 ||
      (['left', 'top', 'width', 'height'] as const).some(
        (key) => paper.canvas[key] !== content.canvas[key],
      )
    )
      return false

    const state = EditorState.create({ doc: scene.doc })
    const muted = Decoration.node(local, local + paragraph.nodeSize, {
      style: 'visibility:hidden !important',
    })
    let geometry = placementDecorations(paper, scene).add(scene.doc, [muted])
    const nodeViews = options.nodeViews?.(source)
    const table = paper.tablePaint
    const tablePlacement = table && paper.blocks.find(({ from }) => from === table.position)
    const tableView: NonNullable<EditorProps['nodeViews']>['docTable'] = (
      node,
      editor,
      getPos,
      decorations,
      inner,
    ) => {
      const at = getPos()
      if (table && tablePlacement && at !== undefined && scene.toSource(at) === table.position)
        return { dom: renderTablePaint(root.ownerDocument, table, position, tablePlacement.box) }
      return (
        nodeViews?.docTable?.(node, editor, getPos, decorations, inner) ??
        DOMSerializer.renderSpec(root.ownerDocument, node.type.spec.toDOM!(node))
      )
    }
    const props = {
      state,
      editable: () => false,
      attributes: {
        ...canvasAttributes(
          paper,
          'position:absolute !important;inset:0 auto auto 0;z-index:0;pointer-events:none;user-select:none',
        ),
        'aria-hidden': 'true',
        inert: '',
      },
      decorations: () => geometry,
      nodeViews: tablePlacement ? { ...nodeViews, docTable: tableView } : nodeViews,
    }
    if (surroundingView) surroundingView.update(props)
    else {
      surroundingView = new EditorView(root, props)
      root.prepend(surroundingView.dom)
    }
    const borders = pictureBorders(surroundingView, paper)
    if (borders.size) {
      geometry = placementDecorations(paper, scene, borders).add(scene.doc, [muted])
      surroundingView.updateState(state)
    }
    positionViewportColumnSplits(surroundingView, paper.decorations ?? [], scene)
    positionTocLeaders(surroundingView, paper)
    return true
  }

  const paint = (packet: ViewportPacket): 'applied' | 'needs-range' => {
    const { content } = packet
    const source = options.readSource()
    const stamp = { revision: packet.revision, publication: packet.publication }
    if (
      current?.source === source.state &&
      view?.editable === (options.editable?.(source.state) ?? true) &&
      !content.model &&
      !current.content.surrounding &&
      !content.surrounding &&
      samePlacements(current.content, content)
    ) {
      current.stamp = stamp
      options.onPublished?.(packet)
      return 'applied'
    }
    const editing = readWindow(source.state, content)
    if (!editing || !paintSurrounding(content, editing, source.state)) {
      request('layout', source)
      return 'needs-range'
    }
    root.style.width = `${content.canvas.width}px`
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
    const { beforePaste, ...clipboard } = options.clipboard ?? {}
    const props = {
      ...clipboard,
      clipboardTextSerializer: (_slice: unknown, local: EditorView) => {
        const { doc, schema, selection } = local.state
        const textSerializers = getTextSerializersFromSchema(schema)
        return [...selection.ranges]
          .sort((a, b) => a.$from.pos - b.$from.pos)
          .map(({ $from, $to }) =>
            getTextBetween(doc, { from: $from.pos, to: $to.pos }, { textSerializers }),
          )
          .join('\n\n')
      },
      state,
      attributes,
      editable,
      decorations,
      nodeViews: options.nodeViews?.(source.state),
      handleKeyDown,
      handleDOMEvents: {
        ...(beforePaste ? { paste: beforePaste } : {}),
        focus: ownerFocusEvent('focus'),
        blur: ownerFocusEvent('blur'),
        mousedown: adoptParkedCaret,
        beforeinput: historyInput,
        compositionstart: startComposition,
        compositionend: finishComposition,
        copy: copySelection,
        cut: copySelection,
      },
      dispatchTransaction,
    }
    if (view) view.update(props)
    else view = new EditorView(root, props)
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

  const activeMap = () => {
    const source = options.readSource()
    return current?.editing.source === source.state.doc && !retired(current.stamp)
      ? current.editing
      : undefined
  }
  const hitTest = (point: { left: number; top: number }) => {
    const editing = activeMap()
    const hit = editing && view?.posAtCoords(point)
    if (!hit || !editing) return null
    const pos = editing.toSource(hit.pos)
    return pos === undefined ? null : { pos, inside: editing.toSource(hit.inside) ?? -1 }
  }
  const mappedView: Partial<EditorView> = {
    get dom() {
      return view?.dom ?? root
    },
    get root() {
      return view?.root ?? root.ownerDocument
    },
    get editable() {
      return view?.editable ?? false
    },
    get composing() {
      return view?.composing ?? false
    },
    focus: () => view?.focus(),
    hasFocus: () => view?.hasFocus() ?? false,
    posAtCoords: hitTest,
    coordsAtPos(position, side) {
      const local = activeMap()?.toLocal(position)
      if (local === undefined || !view)
        throw new RangeError('Document position is outside the mounted body')
      return view.coordsAtPos(local, side)
    },
    nodeDOM(position) {
      const local = activeMap()?.toLocal(position)
      return local === undefined ? null : (view?.nodeDOM(local) ?? null)
    },
    domAtPos(position, side) {
      const local = activeMap()?.toLocal(position)
      if (local === undefined || !view)
        throw new RangeError('Document position is outside the mounted body')
      return view.domAtPos(local, side)
    },
    posAtDOM(node, offset, bias) {
      const local = view?.posAtDOM(node, offset, bias)
      const position = local === undefined ? undefined : activeMap()?.toSource(local)
      if (position === undefined)
        throw new RangeError('DOM position does not belong to the mounted body')
      return position
    },
  }
  const releasePresentation =
    options.ownerEditor &&
    mountDocumentPresentation(options.ownerEditor, {
      get dom() {
        return view?.dom
      },
      editorView: mappedView,
      focus: () => view?.focus(),
      boundsAt(position) {
        const local = activeMap()?.toLocal(position)
        return local === undefined ? undefined : view?.coordsAtPos(local, 1)
      },
      hitTest,
      scrollTo(from, to) {
        const source = options.readSource()
        options.requestRange({
          reason: 'navigation',
          revision: source.revision,
          selection: source.state.selection,
          target: { from, to, align: 'node' },
        })
      },
      select(selection, centerCaret) {
        const source = options.readSource()
        if (selection.$from.doc !== source.state.doc) return
        const mounted = current
        options.dispatch(source.state.tr.setSelection(selection))
        const updated = options.readSource()
        if (disposed) return
        if (mounted && view && activeMap()) showConfirmed(mounted, updated, view.state.tr)
        options.requestRange({
          reason: 'navigation',
          revision: updated.revision,
          selection: updated.state.selection,
          target: {
            from: updated.state.selection.from,
            to: updated.state.selection.to,
            align: centerCaret ? 'caret' : 'node',
          },
        })
      },
    })

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
      if (disposed) return
      disposed = true
      releasePresentation?.()
      window.clearTimeout(compositionTimer)
      pendingHistory.length = 0
      deferred = undefined
      current = undefined
      view?.destroy()
      view = undefined
      surroundingView?.destroy()
      surroundingView = undefined
      root.remove()
      if (compositionSession) {
        const transaction = closeComposition(options.readSource())
        if (transaction) options.dispatch(transaction)
      }
    },
  }
}
