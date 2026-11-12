import type {
  DocsEditorAction,
  DocsHarnessAdapter,
  DocsAiOperation,
  DocsAiInstructionRequest,
} from '../../shared/editor-action'
import type { DocsRuntime, RuntimeDocument } from './docs-runtime'
import type { DocsCommands } from './command-router'

export interface DocsActionBindings {
  runtime: DocsRuntime
  commands: DocsCommands
  current(): RuntimeDocument | null
  harness(): DocsHarnessAdapter | undefined
}

function resolveOrAbort(
  resolve: () => ReturnType<NonNullable<DocsHarnessAdapter['resolveInstruction']>>,
  signal: AbortSignal,
): Promise<string | null | undefined> {
  signal.throwIfAborted()
  return new Promise((accept, reject) => {
    const canceled = () => {
      signal.removeEventListener('abort', canceled)
      reject(signal.reason)
    }
    signal.addEventListener('abort', canceled, { once: true })
    const complete = (value: string | null | undefined) => {
      signal.removeEventListener('abort', canceled)
      accept(value)
    }
    const failed = (error: unknown) => {
      signal.removeEventListener('abort', canceled)
      reject(error)
    }
    try {
      Promise.resolve(resolve()).then(complete, failed)
    } catch (error) {
      failed(error)
    }
  })
}

/** The shared external-action boundary for editor entry points. */
export async function submitDocsEditorAction(
  bindings: DocsActionBindings,
  kind: DocsEditorAction['kind'],
  instruction: string,
  operation?: DocsAiOperation,
): Promise<void> {
  const harness = bindings.harness()
  if (!harness) throw new Error('No external Harness conversation is bound to this editor')
  const document = bindings.current()
  if (!document || document.editor.isDestroyed) throw new Error('The document is not open')
  const originalDoc = document.editor.state.doc
  const scope = bindings.runtime.capture()
  const bindingId = crypto.randomUUID()
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, scope.signal])
  const cancel = () =>
    lifetime.abort(new DOMException('The editor action was canceled', 'AbortError'))
  try {
    bindings.commands.bindScope(bindingId, scope, cancel)
  } catch (error) {
    scope.close()
    throw error
  }
  const binding = {
    id: crypto.randomUUID(),
    bindingId,
    documentId: scope.documentId,
    context: scope.text,
  }
  const metadata = operation
    ? (Object.freeze({
        ...operation,
        parameters: Object.freeze({ ...operation.parameters }),
      }) as DocsAiOperation)
    : undefined
  const edited = () => {
    if (document.editor.state.doc !== originalDoc) cancel()
  }
  let observing = false
  const stopObserving = () => {
    if (!observing) return
    document.editor.off('transaction', edited)
    document.editor.off('destroy', cancel)
    observing = false
  }
  try {
    if (metadata && harness.resolveInstruction) {
      const request: DocsAiInstructionRequest = Object.freeze({
        ...binding,
        ...metadata,
        defaultInstruction: instruction,
      })
      document.editor.on('transaction', edited)
      document.editor.on('destroy', cancel)
      observing = true
      const resolved = await resolveOrAbort(
        () => harness.resolveInstruction!(request, signal),
        signal,
      )
      if (resolved != null && typeof resolved !== 'string')
        throw new Error('The instruction resolver must return text, null or undefined')
      if (resolved?.trim()) instruction = resolved
    }
    stopObserving()
    signal.throwIfAborted()
    const current = bindings.current()
    if (
      !current ||
      current.identity !== document.identity ||
      current.editor !== document.editor ||
      current.editor.isDestroyed ||
      current.editor.state.doc !== originalDoc ||
      current.stateVersion !== document.stateVersion ||
      bindings.harness() !== harness
    )
      throw new Error('The editor action target or authority changed during instruction resolution')
    await harness.submit({ ...binding, ...metadata, kind, instruction })
  } catch (error) {
    bindings.commands.releaseScope(bindingId)
    throw error
  } finally {
    stopObserving()
  }
}
