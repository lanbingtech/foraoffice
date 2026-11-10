import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FileMenu } from '../src/renderer/components/FileMenu'
import type { DocsFileMenuItem } from '../src/renderer/sdk/file-menu'

let root: Root | undefined
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('navigates groups and submenus, returns focus and updates labels without replacing the trigger', () => {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const invoke = vi.fn()
  let opened = false
  let items: DocsFileMenuItem[] = [
    {
      type: 'group',
      id: 'group',
      items: [
        { type: 'action', id: 'hidden', actionId: 'hidden', label: 'Hidden', visible: false },
        { type: 'command', id: 'save', command: 'save' },
        {
          type: 'submenu',
          id: 'more',
          label: 'More',
          items: [{ type: 'action', id: 'publish', actionId: 'publish', label: 'Publish' }],
        },
      ],
    },
  ]
  const render = () =>
    root!.render(
      createElement(FileMenu, {
        label: 'File',
        items,
        open: opened,
        onOpenChange: (value: boolean) => {
          opened = value
          render()
        },
        commandLabel: () => 'Save',
        canExecute: () => true,
        onInvoke: invoke,
      }),
    )
  act(render)
  const trigger = container.querySelector<HTMLButtonElement>('.ribbon-tab-file')!
  act(() =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  )
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement?.textContent).toContain('Save')
  expect(container.textContent).not.toContain('Hidden')
  const key = (value: string) =>
    act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true }),
      ),
    )
  key('ArrowDown')
  key('ArrowRight')
  expect(document.activeElement?.textContent).toBe('Publish')
  key('Escape')
  expect(document.activeElement?.textContent).toContain('More')
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
  key('ArrowRight')
  key('Enter')
  expect(invoke).toHaveBeenCalledWith('publish')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
  items = [
    { type: 'action', id: 'publish', actionId: 'publish', label: 'Published', enabled: false },
  ]
  act(() => {
    opened = true
    render()
  })
  expect(container.querySelector('.ribbon-tab-file')).toBe(trigger)
  const disabled = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!
  expect(disabled.textContent).toBe('Published')
  expect(disabled.getAttribute('aria-disabled')).toBe('true')
  act(() => disabled.click())
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('hides empty groups/submenus and enforces command and ancestor disabled states', () => {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const invoke = vi.fn()
  act(() =>
    root!.render(
      createElement(FileMenu, {
        label: 'File',
        open: true,
        onOpenChange: vi.fn(),
        commandLabel: () => 'Save',
        canExecute: () => false,
        onInvoke: invoke,
        items: [
          { type: 'submenu', id: 'empty', label: 'Empty', items: [] },
          {
            type: 'group',
            id: 'disabled',
            enabled: false,
            items: [{ type: 'action', id: 'x', actionId: 'x', label: 'X' }],
          },
          { type: 'command', id: 'save', command: 'save', enabled: true },
        ],
      }),
    ),
  )
  expect(container.textContent).not.toContain('Empty')
  expect(document.activeElement).toBe(container.querySelector('[role="menuitem"]'))
  for (const button of container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
    expect(button.getAttribute('aria-disabled')).toBe('true')
    act(() => button.click())
  }
  expect(invoke).not.toHaveBeenCalled()
})

it('retains keyboard navigation after the host removes the focused item or its submenu', () => {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  let items: DocsFileMenuItem[] = [
    { type: 'action', id: 'first', actionId: 'first', label: 'First' },
    {
      type: 'submenu',
      id: 'more tools',
      label: 'More',
      items: [{ type: 'action', id: 'child', actionId: 'child', label: 'Child' }],
    },
  ]
  const render = () =>
    root!.render(
      createElement(FileMenu, {
        label: 'File',
        open: true,
        onOpenChange: vi.fn(),
        commandLabel: () => '',
        canExecute: () => true,
        onInvoke: vi.fn(),
        items,
      }),
    )
  act(render)
  expect(document.activeElement?.textContent).toBe('First')
  items = items.slice(1)
  act(render)
  expect(document.activeElement?.textContent).toContain('More')
  const trigger = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!
  const controlled = trigger.getAttribute('aria-controls')!
  expect(controlled).not.toMatch(/\s/)
  act(() => trigger.click())
  expect(document.getElementById(controlled)?.getAttribute('role')).toBe('menu')
  expect(document.activeElement?.textContent).toBe('Child')
  items = [{ type: 'action', id: 'last', actionId: 'last', label: 'Last' }]
  act(render)
  expect(document.activeElement?.textContent).toBe('Last')
})
