import { expect, it, vi } from 'vitest'
import { createQtDocsHost, type DocsQtChannel, type QtSignal } from '../src/renderer/host/qt'

function signal<Args extends unknown[]>(): QtSignal<Args> & { emit(...args: Args): void } {
  const listeners = new Set<(...args: Args) => void>()
  return {
    connect: (listener) => {
      listeners.add(listener)
    },
    disconnect: (listener) => {
      listeners.delete(listener)
    },
    emit: (...args) => {
      for (const listener of listeners) listener(...args)
    },
  }
}

it('uses native Qt RPC for file bytes and events, without an Electron global or model service', async () => {
  const reply = signal<[string]>()
  const event = signal<[string, string]>()
  const command = signal<[string]>()
  const request = vi.fn()
  const channel: DocsQtChannel = { request, complete: vi.fn(), reply, event, command }
  const adapter = createQtDocsHost(channel)
  const saved = adapter.host.services.saveDocxTo(
    '/granted/new.docx',
    Uint8Array.from([80, 75, 3, 4]).buffer,
    false,
    null,
  )
  const message = JSON.parse(request.mock.calls[0][0])
  expect(message).toMatchObject({
    jsonrpc: '2.0',
    method: 'services.call',
    params: {
      method: 'saveDocxTo',
      args: ['/granted/new.docx', { base64: 'UEsDBA==' }, false, null],
    },
  })
  reply.emit(
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { ok: true, committed: true, path: '/granted/new.docx' },
    }),
  )
  expect(await saved).toMatchObject({ ok: true, committed: true })
  const theme = vi.fn()
  const off = adapter.host.services.onThemeChanged(theme)
  event.emit('onThemeChanged', JSON.stringify(['dark']))
  expect(theme).toHaveBeenCalledWith('dark')
  off()
  event.emit('onThemeChanged', JSON.stringify(['light']))
  expect(theme).toHaveBeenCalledTimes(1)
  expect(() => Reflect.get(adapter.host.services, 'getAiSettings')()).toThrow(/disabled/)
  expect(request).toHaveBeenCalledTimes(1)
  const pending = adapter.host.services.getRecentFiles()
  adapter.dispose()
  await expect(pending).rejects.toThrow(/disposed/)
})

it('dispatches the native host’s MCP command to the public runtime and rejects commands after disposal', async () => {
  const reply = signal<[string]>()
  const event = signal<[string, string]>()
  const command = signal<[string]>()
  const channel = { request: vi.fn(), complete: vi.fn(), reply, event, command }
  const adapter = createQtDocsHost(channel)
  const result = {
    documentId: 'doc',
    revision: 1,
    output: 'Changed',
    summary: 'Changed',
    committed: true,
  }
  const handle = vi.fn(async () => result)
  adapter.attach({ commands: { handle, releaseScope: vi.fn(), disconnect: vi.fn() } })
  const message = {
    requestId: 'request',
    callerId: 'harness',
    bindingId: 'binding',
    command: 'execute_tool' as const,
    payload: { name: 'replace_selection', input: { html: 'Changed' } },
  }
  command.emit(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'native-request',
      method: 'editor.request',
      params: { message },
    }),
  )
  await vi.waitFor(() => expect(channel.complete).toHaveBeenCalled())
  expect(handle).toHaveBeenCalledWith(message)
  expect(JSON.parse(channel.complete.mock.calls[0][0])).toMatchObject({
    jsonrpc: '2.0',
    id: 'native-request',
    result: { requestId: 'request', ok: true, result },
  })
  adapter.dispose()
  command.emit(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'late-request',
      method: 'editor.request',
      params: { message },
    }),
  )
  expect(handle).toHaveBeenCalledTimes(1)
})

it('forwards resource CLI cancellation and waits for its actual file outcome', async () => {
  const reply = signal<[string]>()
  const event = signal<[string, string]>()
  const command = signal<[string]>()
  const request = vi.fn()
  const adapter = createQtDocsHost({ request, complete: vi.fn(), reply, event, command })
  const refresh = adapter.refreshResources()
  const init = JSON.parse(request.mock.calls[0][0])
  reply.emit(
    JSON.stringify({
      jsonrpc: '2.0',
      id: init.id,
      result: { attachments: [], knowledge: [], cliAvailable: true },
    }),
  )
  await refresh
  const controller = new AbortController()
  let settled = false
  const result = Promise.resolve(
    adapter.host.resources!()!.executeTool(
      { id: 'cli', name: 'run_cli', input: { args: ['docs', 'read', '/granted/source.docx'] } },
      controller.signal,
    ),
  ).then((value) => {
    settled = true
    return value
  })
  const run = JSON.parse(request.mock.calls[1][0])
  controller.abort()
  expect(request).toHaveBeenCalledTimes(3)
  const cancel = JSON.parse(request.mock.calls[2][0])
  expect(cancel.params).toEqual({ method: 'cancelCli', args: [run.params.args[1]] })
  reply.emit(JSON.stringify({ jsonrpc: '2.0', id: cancel.id, result: { canceled: true } }))
  await Promise.resolve()
  expect(settled).toBe(false)
  reply.emit(
    JSON.stringify({
      jsonrpc: '2.0',
      id: run.id,
      result: { ok: false, code: 1, stdout: '', stderr: 'Canceled', committed: null },
    }),
  )
  expect(await result).toMatchObject({ isError: true, committed: null })
  adapter.dispose()
})
