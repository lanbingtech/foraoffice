import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type {
  DocsAiInstructionRequest,
  DocsAiOperation,
  DocsHarnessAdapter,
} from '../src/shared/editor-action'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsRuntime, type RuntimeDocument } from '../src/renderer/runtime/docs-runtime'
import { createDocsCommandRouter } from '../src/renderer/runtime/command-router'
import { submitDocsEditorAction } from '../src/renderer/runtime/editor-actions'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})
const PROOFREAD: DocsAiOperation = { operationId: 'proofread_selection', parameters: {} }

function fixture(table = false) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    editorProps: { handleScrollToSelection: () => true },
    content: table
      ? '<table><tr><td>Cell selected text after</td><td>Other cell</td></tr></table><p>Outside</p>'
      : '<p>Before selected after</p>',
  })
  let from = 0
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text!.includes('selected')) from = pos + node.text!.indexOf('selected')
  })
  editor.commands.setTextSelection({ from, to: from + 'selected'.length })
  const submit = vi.fn<DocsHarnessAdapter['submit']>(async () => {})
  const state: { document: RuntimeDocument | null; harness: DocsHarnessAdapter | undefined } = {
    document: { editor, identity: {}, numIds: { bullet: null, ordered: null }, stateVersion: {} },
    harness: { submit },
  }
  const runtime = createDocsRuntime({ current: () => state.document })
  const commands = createDocsCommandRouter(runtime)
  cleanup.push(() => {
    commands.dispose()
    runtime.dispose()
    editor.destroy()
  })
  const bindings = {
    runtime,
    commands,
    current: () => state.document,
    harness: () => state.harness,
  }
  return { editor, state, submit, runtime, commands, bindings, from }
}

