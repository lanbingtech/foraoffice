import { UndoRedo } from '@tiptap/extensions'
import { isHistoryTransaction, redo, redoDepth, undo, undoDepth } from '@tiptap/pm/history'
import type { EditorState, Transaction } from '@tiptap/pm/state'

function keepSelection(transaction: Transaction, state: EditorState) {
  transaction
    .setSelection(state.selection.getBookmark().resolve(transaction.doc))
    .setStoredMarks(state.storedMarks)
}

export const DocumentUndoRedo = UndoRedo.extend({
  dispatchTransaction({ transaction, next }) {
    if (!isHistoryTransaction(transaction) || !transaction.doc.eq(transaction.before)) {
      next(transaction)
      return
    }

    // A cancelled composition can leave a history event with no net document change.
    // Consume it through the existing dispatch path and keep the user's selection.
    const before = this.editor.state
    keepSelection(transaction, before)
    next(transaction)

    let state = this.editor.state
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
      const updated = this.editor.state
      if (!updated.doc.eq(state.doc) || action.depth(updated) >= remaining) break
      state = updated
    }
  },
})
