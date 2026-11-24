import type { Node as PmNode } from '@tiptap/pm/model'
import { AllSelection, type EditorState, type Selection, type Transaction } from '@tiptap/pm/state'
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  Mapping,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  StepMap,
  type Step,
} from '@tiptap/pm/transform'

interface ModelRange {
  readonly from: number
  readonly to: number
}

export interface ViewportModelBlock extends ModelRange {
  readonly pictures?: readonly ModelRange[]
}

export interface EditingViewport {
  readonly source: PmNode
  readonly doc: PmNode
  readonly sourceRange: ModelRange
  readonly localRange: ModelRange
  toSource(position: number): number | undefined
  toLocal(position: number): number | undefined
}

function pictureRange(block: ViewportModelBlock, paragraph: PmNode): ModelRange | undefined {
  const { pictures } = block
  if (!pictures?.length || paragraph.type.name !== 'docParagraph') return
  let selected = 0
  let position = block.from + 1
  for (let index = 0; index < paragraph.childCount; index++) {
    const child = paragraph.child(index)
    if (child.type.name !== 'docInlineImage' || child.attrs.wrap || child.attrs.rule) return
    const next = position + child.nodeSize
    const picture = pictures[selected]
    if (picture?.from === position) {
      if (picture.to !== next || (selected > 0 && position !== pictures[selected - 1].to)) return
      selected++
    }
    position = next
  }
  if (selected === pictures.length) return { from: pictures[0].from, to: pictures[selected - 1].to }
}

/** The represented range is contiguous. A clipped paragraph can contribute
 * its visible pictures at either outer edge; a missing interior cannot. */
export function createViewportEditing(
  source: PmNode,
  blocks: readonly ViewportModelBlock[],
): EditingViewport | undefined {
  const first = blocks[0]?.from
  if (first === undefined || !Number.isInteger(first) || first < 0 || first >= source.content.size)
    return
  const start = source.resolve(first)
  if (start.depth !== 0) return
  let position = first
  let from = first
  let to = first
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    const node = source.maybeChild(start.index() + index)
    if (!node || block.from !== position || block.to !== position + node.nodeSize) return
    position = block.to
    to = position
    if (!block.pictures) continue
    const pictures = pictureRange(block, node)
    if (!pictures) return
    if (pictures.from > block.from + 1) {
      if (index !== 0) return
      from = pictures.from
    }
    if (pictures.to < block.to - 1) {
      if (index !== blocks.length - 1) return
      to = pictures.to
    }
  }
  const slice = source.slice(from, to, true)
  if (!source.type.validContent(slice.content)) return
  const doc = source.copy(slice.content)
  const sourceRange = { from, to }
  const localRange = { from: slice.openStart, to: doc.content.size - slice.openEnd }
  const offset = from - localRange.from
  return {
    source,
    doc,
    sourceRange,
    localRange,
    toSource: (position) => (contains(localRange, position) ? position + offset : undefined),
    toLocal: (position) => (contains(sourceRange, position) ? position - offset : undefined),
  }
}

const contains = (range: ModelRange, position: number) =>
  Number.isInteger(position) && position >= range.from && position <= range.to

function affectedRange(step: Step, doc: PmNode): ModelRange | undefined {
  if (
    step instanceof ReplaceStep ||
    step instanceof ReplaceAroundStep ||
    step instanceof AddMarkStep ||
    step instanceof RemoveMarkStep
  ) {
    return step
  }
  if (
    step instanceof AttrStep ||
    step instanceof AddNodeMarkStep ||
    step instanceof RemoveNodeMarkStep
  ) {
    const node = doc.nodeAt(step.pos)
    if (node) return { from: step.pos, to: step.pos + node.nodeSize }
  }
}

function preservesClippedParagraph(step: ReplaceStep | ReplaceAroundStep, doc: PmNode): boolean {
  if (!(step instanceof ReplaceStep) || step.slice.openStart || step.slice.openEnd) return false
  const start = doc.resolve(step.from)
  if (!start.parent.inlineContent || !start.sameParent(doc.resolve(step.to))) return false
  let inline = true
  step.slice.content.forEach((node) => {
    if (!node.isInline) inline = false
  })
  return inline
}

