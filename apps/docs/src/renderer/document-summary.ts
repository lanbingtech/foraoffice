import { Fragment, type Node as PmNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { collectRevisions, type RevisionRange } from './editor/revisions'
import { collectTextboxRevisions, type StoryRevision } from './editor/story-revisions'
import { appendedStreamedTail } from './editor/streaming-tail-guard'
import { countWords, documentTextForWordCount } from './word-count'

interface DocumentSummary {
  doc: PmNode
  words: number
  revisions: RevisionRange[]
  textboxes: StoryRevision[]
}

/** Live status follows the mounted model. Whole-block appends keep every
 * previous revision position and the word boundary between blocks. */
export function createDocumentSummary(readRevisions: boolean) {
  let measured: DocumentSummary | undefined
  let observed: PmNode | undefined
  let pending: Fragment | null = Fragment.empty

  return {
    observe(transaction: Transaction, doc: PmNode): void {
      const tail = appendedStreamedTail(transaction)
      pending =
        pending && tail && transaction.before === observed && transaction.doc === doc
          ? pending.append(tail.content)
          : null
      observed = doc
    },
    read(doc: PmNode): DocumentSummary {
      if (measured?.doc === doc) return measured
      const prefix = observed === doc && pending?.size ? measured : undefined
      const content = prefix && pending ? doc.copy(pending) : doc
      const words = countWords(documentTextForWordCount(content))
      const changes = readRevisions ? collectRevisions(content) : []
      const offset = prefix?.doc.content.size ?? 0
      const textboxes = readRevisions ? collectTextboxRevisions(content, offset) : []
      measured = {
        doc,
        words: (prefix?.words ?? 0) + words,
        revisions: prefix
          ? changes.length
            ? prefix.revisions.concat(
                changes.map((r) => ({ ...r, from: r.from + offset, to: r.to + offset })),
              )
            : prefix.revisions
          : changes,
        textboxes: prefix
          ? textboxes.length
            ? prefix.textboxes.concat(textboxes)
            : prefix.textboxes
          : textboxes,
      }
      observed = doc
      pending = Fragment.empty
      return measured
    },
  }
}
