import { z } from 'zod'
import type { DocsDocumentState } from '../../shared/document-host'

export const DOCS_FILE_MENU_COMMANDS = [
  'new',
  'open',
  'save',
  'saveAs',
  'exportPdf',
  'exportHtml',
  'exportMarkdown',
  'exportImages',
] as const
export type DocsFileMenuCommand = (typeof DOCS_FILE_MENU_COMMANDS)[number]

interface MenuPresentation {
  id: string
  label?: string
  visible?: boolean
  enabled?: boolean
}
export type DocsFileMenuItem = MenuPresentation &
  (
    | { type: 'command'; command: DocsFileMenuCommand }
    | { type: 'action'; actionId: string; label: string }
    | { type: 'group'; items: DocsFileMenuItem[] }
    | { type: 'submenu'; label: string; items: DocsFileMenuItem[] }
  )
export interface DocsFileMenuConfiguration {
  /** null addresses an editor with no active document. */
  documentToken: string | null
  items: DocsFileMenuItem[]
}
export interface DocsFileMenuAction {
  itemId: string
  actionId: string
  documentToken: string | null
  document: DocsDocumentState | null
}
export interface DocsFileMenu {
  /** Atomically replace the menu for the current document session. */
  set(configuration: DocsFileMenuConfiguration): void
  reset(): void
  /** Instance-level subscription; each event carries its captured document context. */
  onAction(listener: (event: DocsFileMenuAction) => void): () => void
}
export interface DocsEditorUi {
  readonly fileMenu: DocsFileMenu
}

const id = z.string().min(1).max(128)
const label = z.string().min(1).max(256)
const presentation = {
  id,
  label: label.optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
}
const itemSchema: z.ZodType<DocsFileMenuItem> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        ...presentation,
        type: z.literal('command'),
        command: z.enum(DOCS_FILE_MENU_COMMANDS),
      })
      .strict(),
    z.object({ ...presentation, type: z.literal('action'), actionId: id, label }).strict(),
    z.object({ ...presentation, type: z.literal('group'), items: z.array(itemSchema) }).strict(),
    z
      .object({ ...presentation, type: z.literal('submenu'), label, items: z.array(itemSchema) })
      .strict(),
  ]),
)

/** Shared by direct SDK callers and native transports. Never accepts executable menu content. */
export function parseDocsFileMenu(input: unknown): DocsFileMenuConfiguration {
  // Bound recursion before passing nested input to the recursive schema.
  const ids = new Set<string>()
  let count = 0
  const check = (items: unknown, depth: number) => {
    if (!Array.isArray(items)) return
    if (depth > 8) throw new Error('File menu nesting exceeds 8 levels')
    for (const item of items) {
      if (++count > 256) throw new Error('File menu exceeds 256 items')
      if (!item || typeof item !== 'object') continue
      if (typeof item.id === 'string') {
        if (ids.has(item.id)) throw new Error(`Duplicate file menu item ID: ${item.id}`)
        ids.add(item.id)
      }
      check(item.items, depth + 1)
    }
  }
  check(input && typeof input === 'object' && 'items' in input ? input.items : undefined, 1)
  return z
    .object({ documentToken: z.string().min(1).nullable(), items: z.array(itemSchema) })
    .strict()
    .parse(input)
}

export function createDocsFileMenu(bindings: {
  current(): { generation: unknown; document: Omit<DocsDocumentState, 'documentToken'> | null }
  execute(command: DocsFileMenuCommand): unknown
  canExecute(command: DocsFileMenuCommand): boolean
}) {
  let disposed = false
  let generation: unknown = Symbol('uninitialized')
  let state: DocsDocumentState | null = null
  let items: DocsFileMenuItem[] | null = null
  const actions = new Set<(event: DocsFileMenuAction) => void>()
  const states = new Set<(state: DocsDocumentState | null) => void>()
  const views = new Set<() => void>()
  const assertLive = () => {
    if (disposed) throw new Error('The file menu is disposed')
  }
  const emitView = () => {
    for (const listener of views) listener()
  }
  const refresh = () => {
    if (disposed) return
    const current = bindings.current()
    const replaced = generation !== current.generation || state?.id !== current.document?.id
    generation = current.generation
    const next = current.document
      ? {
          ...current.document,
          documentToken: replaced || !state ? crypto.randomUUID() : state.documentToken,
        }
      : null
    const changed = JSON.stringify(next) !== JSON.stringify(state)
    state = next
    if (replaced && items !== null) {
      items = null
      emitView()
    }
    if (changed) for (const listener of states) listener(state && { ...state })
  }
  const token = () => state?.documentToken ?? null
  const assertToken = (expected: string | null) => {
    assertLive()
    refresh()
    if (expected !== token()) throw new Error('The file menu document token is stale')
  }
  return {
    set(configuration: DocsFileMenuConfiguration) {
      assertLive()
      const parsed = parseDocsFileMenu(configuration)
      assertToken(parsed.documentToken)
      items = parsed.items
      emitView()
    },
    reset() {
      assertLive()
      items = null
      emitView()
    },
    onAction(listener: (event: DocsFileMenuAction) => void) {
      assertLive()
      actions.add(listener)
      return () => {
        actions.delete(listener)
      }
    },
    documentState() {
      assertLive()
      refresh()
      return state && { ...state }
    },
    onDocumentStateChanged(listener: (value: DocsDocumentState | null) => void) {
      assertLive()
      refresh()
      states.add(listener)
      listener(state && { ...state })
      return () => {
        states.delete(listener)
      }
    },
    refresh,
    snapshot: () => items,
    currentToken: token,
    subscribe(listener: () => void) {
      assertLive()
      views.add(listener)
      return () => {
        views.delete(listener)
      }
    },
    isEnabled: (command: DocsFileMenuCommand) => !disposed && bindings.canExecute(command),
    async activate(itemId: string, documentToken: string | null) {
      assertToken(documentToken)
      const find = (nodes: DocsFileMenuItem[]): DocsFileMenuItem | undefined => {
        for (const node of nodes) {
          if (node.visible === false || node.enabled === false) continue
          if (node.id === itemId) return node
          if ('items' in node) {
            const found = find(node.items)
            if (found) return found
          }
        }
      }
      const item = find(items ?? [])
      if (
        !item ||
        'items' in item ||
        (item.type === 'command' && !bindings.canExecute(item.command))
      )
        throw new Error('The file menu action is unavailable')
      if (item.type === 'command') return await bindings.execute(item.command)
      const event = {
        itemId,
        actionId: item.actionId,
        documentToken,
        document: state && { ...state },
      }
      for (const listener of actions) listener(event)
    },
    dispose() {
      if (disposed) return
      disposed = true
      items = null
      state = null
      actions.clear()
      states.clear()
      views.clear()
    },
  }
}