/** Replay supported steps only against the exact source revision the window
 * represents. The caller owns dispatch, history, and publishing the next window. */
export function projectViewportTransaction(
  viewport: EditingViewport,
  authoritative: EditorState,
  local: Transaction,
  initialSelection?: Selection,
): Transaction | undefined {
  if (authoritative.doc !== viewport.source || local.before !== viewport.doc) return
  if (!local.docChanged && !local.selectionSet && !local.storedMarksSet) return

  const selectedAll = authoritative.selection instanceof AllSelection
  const locallySelectedAll = initialSelection instanceof AllSelection
  if (local.docChanged && selectedAll !== locallySelectedAll) return
  if (local.docChanged && selectedAll) {
    const step = local.steps[0]
    // The visible AllSelection represents the owner's entire document. A
    // whole-window replacement must use the same scope, even off screen.
    if (
      local.steps.length !== 1 ||
      !(step instanceof ReplaceStep) ||
      step.toJSON().structure === true ||
      step.from !== 0 ||
      step.to !== local.before.content.size
    )
      return
    const result = authoritative.tr.setTime(local.time)
    const replacing = new ReplaceStep(0, authoritative.doc.content.size, step.slice)
    if (result.maybeStep(replacing).failed || !result.doc.eq(local.doc)) return
    result.setSelection(local.selection.map(result.doc, new Mapping()))
    return finishViewportTransaction(result, local)
  }

  const localStart = viewport.localRange.from
  const clippedEnd = viewport.doc.content.size - viewport.localRange.to
  const offset = viewport.sourceRange.from - localStart
  const mapping = new Mapping([StepMap.offset(offset)])
  const result = authoritative.tr.setTime(local.time)
  for (let index = 0; index < local.steps.length; index++) {
    const step = local.steps[index]
    const before = local.docs[index]
    const range = affectedRange(step, before)
    const size = before.content.size
    if (!range || range.from < localStart || range.to > size - clippedEnd) return
    if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
      if (range.from === 0 && offset > 0) return
      if (range.to === size && offset + size < result.doc.content.size) return
      const reachesClippedParagraph =
        (localStart > 0 && range.from < before.firstChild!.nodeSize) ||
        (clippedEnd > 0 && range.to > size - before.lastChild!.nodeSize)
      if (reachesClippedParagraph && !preservesClippedParagraph(step, before)) return
    }
    const mapped = step.map(mapping)
    if (!mapped || result.maybeStep(mapped).failed) return
  }

  const localEnd = local.doc.content.size - clippedEnd
  const representedFrom = viewport.sourceRange.from
  const representedTo = localEnd + offset
  if (representedTo > result.doc.content.size) return
  if (
    local.docChanged &&
    !result.doc.slice(representedFrom, representedTo, true).content.eq(local.doc.content)
  )
    return

  const selection = local.selection
  if (
    selection instanceof AllSelection &&
    (representedFrom !== 0 || representedTo !== result.doc.content.size)
  )
    return
  const represented = { from: localStart, to: localEnd }
  if (!contains(represented, selection.anchor) || !contains(represented, selection.head)) return
  if (selection.ranges.some(({ $from, $to }) => $from.pos < localStart || $to.pos > localEnd))
    return
  const mappedSelection = selection.map(result.doc, mapping)
  if (
    mappedSelection.anchor !== selection.anchor + offset ||
    mappedSelection.head !== selection.head + offset ||
    mappedSelection.constructor !== selection.constructor
  )
    return
  result.setSelection(mappedSelection)
  return finishViewportTransaction(result, local)
}

function finishViewportTransaction(result: Transaction, local: Transaction): Transaction {
  if (local.storedMarksSet) result.setStoredMarks(local.storedMarks)
  const addToHistory = local.getMeta('addToHistory')
  if (typeof addToHistory === 'boolean') result.setMeta('addToHistory', addToHistory)
  const composition = local.getMeta('composition')
  if (Number.isInteger(composition)) result.setMeta('composition', composition)
  const uiEvent = local.getMeta('uiEvent')
  if (uiEvent === 'paste' || uiEvent === 'cut' || uiEvent === 'drop')
    result.setMeta('uiEvent', uiEvent)
  if (local.getMeta('pointer') === true) result.setMeta('pointer', true)
  return result
}
