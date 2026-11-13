import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { DraftLanding, DOC_MAX_CHARS, type WritePosition } from './draft-landing'
import {
  insertBlocksAfter,
  isBlankDocument,
  parseHtmlFragment,
  readOnlyHtmlError,
  replaceBlockRange,
  resolveImageRefs,
  type AiTrack,
  type NumIds,
} from '../ai/protocol'
import type { DocsErrorCode } from '../../shared/operation-result'

export type DraftState =
  'streaming' | 'awaiting_decision' | 'committed' | 'retained' | 'discarded' | 'failed'
export type DraftSettlement =
  | { ok: true; blocks: number; partial: boolean }
  | { ok: false; error: string; errorCode?: DocsErrorCode }

export function draftPosition(editor: Editor, input: Record<string, unknown>): WritePosition {
  if (input.afterBlockIndex !== undefined && input.afterBlockIndex !== null) {
    const index = input.afterBlockIndex
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < -1 ||
      index >= editor.state.doc.childCount
    )
      throw new Error(`afterBlockIndex must be -1..${editor.state.doc.childCount - 1}`)
    return { kind: 'after', index }
  }
  if (isBlankDocument(editor) || input.replaceDocument === true) return { kind: 'whole' }
  throw new Error(
    'The document is not blank: supply afterBlockIndex or explicitly request replaceDocument',
  )
}

/** Shared draft ownership and landing; inference and the keep/discard decision belong to the caller. */
export class DocumentDraft {
  private readonly landing: DraftLanding
  private readonly original: ProseMirrorNode
  private readonly originallyBlank: boolean
  private html = ''
  private sequence = 0
  private state: DraftState = 'streaming'
  private settlement?: DraftSettlement

  constructor(
    private readonly editor: Editor,
    private readonly numIds: NumIds,
    private readonly position: WritePosition,
    private readonly valid: () => boolean = () => !editor.isDestroyed,
    private readonly currentTrack?: () => AiTrack | undefined,
  ) {
    this.original = editor.state.doc
    this.originallyBlank = isBlankDocument(editor)
    this.landing = new DraftLanding(editor, numIds, position)
  }

  get pending(): boolean {
    return this.state === 'streaming' || this.state === 'awaiting_decision'
  }

  inspect() {
    return {
      state: this.state,
      sequence: this.sequence,
      characters: this.html.length,
      conflicted: this.landing.hasConflict,
      ...(this.settlement ? { result: this.settlement } : {}),
    }
  }

  update(sequence: number, html: string): void {
    if (!this.pending || this.state !== 'streaming' || !this.valid())
      throw new Error('The draft is no longer streaming')
    if (!Number.isInteger(sequence) || sequence < 1 || sequence < this.sequence)
      throw new Error('Draft updates must use increasing positive sequence numbers')
    if (html.length > DOC_MAX_CHARS)
      throw new Error(`The draft exceeds ${DOC_MAX_CHARS} characters`)
    const readOnly = readOnlyHtmlError(html)
    if (readOnly) throw new Error(readOnly)
    if (sequence === this.sequence) {
      if (html !== this.html) throw new Error('A replayed draft update has different content')
      return
    }
    this.sequence = sequence
    this.html = html
    this.landing.update(html)
  }

  stop(): void {
    if (this.state === 'streaming') this.state = 'awaiting_decision'
  }

  discard(): void {
    if (!this.pending) return
    this.landing.finish(this.valid())
    this.state = 'discarded'
  }

  finish(partial: boolean, track?: AiTrack): DraftSettlement {
    if (this.settlement) return this.settlement
    if (!this.pending || !this.valid()) {
      this.discard()
      return { ok: false, error: 'The draft binding is no longer valid' }
    }
    const rendered = this.landing.finish()
    const fail = (error: string, errorCode: DocsErrorCode = 'invalid_input'): DraftSettlement => {
      this.state = 'failed'
      this.settlement = { ok: false, error, errorCode }
      return this.settlement
    }
    if (!this.editor.isEditable)
      return fail(
        'The document became read-only; the draft was not committed.',
        'permission_denied',
      )
    if (this.landing.hasConflict)
      return fail(
        'The draft was edited manually; those edits were kept and automatic finalization was refused',
      )
    if (!this.html.trim()) return fail('The draft is empty; the document is unchanged')
    const readOnly = readOnlyHtmlError(this.html)
    if (readOnly) return fail(readOnly)
    let nodes: ReturnType<typeof parseHtmlFragment>
    try {
      nodes = parseHtmlFragment(this.html, this.numIds)
    } catch (error) {
      if (!partial || !rendered) return fail(error instanceof Error ? error.message : String(error))
      try {
        nodes = parseHtmlFragment(rendered, this.numIds)
      } catch (fallbackError) {
        return fail(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
      }
    }
    nodes = resolveImageRefs(this.editor, nodes).nodes
    if (!nodes.length) return fail('The draft did not parse into any content blocks')
    const changed = !this.editor.state.doc.eq(this.original)
    if (this.position.kind === 'whole' && changed && !this.originallyBlank)
      return fail('The document changed during the draft; the whole-document rewrite was refused')
    this.editor.view.dispatch(closeHistory(this.editor.state.tr))
    const effectiveTrack = this.currentTrack ? this.currentTrack() : track
    if (this.position.kind === 'whole' && !changed)
      replaceBlockRange(this.editor, 0, this.editor.state.doc.childCount - 1, nodes, effectiveTrack)
    else insertBlocksAfter(this.editor, this.landing.indexBefore(), nodes, effectiveTrack)
    this.editor.view.dispatch(closeHistory(this.editor.state.tr))
    this.state = partial ? 'retained' : 'committed'
    this.settlement = { ok: true, blocks: nodes.length, partial }
    return this.settlement
  }
}
