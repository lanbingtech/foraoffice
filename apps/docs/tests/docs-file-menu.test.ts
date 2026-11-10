import { describe, expect, it, vi } from 'vitest'
import { createDocsFileMenu } from '../src/renderer/sdk/file-menu'

function fixture() {
  let generation = 1
  let document = {
    id: 'host:doc',
    name: 'Draft.docx',
    path: null as string | null,
    dirty: false,
    readOnly: false,
  }
  const execute = vi.fn(async () => true)
  let allowed = true
  const menu = createDocsFileMenu({
    current: () => ({ generation, document }),
    execute,
    canExecute: () => allowed,
  })
  return {
    menu,
    execute,
    token: () => menu.documentState()!.documentToken,
    replace: () => {
      generation++
      menu.refresh()
    },
    update: (patch: Partial<typeof document>) => {
      document = { ...document, ...patch }
      menu.refresh()
    },
    deny: () => {
      allowed = false
      menu.refresh()
    },
  }
}

describe('public file menu controller', () => {
  it('updates labels and nested states atomically without executing document commands', async () => {
    const { menu, token, execute } = fixture()
    const events = vi.fn()
    menu.onAction(events)
    menu.set({
      documentToken: token(),
      items: [
        {
          type: 'group',
          id: 'business',
          items: [
            {
              type: 'submenu',
              id: 'workflow',
              label: 'Workflow',
              items: [
                { type: 'action', id: 'publish', actionId: 'host.publish', label: 'Publish' },
              ],
            },
          ],
        },
      ],
    })
    await menu.activate('publish', token())
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'host.publish',
        itemId: 'publish',
        documentToken: token(),
        document: expect.objectContaining({ id: 'host:doc' }),
      }),
    )
    expect(execute).not.toHaveBeenCalled()
    menu.set({
      documentToken: token(),
      items: [
        {
          type: 'action',
          id: 'publish',
          actionId: 'host.publish',
          label: 'Published',
          enabled: false,
        },
      ],
    })
    expect(menu.snapshot()![0].label).toBe('Published')
    await expect(menu.activate('publish', token())).rejects.toThrow(/unavailable/)
    expect(events).toHaveBeenCalledTimes(1)
    menu.reset()
    expect(menu.snapshot()).toBeNull()
  })

  it('dispatches builtins exactly once and cannot bypass command policy or ancestor states', async () => {
    const { menu, token, execute, deny } = fixture()
    const events = vi.fn()
    menu.onAction(events)
    for (const command of [
      'new',
      'open',
      'save',
      'saveAs',
      'exportPdf',
      'exportHtml',
      'exportMarkdown',
      'exportImages',
    ] as const) {
      menu.set({
        documentToken: token(),
        items: [{ type: 'command', id: 'builtin', command, enabled: true }],
      })
      await menu.activate('builtin', token())
      expect(execute).toHaveBeenLastCalledWith(command)
    }
    expect(execute).toHaveBeenCalledTimes(8)
    expect(events).not.toHaveBeenCalled()
    deny()
    await expect(menu.activate('builtin', token())).rejects.toThrow(/unavailable/)
    for (const state of [{ visible: false }, { enabled: false }]) {
      menu.set({
        documentToken: token(),
        items: [
          {
            type: 'submenu',
            id: 'parent',
            label: 'Parent',
            ...state,
            items: [{ type: 'action', id: 'child', actionId: 'host.action', label: 'Child' }],
          },
        ],
      })
      await expect(menu.activate('child', token())).rejects.toThrow(/unavailable/)
    }
    expect(execute).toHaveBeenCalledTimes(8)
    expect(events).not.toHaveBeenCalled()
  })

  it('refuses duplicate IDs, ambiguous actions and unknown commands without replacing the menu', () => {
    const { menu, token } = fixture()
    menu.set({ documentToken: token(), items: [{ type: 'command', id: 'save', command: 'save' }] })
    const previous = menu.snapshot()
    const invalid = [
      [
        {
          type: 'group',
          id: 'same',
          items: [{ type: 'action', id: 'same', actionId: 'x', label: 'X' }],
        },
      ],
      [{ type: 'command', id: 'x', command: 'publish' }],
      [{ type: 'action', id: 'x', actionId: 'x', label: 'X', command: 'save' }],
      [{ type: 'action', id: '', actionId: 'x', label: 'X' }],
    ]
    for (const items of invalid) {
      expect(() => menu.set({ documentToken: token(), items } as never)).toThrow()
      expect(menu.snapshot()).toBe(previous)
    }
  })

  it('notifies state changes, preserves the token for edits and rotates it on reopen or adoption', async () => {
    const { menu, token, update, replace } = fixture()
    const states = vi.fn()
    const off = menu.onDocumentStateChanged(states)
    const first = token()
    expect(states).toHaveBeenCalledTimes(1)
    menu.set({
      documentToken: first,
      items: [{ type: 'action', id: 'x', actionId: 'host.x', label: 'X' }],
    })
    update({ name: 'Renamed.docx', dirty: true })
    expect(token()).toBe(first)
    expect(menu.snapshot()).not.toBeNull()
    expect(states).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'Renamed.docx', dirty: true }),
    )
    menu.refresh()
    expect(states).toHaveBeenCalledTimes(2)
    replace()
    expect(token()).not.toBe(first)
    expect(menu.snapshot()).toBeNull()
    expect(() => menu.set({ documentToken: first, items: [] })).toThrow(/stale/)
    await expect(menu.activate('x', first)).rejects.toThrow(/stale/)
    const reopened = token()
    update({ id: 'host:copy' })
    expect(token()).not.toBe(reopened)
    off()
    const calls = states.mock.calls.length
    replace()
    expect(states).toHaveBeenCalledTimes(calls)
  })

  it('supports an empty host and releases action/state/view listeners on disposal', async () => {
    const menu = createDocsFileMenu({
      current: () => ({ generation: 0, document: null }),
      execute: vi.fn(),
      canExecute: () => true,
    })
    const actions = vi.fn(),
      states = vi.fn(),
      views = vi.fn()
    const off = menu.onAction(actions)
    menu.onDocumentStateChanged(states)
    menu.subscribe(views)
    menu.set({
      documentToken: null,
      items: [{ type: 'action', id: 'open', actionId: 'host.open', label: 'Open' }],
    })
    await menu.activate('open', null)
    expect(actions).toHaveBeenLastCalledWith(
      expect.objectContaining({ document: null, documentToken: null }),
    )
    off()
    await menu.activate('open', null)
    expect(actions).toHaveBeenCalledTimes(1)
    menu.dispose()
    expect(() => menu.set({ documentToken: null, items: [] })).toThrow(/disposed/)
    await expect(menu.activate('open', null)).rejects.toThrow(/disposed/)
    menu.refresh()
    menu.dispose()
    expect(states).toHaveBeenCalledTimes(1)
  })
})
