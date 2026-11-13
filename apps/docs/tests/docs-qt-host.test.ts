import { expect, it, vi } from 'vitest'
import { createQtDocsHost, type DocsQtChannel, type QtSignal } from '../src/renderer/host/qt'
import { Editor } from '@tiptap/core'
import { createDocsRuntime } from '../src/renderer/runtime/docs-runtime'
import { createDocsCommandRouter } from '../src/renderer/runtime/command-router'
import { createDocsFileMenu } from '../src/renderer/sdk/file-menu'
import { createDocsRibbon } from '../src/renderer/sdk/ribbon'
import type { DocsInspection } from '../src/renderer/sdk/inspection'
import type { DocsAnnotations } from '../src/renderer/sdk/annotations'
import type { DocsAiInstructionRequest, DocsEditorAction } from '../src/shared/editor-action'

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

it('transports menu snapshots, document sessions and stable host actions through the public SDK and unsubscribes on disposal', async () => {
  let generation = 1
  const menu = createDocsFileMenu({
    current: () => ({
      generation,
      document: { id: 'host:doc', name: 'Draft', path: null, dirty: false, readOnly: false },
    }),
    canExecute: () => true,
    execute: vi.fn(),
  })
  const channel = {
    request: vi.fn(),
    complete: vi.fn(),
    reply: signal<[string]>(),
    event: signal<[string, string]>(),
    command: signal<[string]>(),
  }
  const adapter = createQtDocsHost(channel)
  adapter.attach({
    commands: { handle: vi.fn(), releaseScope: vi.fn(), disconnect: vi.fn() },
    inspection: {} as DocsInspection,
    annotations: {} as DocsAnnotations,
    documents: {
      new: vi.fn(),
      open: vi.fn(),
      save: vi.fn(),
      state: menu.documentState,
      subscribe: menu.onDocumentStateChanged,
    },
    ui: { fileMenu: menu, ribbon: createDocsRibbon(menu.documentState) },
  })
  const send = async (id: string, operation: string, args: unknown) => {
    channel.command.emit(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'sdk.request', params: { operation, args } }),
    )
    await vi.waitFor(() =>
      expect(channel.complete.mock.calls.some(([value]) => JSON.parse(value).id === id)).toBe(true),
    )
    return channel.complete.mock.calls
      .map(([value]) => JSON.parse(value))
      .find((value) => value.id === id)
  }
  const documentToken = menu.documentState()!.documentToken
  const items = [{ type: 'action', id: 'publish', actionId: 'host.publish', label: 'Publish' }]
  expect(await send('set', 'ui.fileMenu.set', { documentToken, items })).toMatchObject({
    result: { ok: true },
  })
  await menu.activate('publish', documentToken)
  const notifications = () => channel.request.mock.calls.map(([value]) => JSON.parse(value))
  expect(notifications()).toContainEqual(
    expect.objectContaining({
      method: 'sdk.menuAction',
      params: expect.objectContaining({ actionId: 'host.publish', documentToken }),
    }),
  )
  generation++
  menu.refresh()
  expect(notifications()).toContainEqual(
    expect.objectContaining({
      method: 'sdk.documentStateChanged',
      params: {
        state: expect.objectContaining({ documentToken: menu.documentState()!.documentToken }),
      },
    }),
  )
  expect(await send('stale', 'ui.fileMenu.set', { documentToken, items })).toHaveProperty('error')
  expect(await send('reset', 'ui.fileMenu.reset', {})).toMatchObject({ result: { ok: true } })
  adapter.dispose()
  const count = channel.request.mock.calls.length
  generation++
  menu.refresh()
  menu.set({ documentToken: menu.documentState()!.documentToken, items: items as never })
  await menu.activate('publish', menu.documentState()!.documentToken)
  expect(channel.request).toHaveBeenCalledTimes(count)
  menu.dispose()
})

