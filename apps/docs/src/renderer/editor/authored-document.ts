import { Editor, type EditorEvents, type Extensions } from '@tiptap/core'
import { Fragment, type Node, type Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, type PluginSpec, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { PmNode } from './convert'
import { mountedDocumentPresentation } from './document-presentation'
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

/** Keep the native Tiptap command and event APIs on the unmounted document owner. */
export class AuthoredEditor extends Editor {
  dispatchAuthored?: (transaction: Transaction) => void
  acceptAuthored?: (event: EditorEvents['transaction']) => void
  private disposed = false
  private observingUncommittedState = false

  constructor(extensions: Extensions) {
    super({ extensions, element: null })
  }

  override get isDestroyed(): boolean {
    return this.disposed
  }

  override destroy(): void {
    this.disposed = true
    this.dispatchAuthored = undefined
    this.acceptAuthored = undefined
    super.destroy()
  }

  override get view(): EditorView {
    const view = super.view
    const dispatch = this.dispatchAuthored
    if (!dispatch && !this.disposed) return view
    return new Proxy(view, {
      get: (target, key, receiver) => {
        if (key === 'isDestroyed') return this.isDestroyed
        if (key === 'dispatch' && dispatch) return dispatch
        if (key === 'updateState' && this.disposed) return () => {}
        const presentation = mountedDocumentPresentation(this)?.editorView
        if (presentation && Reflect.has(presentation, key)) return Reflect.get(presentation, key)
        return Reflect.get(target, key, receiver)
      },
    })
  }

  applyAuthored(transaction: Transaction): void {
    if (this.observingUncommittedState)
      throw new Error('Dispatch from transaction after acceptance, not beforeTransaction')
    super.view.dispatch(transaction)
  }

  override emit<K extends keyof EditorEvents>(
    event: K,
    ...args: EditorEvents[K] extends any[] ? EditorEvents[K] : [EditorEvents[K]]
  ): this {
    // Record the accepted chain before other listeners can dispatch a follow-up.
    if (event === 'transaction') this.acceptAuthored?.(args[0] as EditorEvents['transaction'])
    if (event !== 'beforeTransaction') return super.emit(event, ...args)
    this.observingUncommittedState = true
    try {
      return super.emit(event, ...args)
    } finally {
      this.observingUncommittedState = false
    }
  }
}

/** Owns the accepted editor state without constructing a full document view. */
export class AuthoredDocument {
  private currentRevision = 0
  private accepting?: { transactions: Transaction[]; advanced: boolean }

  constructor(
    private readonly editor: AuthoredEditor,
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
    editor.dispatchAuthored = (transaction) => this.dispatch(transaction)
    editor.acceptAuthored = this.onTransaction
  }

  read() {
    return { state: this.editor.state, revision: this.currentRevision }
  }

  dispatch(transaction: Transaction): readonly Transaction[] {
    if (this.editor.isDestroyed) return []
    const parent = this.accepting
    const batch = parent ?? { transactions: [], advanced: false }
    const start = batch.transactions.length
    this.accepting = batch
    try {
      dispatchDocumentTransaction(
        transaction,
        () => this.editor.state,
        (next) => this.editor.applyAuthored(next),
      )
    } finally {
      this.accepting = parent
      if (!parent && batch.transactions.length > 0) this.publish(batch.transactions)
    }
    return batch.transactions.slice(start)
  }

  private onTransaction = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
    const batch = this.accepting
    if (!batch) return
    const accepted = [transaction, ...appendedTransactions]
    batch.transactions.push(...accepted)
    if (!batch.advanced && accepted.some((transaction) => transaction.steps.length > 0)) {
      batch.advanced = true
      this.currentRevision++
    }
  }

  destroy(): void {
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
