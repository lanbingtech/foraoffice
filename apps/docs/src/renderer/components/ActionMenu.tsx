import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { DocsFileMenuCommand, DocsFileMenuItem } from '../sdk/file-menu'

export interface ActionMenuProps {
  label: string
  items: readonly DocsFileMenuItem[]
  open: boolean
  onOpenChange(open: boolean): void
  commandLabel(command: DocsFileMenuCommand): string
  canExecute(command: DocsFileMenuCommand): boolean
  onInvoke(id: string): void
  itemClassName?(id: string): string | undefined
  buttonClassName?: string
  buttonContent?: ReactNode
  className?: string
  tooltip?: string
  disabled?: boolean
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement, nested: boolean) {
  const rect = anchor.getBoundingClientRect()
  const { width, height } = menu.getBoundingClientRect()
  const rtl = getComputedStyle(anchor).direction === 'rtl'
  const preferred = nested
    ? rtl
      ? rect.left - width
      : rect.right
    : rtl
      ? rect.right - width
      : rect.left
  const alternate = rtl ? rect.right : rect.left - width
  const left =
    nested && (preferred < 8 || preferred + width > window.innerWidth - 8) ? alternate : preferred
  const below = nested ? rect.top : rect.bottom + 2
  const top =
    !nested && below + height > window.innerHeight - 8 && rect.top - height >= 8
      ? rect.top - height
      : below
  menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`
  menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`
}