it('transports neutral ribbon contributions and action context through the same public Qt SDK', async () => {
  const menu = createDocsFileMenu({
    current: () => ({ generation: 1, document: null }),
    canExecute: () => false,
    execute: vi.fn(),
  })
  const ribbon = createDocsRibbon(menu.documentState)
  const channel = {
    request: vi.fn(),
    complete: vi.fn(),
    reply: signal<[string]>(),
    event: signal<[string, string]>(),
    command: signal<[string]>(),
  }
  const adapter = createQtDocsHost(channel)
  adapter.attach({
    commands: { handle: vi.fn(), releaseScope: vi.fn(), disconnect: vi.fn() },
    inspection: {} as DocsInspection,
    annotations: {} as DocsAnnotations,
    documents: {
      new: vi.fn(),
      open: vi.fn(),
      save: vi.fn(),
      state: menu.documentState,
      subscribe: menu.onDocumentStateChanged,
    },
    ui: { fileMenu: menu, ribbon },
  })
  const send = async (id: string, operation: string, args: unknown) => {
    channel.command.emit(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'sdk.request', params: { operation, args } }),
    )
    await vi.waitFor(() =>
      expect(channel.complete.mock.calls.some(([value]) => JSON.parse(value).id === id)).toBe(true),
    )
    return channel.complete.mock.calls
      .map(([value]) => JSON.parse(value))
      .find((value) => value.id === id)
  }
  expect(
    await send('set', 'ui.ribbon.set', {
      documentToken: null,
      quickAccess: [
        {
          type: 'button',
          id: 'inspect',
          label: 'Inspect',
          actionId: 'extension.inspect',
          pressed: true,
        },
      ],
    }),
  ).toMatchObject({ result: { ok: true } })
  expect(ribbon.snapshot()!.quickAccess![0]).toMatchObject({ pressed: true })
  ribbon.activate('inspect', ribbon.snapshot()!)
  expect(channel.request.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(
    expect.objectContaining({
      method: 'sdk.ribbonAction',
      params: expect.objectContaining({
        actionId: 'extension.inspect',
        location: 'quickAccess',
        document: null,
      }),
    }),
  )
  expect(
    await send('bad', 'ui.ribbon.set', {
      documentToken: null,
      tabs: [{ id: 'home', label: 'Override', groups: [] }],
    }),
  ).toHaveProperty('error')
  expect(await send('reset', 'ui.ribbon.reset', {})).toMatchObject({ result: { ok: true } })
  expect(ribbon.snapshot()).toBeNull()
  adapter.dispose()
  ribbon.set({
    documentToken: null,
    quickAccess: [{ type: 'button', id: 'inspect', label: 'Inspect', actionId: 'inspect' }],
  })
  const count = channel.request.mock.calls.length
  ribbon.activate('inspect', ribbon.snapshot()!)
  expect(channel.request).toHaveBeenCalledTimes(count)
  ribbon.dispose()
  menu.dispose()
})

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

it('binds the current document for host-started MCP and reports scope revocation without an AI action', async () => {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: '<p>Live</p>',
  })
  const runtime = createDocsRuntime({
    current: () => ({ editor, identity: editor, numIds: { bullet: null, ordered: null } }),
  })
  const commands = createDocsCommandRouter(runtime)
  const channel = {
    request: vi.fn(),
    complete: vi.fn(),
    reply: signal<[string]>(),
    event: signal<[string, string]>(),
    command: signal<[string]>(),
  }
  const adapter = createQtDocsHost(channel)
  try {
    adapter.attach({ runtime, commands })
    channel.command.emit(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'bind',
        method: 'editor.bindMcp',
        params: { bindingId: 'host-grant' },
      }),
    )
    await vi.waitFor(() => expect(channel.complete).toHaveBeenCalled())
    const reply = JSON.parse(channel.complete.mock.calls[0][0])
    expect(reply.result).toMatchObject({ bindingId: 'host-grant', documentId: expect.any(String) })
    commands.releaseAll()
    expect(channel.request.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual({
      jsonrpc: '2.0',
      method: 'editor.mcpRevoked',
      params: { bindingId: 'host-grant' },
    })
    await expect(
      commands.handle({
        requestId: 'late',
        callerId: 'external',
        bindingId: 'host-grant',
        command: 'read_document',
        payload: {},
      }),
    ).rejects.toThrow(/not bound/)
  } finally {
    commands.dispose()
    runtime.dispose()
    adapter.dispose()
    editor.destroy()
  }
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

const instructionRequest: DocsAiInstructionRequest = {
  id: 'instruction-action',
  bindingId: 'captured-selection',
  documentId: 'document-generation',
  operationId: 'translate_selection',
  parameters: { targetLanguage: 'fr' },
  defaultInstruction: 'Default translation',
  context: 'Selected text: example',
}

