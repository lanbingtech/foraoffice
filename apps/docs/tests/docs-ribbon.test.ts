import { expect, it, vi } from 'vitest'
import {
  createDocsRibbon,
  parseDocsRibbon,
  type DocsRibbonConfiguration,
} from '../src/renderer/sdk/ribbon'

const documentState = () => ({
  id: 'doc',
  name: 'Document',
  path: null,
  dirty: false,
  readOnly: false,
  documentToken: 'session-1',
})
const configuration = (): DocsRibbonConfiguration => ({
  documentToken: 'session-1',
  tabs: [
    {
      id: 'extension.tools',
      label: 'Tools',
      groups: [
        {
          id: 'tools',
          label: 'Tools',
          items: [{ type: 'button', id: 'inspect', label: 'Inspect', actionId: 'inspect' }],
        },
      ],
    },
  ],
  groups: [
    {
      tabId: 'home',
      id: 'home-tools',
      label: 'More tools',
      items: [
        {
          type: 'menu',
          id: 'more',
          label: 'More',
          items: [
            {
              type: 'submenu',
              id: 'nested',
              label: 'Nested',
              items: [{ type: 'action', id: 'run', label: 'Run', actionId: 'run' }],
            },
          ],
        },
      ],
    },
  ],
  quickAccess: [{ type: 'button', id: 'quick', label: 'Quick', actionId: 'quick' }],
})

it('emits neutral actions with their location and captured document, without mutating document state', () => {
  const state = documentState()
  const ribbon = createDocsRibbon(() => ({ ...state }))
  const action = vi.fn()
  ribbon.onAction(action)
  const input = configuration()
  ribbon.set(input)
  input.tabs![0].label = 'Changed input'
  const view = ribbon.snapshot()!
  expect(view.tabs![0].label).toBe('Tools')
  for (const id of ['inspect', 'run', 'quick']) ribbon.activate(id, view)
  expect(
    action.mock.calls.map(([event]) => [
      event.actionId,
      event.location,
      event.tabId,
      event.groupId,
    ]),
  ).toEqual([
    ['inspect', 'tab', 'extension.tools', 'tools'],
    ['run', 'tab', 'home', 'home-tools'],
    ['quick', 'quickAccess', null, null],
  ])
  expect(action.mock.calls[0][0]).toMatchObject({
    documentToken: state.documentToken,
    document: state,
  })
  expect(state).toEqual(documentState())
})

it('accepts host-controlled pressed states in every ribbon location without changing them on activation', () => {
  const ribbon = createDocsRibbon(documentState)
  const input = configuration()
  input.tabs![0].groups[0].items[0] = {
    type: 'button',
    id: 'inspect',
    label: 'Inspect',
    actionId: 'inspect',
    pressed: false,
  }
  input.groups![0].items = [
    { type: 'button', id: 'panel', label: 'Panel', actionId: 'panel', pressed: true },
  ]
  input.quickAccess![0] = {
    type: 'button',
    id: 'quick',
    label: 'Quick',
    actionId: 'quick',
    pressed: true,
  }
  ribbon.set(input)
  const rendered = ribbon.snapshot()!
  ribbon.activate('inspect', rendered)
  ribbon.activate('panel', rendered)
  ribbon.activate('quick', rendered)
  expect(ribbon.snapshot()).toEqual(input)
  input.quickAccess![0] = { ...input.quickAccess![0], pressed: false }
  ribbon.set(input)
  expect(ribbon.snapshot()!.quickAccess![0]).toMatchObject({ pressed: false })
  expect(() => ribbon.activate('quick', rendered)).toThrow(/stale/)
  for (const pressed of ['true', null, 1])
    expect(() =>
      parseDocsRibbon({
        documentToken: null,
        quickAccess: [{ type: 'button', id: 'bad', label: 'Bad', actionId: 'bad', pressed }],
      }),
    ).toThrow()
  expect(() =>
    parseDocsRibbon({
      documentToken: null,
      quickAccess: [{ type: 'menu', id: 'menu', label: 'Menu', items: [], pressed: true }],
    }),
  ).toThrow()
})