describe('neutral built-in AI instruction resolution', () => {
  it('passes stable metadata and the captured cell selection before submitting the resolved snapshot', async () => {
    const { editor, state, submit, bindings, commands } = fixture(true)
    let finish!: (instruction: string) => void
    const settings = { instruction: 'Use the configured task' }
    const parameters = { targetLanguage: 'fr' }
    const resolver = vi.fn(
      (_request: DocsAiInstructionRequest, _signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    state.harness!.resolveInstruction = resolver
    const pending = submitDocsEditorAction(bindings, 'edit', 'Default translation', {
      operationId: 'translate_selection',
      parameters,
    })
    expect(resolver).toHaveBeenCalledOnce()
    const [request, signal] = resolver.mock.calls[0]
    expect(request).toMatchObject({
      operationId: 'translate_selection',
      parameters: { targetLanguage: 'fr' },
      defaultInstruction: 'Default translation',
    })
    expect(request.context).toContain('Selected text (8 characters): "selected"')
    expect(request.context).toContain('<sel>selected</sel>')
    expect(signal.aborted).toBe(false)
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    parameters.targetLanguage = 'de'
    finish(settings.instruction)
    await pending
    settings.instruction = 'A later setting'
    expect(submit).toHaveBeenCalledOnce()
    expect(submit.mock.calls[0][0]).toMatchObject({
      id: request.id,
      bindingId: request.bindingId,
      documentId: request.documentId,
      instruction: 'Use the configured task',
      operationId: 'translate_selection',
      parameters: { targetLanguage: 'fr' },
    })
    await commands.handle({
      requestId: 'replace',
      callerId: 'agent',
      bindingId: request.bindingId,
      command: 'execute_tool',
      payload: { name: 'replace_selection', input: { html: 'polished' } },
    })
    expect(editor.state.doc.firstChild!.textContent).toBe('Cell polished text afterOther cell')
    expect(editor.state.doc.lastChild!.textContent).toBe('Outside')
  })

  it('uses defaults without a resolver and keeps built-in metadata', async () => {
    const { submit, bindings } = fixture()
    await submitDocsEditorAction(bindings, 'edit', 'Default proofread', PROOFREAD)
    expect(submit.mock.calls[0][0]).toMatchObject({
      instruction: 'Default proofread',
      ...PROOFREAD,
    })
  })

  it.each([null, undefined, '', ' \n '])(
    'falls back on an unconfigured result %j',
    async (result) => {
      const { submit, bindings, state } = fixture()
      state.harness!.resolveInstruction = async () => result
      await submitDocsEditorAction(bindings, 'edit', 'Default proofread', PROOFREAD)
      expect(submit.mock.calls[0][0]).toHaveProperty('instruction', 'Default proofread')
    },
  )

  it('preserves nonblank custom text verbatim', async () => {
    const { submit, bindings, state } = fixture()
    state.harness!.resolveInstruction = () => '  Custom task\n'
    await submitDocsEditorAction(bindings, 'edit', 'Default', PROOFREAD)
    expect(submit.mock.calls[0][0]).toHaveProperty('instruction', '  Custom task\n')
  })

  it('bypasses the resolver for free input, including text identical to a default prompt', async () => {
    const { submit, bindings, state } = fixture()
    const resolver = vi.fn(() => 'Changed task')
    state.harness!.resolveInstruction = resolver
    const instruction = '  Proofread the selected content.\n'
    await submitDocsEditorAction(bindings, 'edit', instruction)
    await submitDocsEditorAction(bindings, 'ask', '')
    expect(resolver).not.toHaveBeenCalled()
    expect(submit.mock.calls[0][0]).toHaveProperty('instruction', instruction)
    expect(submit.mock.calls[0][0]).not.toHaveProperty('operationId')
    expect(submit.mock.calls[1][0]).not.toHaveProperty('operationId')
  })

  it.each([
    'proofread_document',
    'proofread_selection',
    'suggest_synonyms',
    'resolve_comments',
    'summarize_revisions',
    'name_document',
    'summarize_document',
    'polish_document',
    'polish_selection',
    'format_document',
    'create_mind_map',
  ] as const)('resolves the built-in operation %s', async (operationId) => {
    const { submit, bindings, state } = fixture()
    const resolver = vi.fn<NonNullable<DocsHarnessAdapter['resolveInstruction']>>(
      () => 'Configured',
    )
    state.harness!.resolveInstruction = resolver
    await submitDocsEditorAction(
      bindings,
      operationId === 'name_document' ? 'name_document' : 'edit',
      operationId === 'name_document' ? '' : 'Default',
      { operationId, parameters: {} },
    )
    expect(resolver.mock.calls[0][0]).toHaveProperty('operationId', operationId)
    expect(submit.mock.calls[0][0]).toHaveProperty('operationId', operationId)
  })

  it.each([
    'replace',
    'close',
    'revoke',
    'dispose',
    'runtime_dispose',
    'edit_selection',
    'state_change',
    'harness_change',
  ] as const)('does not submit a late resolution after %s', async (change) => {
    const { editor, state, submit, bindings, commands, runtime, from } = fixture(true)
    let finish!: (text: string) => void
    let request!: DocsAiInstructionRequest
    let signal!: AbortSignal
    state.harness!.resolveInstruction = (value, cancellation) => {
      request = value
      signal = cancellation
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    }
    const pending = submitDocsEditorAction(bindings, 'edit', 'Default', PROOFREAD)
    const rejected = expect(pending).rejects.toThrow()
    if (change === 'replace') {
      commands.releaseAll()
      state.document = { ...state.document!, identity: {} }
      editor.commands.setContent('<p>Another document</p>')
    }
    if (change === 'close') {
      commands.releaseAll()
      state.document = null
    }
    if (change === 'revoke') commands.releaseScope(request.bindingId)
    if (change === 'dispose') commands.dispose()
    if (change === 'runtime_dispose') runtime.dispose()
    if (change === 'edit_selection') {
      editor.commands.setTextSelection({ from, to: from + 8 })
      editor.commands.insertContent('user edited')
    }
    if (change === 'state_change') state.document = { ...state.document!, stateVersion: {} }
    if (change === 'harness_change') state.harness = { submit: vi.fn(async () => {}) }
    if (change !== 'state_change' && change !== 'harness_change') expect(signal.aborted).toBe(true)
    finish('Late instruction')
    await rejected
    expect(submit).not.toHaveBeenCalled()
    await expect(
      commands.handle({
        requestId: 'late',
        callerId: 'late',
        bindingId: request.bindingId,
        command: 'read_document',
        payload: {},
      }),
    ).rejects.toThrow()
    if (change === 'replace') expect(editor.getText()).toBe('Another document')
    if (change === 'edit_selection') expect(editor.getText()).toContain('user edited')
    runtime.dispose()
  })

  it('settles cancellation without waiting for an uncooperative resolver', async () => {
    const { bindings, commands, state, submit } = fixture()
    let request!: DocsAiInstructionRequest
    state.harness!.resolveInstruction = (value) => {
      request = value
      return new Promise<string>(() => {})
    }
    const pending = submitDocsEditorAction(bindings, 'edit', 'Default', PROOFREAD)
    const rejected = expect(pending).rejects.toThrow()
    commands.releaseScope(request.bindingId)
    await rejected
    expect(submit).not.toHaveBeenCalled()
  })

  it('refuses resolver errors and releases the captured grant', async () => {
    const { bindings, commands, state, submit } = fixture()
    let request!: DocsAiInstructionRequest
    state.harness!.resolveInstruction = (value) => {
      request = value
      throw new Error('Resolver failed')
    }
    await expect(submitDocsEditorAction(bindings, 'edit', 'Default', PROOFREAD)).rejects.toThrow(
      'Resolver failed',
    )
    expect(submit).not.toHaveBeenCalled()
    await expect(
      commands.handle({
        requestId: 'late',
        callerId: 'late',
        bindingId: request.bindingId,
        command: 'read_document',
        payload: {},
      }),
    ).rejects.toThrow()
  })
})