/** Menu-button keyboard/focus contract follows WAI-ARIA APG, including nested menus. */
export function ActionMenu({
  label,
  items,
  open,
  onOpenChange,
  commandLabel,
  canExecute,
  onInvoke,
  itemClassName,
  buttonClassName,
  buttonContent,
  className,
  tooltip,
  disabled,
}: ActionMenuProps) {
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const rootMenu = useRef<HTMLDivElement>(null)
  const [path, setPath] = useState<string[]>([])
  const focusMenu = useRef<string | null>(null)
  const focusLast = useRef(false)
  const [pointerFocus, setPointerFocus] = useState(false)
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const menu = rootMenu.current
      if (!menu || !trigger.current) return
      positionMenu(menu, trigger.current, false)
      for (const child of menu.querySelectorAll<HTMLElement>('.file-submenu')) {
        const anchor = child.parentElement?.querySelector<HTMLButtonElement>(':scope > button')
        if (anchor) positionMenu(child, anchor, true)
      }
    }
    position()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position)
    if (trigger.current) observer?.observe(trigger.current)
    if (rootMenu.current) {
      observer?.observe(rootMenu.current)
      for (const child of rootMenu.current.querySelectorAll<HTMLElement>('.file-submenu'))
        observer?.observe(child)
    }
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
    }
  }, [open, items, path])
  // Scripted focus can inherit an input's focus-visible state, and native
  // dialogs can restore it. Keep pointer styling until actual keyboard input.
  useEffect(() => {
    if (!pointerFocus) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) setPointerFocus(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [pointerFocus])
  const buttons = (menu: Element) =>
    [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
      (button) => button.closest('[role="menu"]') === menu,
    )
  useLayoutEffect(() => {
    if (!open) {
      setPath([])
      return
    }
    const entries = rootMenu.current && buttons(rootMenu.current)
    const target = focusLast.current ? entries?.at(-1) : entries?.[0]
    ;(target ?? rootMenu.current)?.focus()
    focusLast.current = false
  }, [open])
  useLayoutEffect(() => {
    if (!focusMenu.current) return
    const menu = document.getElementById(focusMenu.current)
    if (menu) (buttons(menu)[0] ?? (menu as HTMLElement)).focus()
    focusMenu.current = null
  }, [path])
  useLayoutEffect(() => {
    const menu = rootMenu.current
    if (!open || !menu) return
    const active = document.activeElement
    if (active && menu.contains(active)) return
    ;(buttons(menu)[0] ?? menu).focus()
  }, [items, open, canExecute])
  const close = () => {
    onOpenChange(false)
    trigger.current?.focus()
  }
  const visible = (item: DocsFileMenuItem): boolean =>
    item.visible !== false && (!('items' in item) || item.items.some(visible))
  const renderItems = (nodes: readonly DocsFileMenuItem[], depth: number, parentDisabled = false) =>
    nodes.filter(visible).map((item) => {
      const disabled =
        parentDisabled ||
        item.enabled === false ||
        (item.type === 'command' && !canExecute(item.command))
      if (item.type === 'group')
        return (
          <div role="group" aria-label={item.label} className="file-menu-group" key={item.id}>
            {item.label && <div className="file-menu-group-label">{item.label}</div>}
            {renderItems(item.items, depth, disabled)}
          </div>
        )
      const submenu = item.type === 'submenu'
      const expanded = submenu && path[depth] === item.id
      const childId = `${menuId}-${Array.from(item.id, (character) => character.codePointAt(0)!.toString(16)).join('-')}`
      const expand = (focus: boolean) => {
        if (disabled || !submenu) return
        if (focus) focusMenu.current = childId
        setPath((previous) => [...previous.slice(0, depth), item.id])
      }
      const text = item.label ?? (item.type === 'command' ? commandLabel(item.command) : '')
      const shortcut =
        item.type === 'command'
          ? (
              { open: 'O', save: 'S', saveAs: 'Shift+S', new: 'N' } as Partial<
                Record<DocsFileMenuCommand, string>
              >
            )[item.command]
          : undefined
      return (
        <div className="file-menu-entry" key={item.id}>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={disabled}
            className={itemClassName?.(item.id)}
            aria-haspopup={submenu ? 'menu' : undefined}
            aria-expanded={submenu ? expanded : undefined}
            aria-controls={submenu ? childId : undefined}
            onMouseEnter={() => {
              if (submenu) expand(false)
              else setPath((previous) => previous.slice(0, depth))
            }}
            onKeyDown={(event) => {
              const forward = document.documentElement.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
              if (
                submenu &&
                (event.key === forward || event.key === 'Enter' || event.key === ' ')
              ) {
                event.preventDefault()
                event.stopPropagation()
                expand(true)
              }
            }}
            onClick={() => {
              if (disabled) return
              if (submenu) expand(true)
              else {
                close()
                onInvoke(item.id)
              }
            }}
          >
            {text}
            {submenu ? (
              <span aria-hidden="true">{document.documentElement.dir === 'rtl' ? '‹' : '›'}</span>
            ) : (
              shortcut && (
                <span className="file-menu-key">
                  {navigator.platform.toLowerCase().includes('mac') ? '⌘+' : 'Ctrl+'}
                  {shortcut}
                </span>
              )
            )}
          </button>
          {expanded && (
            <div
              id={childId}
              role="menu"
              tabIndex={-1}
              aria-label={text}
              className="file-menu file-submenu"
              onKeyDown={(event) => navigate(event, depth + 1)}
            >
              {renderItems(item.items, depth + 1, disabled)}
            </div>
          )}
        </div>
      )
    })
  const navigate = (event: KeyboardEvent<HTMLDivElement>, depth: number) => {
    const menu = event.currentTarget
    if ((event.target as HTMLElement).closest('[role="menu"]') !== menu) return
    const entries = buttons(menu)
    const index = entries.indexOf(document.activeElement as HTMLButtonElement)
    const backward = document.documentElement.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    if (event.key === 'Tab') {
      onOpenChange(false)
      return
    }
    if (event.key === 'Escape' || (depth > 0 && event.key === backward)) {
      event.preventDefault()
      event.stopPropagation()
      if (!depth) close()
      else {
        ;(menu.parentElement?.querySelector('[aria-haspopup="menu"]') as HTMLElement)?.focus()
        setPath((previous) => previous.slice(0, depth - 1))
      }
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? entries.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
      entries[next]?.focus()
    } else if (
      (event.key === 'Enter' || event.key === ' ') &&
      document.activeElement instanceof HTMLButtonElement
    ) {
      event.preventDefault()
      event.stopPropagation()
      document.activeElement.click()
    }
  }
  return (
    <div
      className={`file-tab-wrap native-action-menu${className ? ` ${className}` : ''}`}
      data-pointer-focus={pointerFocus || undefined}
      onPointerDownCapture={() => setPointerFocus(true)}
    >
      <button
        ref={trigger}
        type="button"
        className={`${buttonClassName ?? 'ribbon-tab ribbon-tab-file'} ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-label={label}
        data-tip={tooltip}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (disabled) return
          if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault()
            focusLast.current = event.key === 'ArrowUp'
            onOpenChange(true)
          }
        }}
      >
        {buttonContent ?? label}
      </button>
      {open && (
        <div
          ref={rootMenu}
          id={menuId}
          data-rb-panel=""
          role="menu"
          tabIndex={-1}
          aria-label={label}
          className="file-menu"
          onKeyDown={(event) => navigate(event, 0)}
        >
          {renderItems(items, 0, disabled)}
        </div>
      )}
    </div>
  )
}