it('clears contributions on document replacement and rejects stale updates and rendered actions', () => {
  let state = documentState()
  const ribbon = createDocsRibbon(() => state)
  const changed = vi.fn()
  const action = vi.fn()
  ribbon.subscribe(changed)
  ribbon.onAction(action)
  ribbon.set(configuration())
  const view = ribbon.snapshot()!
  ribbon.set(configuration())
  expect(() => ribbon.activate('inspect', view)).toThrow(/stale/)
  const replacement = ribbon.snapshot()!
  state = { ...state, documentToken: 'session-2' }
  ribbon.refresh()
  expect(ribbon.snapshot()).toBeNull()
  expect(changed).toHaveBeenCalledTimes(3)
  expect(() => ribbon.activate('inspect', replacement)).toThrow(/stale/)
  expect(() => ribbon.set(configuration())).toThrow(/stale/)
  expect(action).not.toHaveBeenCalled()
})

it('enforces hidden and disabled ancestors, resets and disposes independently of the document', () => {
  const ribbon = createDocsRibbon(documentState)
  const input = configuration()
  input.tabs![0].enabled = false
  input.groups![0].items[0].visible = false
  input.quickAccess![0].enabled = false
  ribbon.set(input)
  for (const id of ['inspect', 'run', 'quick'])
    expect(() => ribbon.activate(id, ribbon.snapshot()!)).toThrow(/unavailable/)
  ribbon.reset()
  expect(ribbon.snapshot()).toBeNull()
  ribbon.set({ documentToken: 'session-1' })
  ribbon.dispose()
  expect(() => ribbon.set(input)).toThrow(/disposed/)
  expect(() => ribbon.reset()).toThrow(/disposed/)
  expect(() => ribbon.onAction(vi.fn())).toThrow(/disposed/)
})

it('supports an empty editor and isolates editor instances', () => {
  const first = createDocsRibbon(() => null)
  const second = createDocsRibbon(() => null)
  const action = vi.fn()
  first.onAction(action)
  first.set({ documentToken: null, quickAccess: configuration().quickAccess })
  first.activate('quick', first.snapshot()!)
  expect(action).toHaveBeenCalledWith(
    expect.objectContaining({ document: null, documentToken: null }),
  )
  expect(second.snapshot()).toBeNull()
})

it('rejects ambiguous IDs, reserved tabs, unknown targets and executable or unbounded UI data atomically', () => {
  const ribbon = createDocsRibbon(documentState)
  ribbon.set(configuration())
  const before = ribbon.snapshot()
  const duplicate = configuration()
  duplicate.quickAccess![0].id = 'inspect'
  const reserved = configuration()
  reserved.tabs![0].id = 'home'
  const target = configuration()
  target.groups![0].tabId = 'unknown' as 'home'
  const icon = configuration()
  icon.quickAccess![0].icon = 'https://example.com/tracker.png'
  for (const input of [
    duplicate,
    reserved,
    target,
    icon,
    { ...configuration(), html: '<button>Run</button>' },
  ]) {
    expect(() => ribbon.set(input as DocsRibbonConfiguration)).toThrow()
    expect(ribbon.snapshot()).toBe(before)
  }
  let item: unknown = { type: 'action', id: 'leaf', label: 'Leaf', actionId: 'leaf' }
  for (let i = 0; i < 10; i++)
    item = { type: 'submenu', id: `sub-${i}`, label: 'Sub', items: [item] }
  expect(() =>
    parseDocsRibbon({
      documentToken: null,
      quickAccess: [{ type: 'menu', id: 'deep', label: 'Deep', items: [item] }],
    }),
  ).toThrow(/nesting/)
  expect(() =>
    parseDocsRibbon({
      documentToken: null,
      quickAccess: Array.from({ length: 513 }, (_, i) => ({
        type: 'button',
        id: `b-${i}`,
        label: 'B',
        actionId: 'b',
      })),
    }),
  ).toThrow(/512/)
})
