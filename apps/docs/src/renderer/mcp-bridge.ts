import { getOptionalDocsHost } from './host/docs-host'
import type { McpCommandMessage } from '../shared/ipc'
import type { FileActionContext } from './file-actions'
import type { DocsRuntime } from './runtime/docs-runtime'
import { createDocsCommandRouter } from './runtime/command-router'
import { DocsOperationError } from '../shared/operation-result'

export interface McpBridgeDeps {
  getCtx(): FileActionContext
  getRuntime(): DocsRuntime
  router?: ReturnType<typeof createDocsCommandRouter>
}

const READY_POLL_MS = 50
const READY_SLOW_POLL_MS = 1_000
const READY_FAST_WINDOW_MS = 20_000

/** Wait until opening has finished, so a blank reset cannot erase an early edit. */
async function announceWhenLoaded(
  deps: McpBridgeDeps,
  signal: () => void,
  isCancelled: () => boolean,
): Promise<void> {
  const startedAt = Date.now()
  while (!isCancelled()) {
    const ctx = deps.getCtx()
    if (ctx?.editor && ctx.doc) {
      signal()
      return
    }
    const slow = Date.now() - startedAt > READY_FAST_WINDOW_MS
    await new Promise((resolve) => setTimeout(resolve, slow ? READY_SLOW_POLL_MS : READY_POLL_MS))
  }
}

/** Electron transports commands; the shared runtime owns editing and persistence. */
export function installMcpBridge(deps: McpBridgeDeps): () => void {
  const desktop = getOptionalDocsHost()
  if (!desktop?.onMcpCommand || !desktop.reportMcpResult) return () => {}
  let cancelled = false
  const router = deps.router ?? createDocsCommandRouter(deps.getRuntime())
  const lifetime = new AbortController()
  const unsubscribe = desktop.onMcpCommand((message: McpCommandMessage) => {
    if (!message || typeof message.requestId !== 'string' || cancelled) return
    void router.handle(message, lifetime.signal).then(
      (result) => desktop.reportMcpResult({ requestId: message.requestId, ok: true, result }),
      (error: unknown) =>
        desktop.reportMcpResult({
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof DocsOperationError ? { result: error.result } : {}),
        }),
    )
  })
  void announceWhenLoaded(
    deps,
    () => desktop.signalMcpReady?.(),
    () => cancelled,
  )
  return () => {
    cancelled = true
    unsubscribe()
    lifetime.abort()
    if (!deps.router) router.dispose()
  }
}
