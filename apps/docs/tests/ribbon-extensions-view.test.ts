import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  RibbonExtensionGroups,
  RibbonQuickAccess,
} from '../src/renderer/components/RibbonExtensions'
import type { DocsRibbonControl, DocsRibbonGroup } from '../src/renderer/sdk/ribbon'

let root: Root | undefined
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('renders native groups and dropdown controls, navigates submenus and restores trigger focus', () => {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const invoke = vi.fn()
  let open: string | null = null
  const groups: DocsRibbonGroup[] = [
    {
      id: 'group',
      label: 'Tools',
      items: [
        { type: 'button', id: 'plain', label: 'Inspect', actionId: 'inspect' },
        {
          type: 'menu',
          id: 'menu',
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
  ]
  const render = () =>
    root!.render(
      createElement(RibbonExtensionGroups, {
        groups,
        openMenuId: open,
        onOpenMenu: (id: string | null) => {
          open = id
          render()
        },
        onInvoke: invoke,
      }),
    )
  act(render)
  const buttons = container.querySelectorAll<HTMLButtonElement>('.rb-big')
  expect(buttons).toHaveLength(2)
  act(() => buttons[0].click())
  expect(invoke).toHaveBeenCalledWith('plain')
  act(() =>
    buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  )
  expect(document.activeElement?.textContent).toContain('Nested')
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ),
  )
  expect(document.activeElement?.textContent).toBe('Run')
  act(() =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ),
  )
  expect(invoke).toHaveBeenLastCalledWith('run')
  expect(document.activeElement).toBe(buttons[1])
  expect(container.querySelector('[role="menu"]')).toBeNull()
})

it('omits empty/hidden groups and controls and enforces disabled groups and quick-access buttons', () => {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const invoke = vi.fn()
  const item = { type: 'button' as const, id: 'button', label: 'Inspect', actionId: 'inspect' }
  act(() =>
    root!.render(
      createElement(RibbonExtensionGroups, {
        groups: [
          { id: 'empty', label: 'Empty', items: [] },
          { id: 'hidden', label: 'Hidden', visible: false, items: [item] },
          { id: 'disabled', label: 'Disabled', enabled: false, items: [item] },
        ],
        openMenuId: null,
        onOpenMenu: vi.fn(),
        onInvoke: invoke,
      }),
    ),
  )
  expect(container.querySelectorAll('.ribbon-group')).toHaveLength(1)
  const button = container.querySelector<HTMLButtonElement>('button')!
  expect(button.disabled).toBe(true)
  act(() => button.click())
  expect(invoke).not.toHaveBeenCalled()
  act(() =>
    root!.render(
      createElement(RibbonQuickAccess, {
        items: [
          { ...item, enabled: false },
          { ...item, id: 'hidden', visible: false },
        ],
        openMenuId: null,
        onOpenMenu: vi.fn(),
        onInvoke: invoke,
      }),
    ),
  )
  expect(container.querySelectorAll('.qa-btn')).toHaveLength(1)
  expect(container.querySelector('button')!.disabled).toBe(true)
  expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Inspect')
})

it.each([false, true])(
  'reflects host pressed state without replacing the button or toggling optimistically (quick=%s)',
  (quick) => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const invoke = vi.fn()
    let item: DocsRibbonControl = {
      type: 'button',
      id: 'panel',
      label: 'Panel',
      actionId: 'panel',
      pressed: false,
    }
    const render = () => {
      const interaction = { openMenuId: null, onOpenMenu: vi.fn(), onInvoke: invoke }
      root!.render(
        quick
          ? createElement(RibbonQuickAccess, { items: [item], ...interaction })
          : createElement(RibbonExtensionGroups, {
              groups: [{ id: 'tools', label: 'Tools', items: [item] }],
              ...interaction,
            }),
      )
    }
    act(render)
    const button = container.querySelector('button')!
    expect(button.getAttribute('aria-pressed')).toBe('false')
    act(() => button.click())
    expect(invoke).toHaveBeenCalledWith('panel')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    item = { ...item, pressed: true }
    act(render)
    expect(container.querySelector('button')).toBe(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.classList.contains('active')).toBe(true)
    item = { ...item, enabled: false }
    act(render)
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    act(() => button.click())
    expect(invoke).toHaveBeenCalledTimes(1)
    item = { ...item, pressed: false }
    act(render)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.classList.contains('active')).toBe(false)
    item = { type: 'button', id: 'panel', label: 'Panel', actionId: 'panel' }
    act(render)
    expect(button.hasAttribute('aria-pressed')).toBe(false)
  },
)
