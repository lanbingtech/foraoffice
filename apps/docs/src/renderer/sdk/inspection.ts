import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import {
  applyFindReplacement,
  compileFind,
  findInDoc,
  type FindMatch,
  type FindOptions,
} from '../editor/find'

export interface DocsTextReference {
  documentId: string
  revision: number
  from: number
  to: number
}
export interface DocsFindResult extends DocsTextReference {
  query: string
  options: FindOptions
  matches: Array<FindMatch & DocsTextReference>
}
export interface DocsTextSnapshot {
  documentId: string
  revision: number
  text: string
  /** Character offsets in text mapped to editor positions; paragraph separators map to null. */
  positions: Array<number | null>
  blocks: Array<{ text: string; from: number; to: number }>
}
export interface DocsInspection {
  snapshot(): DocsTextSnapshot
  find(query: string, options?: Partial<FindOptions>): DocsFindResult
  locate(reference: DocsTextReference, options?: { focus?: boolean }): void
  replace(result: DocsFindResult, replacement: string, index?: number): number
  dispose(): void
}
export type DocsCurrentEditor = () => { editor: Editor; identity: object } | null

/** Current-document inspection. Returned references deliberately expire on any content transaction. */
export function createDocsInspection(current: DocsCurrentEditor): DocsInspection {
  let disposed = false
  let identity: object | undefined
  let editor: Editor | undefined
  let documentId = ''
  let revision = 0
  const changed = ({ transaction }: { transaction: Transaction }) => {
    if (transaction.docChanged) revision++
  }
  const sync = () => {
    if (disposed) throw new Error('The document inspection API is disposed')
    const next = current()
    if (!next || next.editor.isDestroyed) throw new Error('The document is not ready')
    if (identity !== next.identity || editor !== next.editor) {
      editor?.off('transaction', changed)
      identity = next.identity
      editor = next.editor
      editor.on('transaction', changed)
      documentId = crypto.randomUUID()
      revision = 0
    }
    return next.editor
  }
  const validate = (reference: DocsTextReference) => {
    const live = sync()
    if (reference.documentId !== documentId || reference.revision !== revision)
      throw new Error('Stale document reference; search the current document again')
    if (
      !Number.isSafeInteger(reference.from) ||
      !Number.isSafeInteger(reference.to) ||
      reference.from < 0 ||
      reference.to < reference.from ||
      reference.to > live.state.doc.content.size
    )
      throw new Error('Invalid document range')
    return live
  }
  const find: DocsInspection['find'] = (query, options = {}) => {
    const live = sync()
    const settings: FindOptions = { matchCase: false, wholeWord: false, ...options }
    if (!['literal', 'wildcard', 'regex'].includes(settings.mode ?? 'literal'))
      throw new Error('Invalid find mode')
    const compiled = compileFind(query, settings)
    if (!compiled.ok) throw new Error(`Invalid search: ${compiled.error}`)
    return {
      documentId,
      revision,
      query,
      options: settings,
      from: 0,
      to: live.state.doc.content.size,
      matches: findInDoc(live.state.doc, compiled.query, settings).map((match) => ({
        ...match,
        documentId,
        revision,
      })),
    }
  }
  return {
    snapshot() {
      const live = sync()
      const blocks: DocsTextSnapshot['blocks'] = []
      const positions: DocsTextSnapshot['positions'] = []
      let text = ''
      live.state.doc.descendants((node, position) => {
        if (!node.isTextblock) return true
        if (blocks.length) {
          text += '\n'
          positions.push(null)
        }
        let blockText = ''
        node.forEach((child, offset) => {
          const value = child.isText
            ? child.text!
            : child.type.name === 'hardBreak'
              ? '\n'
              : '\u0000'
          for (let index = 0; index < value.length; index++)
            positions.push(position + 1 + offset + index)
          blockText += value
        })
        blocks.push({ text: blockText, from: position + 1, to: position + node.nodeSize - 1 })
        text += blockText
        return false
      })
      return { documentId, revision, text, positions, blocks }
    },
    find,
    locate(reference, options) {
      const live = validate(reference)
      const selection = TextSelection.create(live.state.doc, reference.from, reference.to)
      live.view.dispatch(
        live.state.tr.setSelection(selection).scrollIntoView().setMeta('addToHistory', false),
      )
      if (options?.focus) live.view.focus()
    },
    replace(result, replacement, index) {
      const live = validate(result)
      if (!live.isEditable) throw new Error('The document is read-only')
      // Rescan the trusted document rather than accepting caller-modified match/capture data.
      const matches = find(result.query, result.options).matches
      if (
        index !== undefined &&
        (!Number.isSafeInteger(index) || index < 0 || index >= matches.length)
      )
        throw new Error('Invalid match index')
      const selected = index === undefined ? matches : [matches[index]]
      if (!selected.length) return 0
      live.commands.command(({ tr }) => {
        for (const match of [...selected].reverse())
          applyFindReplacement(tr, match, replacement, result.options.mode ?? 'literal')
        return true
      })
      return selected.length
    },
    dispose() {
      disposed = true
      editor?.off('transaction', changed)
    },
  }
}
