import { UndoRedo } from '@tiptap/extensions'
import { isHistoryTransaction, redo, redoDepth, undo, undoDepth } from '@tiptap/pm/history'
import type { EditorState, Transaction } from '@tiptap/pm/state'

function keepSelection(transaction: Transaction, state: EditorState) {
  transaction
    .setSelection(state.selection.getBookmark().resolve(transaction.doc))
    .setStoredMarks(state.storedMarks)
}

export function dispatchDocumentTransaction(
  transaction: Transaction,
  read: () => EditorState,
  next: (transaction: Transaction) => void,
): void {
  if (!isHistoryTransaction(transaction) || !transaction.doc.eq(transaction.before)) {
    next(transaction)
    return
  }

  // A cancelled composition can leave a history event with no net document change.
  // Consume it through the existing dispatch path and keep the user's selection.
  const before = read()
  keepSelection(transaction, before)
  next(transaction)

  let state = read()
  if (!state.doc.eq(before.doc)) return
  const action =
    undoDepth(state) < undoDepth(before)
      ? { command: undo, depth: undoDepth }
      : redoDepth(state) < redoDepth(before)
        ? { command: redo, depth: redoDepth }
        : null
  if (!action) return

  for (let remaining = action.depth(state); remaining > 0; remaining = action.depth(state)) {
    action.command(state, (step) => {
      if (step.doc.eq(state.doc)) keepSelection(step, state)
      next(step)
    })
    const updated = read()
    if (!updated.doc.eq(state.doc) || action.depth(updated) >= remaining) break
    state = updated
  }
}

export const DocumentUndoRedo = UndoRedo.extend({
  dispatchTransaction({ transaction, next }) {
    dispatchDocumentTransaction(transaction, () => this.editor.state, next)
  },
})