function instructionChannel() {
  const channel = {
    request: vi.fn(),
    complete: vi.fn(),
    reply: signal<[string]>(),
    event: signal<[string, string]>(),
    command: signal<[string]>(),
  }
  return { channel, adapter: createQtDocsHost(channel) }
}

it.each(['Configured translation', null])(
  'resolves built-in instructions through the neutral Qt contract (%s)',
  async (result) => {
    const { channel, adapter } = instructionChannel()
    try {
      expect(adapter.host.harness!.resolveInstruction).toBeTypeOf('function')
      const resolved = adapter.host.harness!.resolveInstruction!(
        instructionRequest,
        new AbortController().signal,
      )
      const request = JSON.parse(channel.request.mock.calls[0][0])
      expect(request).toMatchObject({
        jsonrpc: '2.0',
        method: 'editor.resolveInstruction',
        params: instructionRequest,
      })
      channel.reply.emit(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      expect(await resolved).toBe(result)
      const action: DocsEditorAction = {
        ...instructionRequest,
        kind: 'edit',
        instruction: 'Resolved snapshot',
      }
      const submitted = adapter.host.harness!.submit(action)
      const submitRequest = JSON.parse(channel.request.mock.calls[1][0])
      expect(submitRequest).toMatchObject({ method: 'editor.submitAction', params: action })
      channel.reply.emit(JSON.stringify({ jsonrpc: '2.0', id: submitRequest.id, result: null }))
      await submitted
    } finally {
      adapter.dispose()
    }
  },
)

it('cancels a pending Qt instruction request and ignores its late response', async () => {
  const { channel, adapter } = instructionChannel()
  const controller = new AbortController()
  try {
    const resolved = adapter.host.harness!.resolveInstruction!(
      instructionRequest,
      controller.signal,
    )
    const rejected = expect(resolved).rejects.toMatchObject({ name: 'AbortError' })
    const request = JSON.parse(channel.request.mock.calls[0][0])
    controller.abort()
    await rejected
    expect(channel.request.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual({
      jsonrpc: '2.0',
      method: 'editor.cancelInstruction',
      params: { id: instructionRequest.id },
    })
    channel.reply.emit(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'Late instruction' }),
    )
    expect(channel.request.mock.calls.map(([value]) => JSON.parse(value).method)).not.toContain(
      'editor.submitAction',
    )
  } finally {
    adapter.dispose()
  }
})

it('does not send an instruction request when cancellation already happened', async () => {
  const { channel, adapter } = instructionChannel()
  const controller = new AbortController()
  controller.abort()
  try {
    await expect(
      adapter.host.harness!.resolveInstruction!(instructionRequest, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(channel.request).not.toHaveBeenCalled()
  } finally {
    adapter.dispose()
  }
})

it('rejects pending instruction resolution on disposal and does not consume a late reply', async () => {
  const { channel, adapter } = instructionChannel()
  const resolved = adapter.host.harness!.resolveInstruction!(
    instructionRequest,
    new AbortController().signal,
  )
  const rejected = expect(resolved).rejects.toThrow('disposed')
  const request = JSON.parse(channel.request.mock.calls[0][0])
  adapter.dispose()
  await rejected
  channel.reply.emit(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'Late instruction' }))
  expect(channel.request.mock.calls.map(([value]) => JSON.parse(value).method)).not.toContain(
    'editor.submitAction',
  )
})

it('propagates native resolver failures and rejects invalid native result types', async () => {
  const { channel, adapter } = instructionChannel()
  try {
    const failed = adapter.host.harness!.resolveInstruction!(
      instructionRequest,
      new AbortController().signal,
    )
    const rejected = expect(failed).rejects.toThrow('Resolver refused')
    const request = JSON.parse(channel.request.mock.calls[0][0])
    channel.reply.emit(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: 'Resolver refused' } }),
    )
    await rejected
    const invalid = adapter.host.harness!.resolveInstruction!(
      instructionRequest,
      new AbortController().signal,
    )
    const invalidRejected = expect(invalid).rejects.toThrow('instruction')
    const second = JSON.parse(channel.request.mock.calls[1][0])
    channel.reply.emit(
      JSON.stringify({ jsonrpc: '2.0', id: second.id, result: { instruction: 'wrong shape' } }),
    )
    await invalidRejected
  } finally {
    adapter.dispose()
  }
})
