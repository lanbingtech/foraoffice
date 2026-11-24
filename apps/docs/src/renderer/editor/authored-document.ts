import type { Editor } from '@tiptap/core'
import { Fragment, type Node, type Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, type PluginSpec, type Transaction } from '@tiptap/pm/state'
import type { PmNode } from './convert'
import { dispatchDocumentTransaction } from './undo-redo'

const presentation = new WeakSet<Plugin>()

/** View and layout state can be reconstructed from an authored document. */
export function presentationPlugin<T>(
  spec: PluginSpec<T> & { filterTransaction?: never; appendTransaction?: never },
): Plugin<T> {
  return markPresentationPlugin(new Plugin(spec))
}

export function markPresentationPlugin<T>(plugin: Plugin<T>): Plugin<T> {
  if (!plugin.spec.filterTransaction && !plugin.spec.appendTransaction) presentation.add(plugin)
  return plugin
}

export const LAYOUT_REPLAY = 'docsLayoutReplay'
export const CLEAR_DOCUMENT_PLUGIN = 'clearDocument'

/** Keep replica view state while accepting the source's authoring decisions. */
export function layoutReplicaPlugins(plugins: readonly Plugin[]): Plugin[] {
  return plugins.map((plugin) => {
    const { filterTransaction, appendTransaction } = plugin.spec
    if (!filterTransaction && !appendTransaction) return plugin
    return new Plugin({
      ...plugin.spec,
      filterTransaction:
        filterTransaction &&
        ((transaction, state) =>
          transaction.getMeta(LAYOUT_REPLAY) === true ||
          filterTransaction.call(plugin, transaction, state)),
      appendTransaction:
        appendTransaction &&
        ((transactions, oldState, newState) =>
          transactions.some((transaction) => transaction.getMeta(LAYOUT_REPLAY))
            ? null
            : appendTransaction.call(plugin, transactions, oldState, newState)),
    })
  })
}

/** Owns the accepted editor state without constructing a full document view. */
export class AuthoredDocument {
  private currentRevision = 0
  private closed = false

  constructor(
    private readonly editor: Editor,
    doc: Node,
    private readonly publish: (transactions: readonly Transaction[]) => void,
  ) {
    const plugins = editor.extensionManager.plugins.filter((plugin) => {
      // Match the native editor's unregisterPlugin call for this core plugin.
      const key: unknown = Reflect.get(plugin, 'key')
      return (
        !presentation.has(plugin) &&
        !(typeof key === 'string' && key.startsWith(`${CLEAR_DOCUMENT_PLUGIN}$`))
      )
    })
    editor.view.updateState(EditorState.create({ doc, plugins }))
  }

  read() {
    return { state: this.editor.state, revision: this.currentRevision }
  }

  dispatch(transaction: Transaction): readonly Transaction[] {
    if (this.closed) return []
    const transactions: Transaction[] = []
    dispatchDocumentTransaction(
      transaction,
      () => this.editor.state,
      (next) => {
        const applied = this.editor.state.applyTransaction(next)
        this.editor.view.updateState(applied.state)
        for (const accepted of applied.transactions) transactions.push(accepted)
      },
    )
    if (transactions.some((accepted) => accepted.steps.length > 0)) this.currentRevision++
    this.publish(transactions)
    return transactions
  }

  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.editor.destroy()
  }
}

export async function readImportedBody(
  root: Omit<PmNode, 'content'>,
  blocks: ReadableStream<PmNode[]>,
  schema: Schema,
  signal: AbortSignal,
): Promise<Node> {
  if (root.type !== schema.topNodeType.name) throw new Error('Invalid imported document root')
  const content: Node[] = []
  await blocks.pipeTo(
    new WritableStream({
      write(chunk) {
        for (const block of chunk) content.push(schema.nodeFromJSON(block))
      },
    }),
    { signal },
  )
  return schema.topNodeType.createChecked(root.attrs, Fragment.fromArray(content))
}
