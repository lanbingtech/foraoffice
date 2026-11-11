import { z } from 'zod'
import type { DocsDocumentState } from '../../shared/document-host'

/** Stable native tab IDs, independent of translated display labels. */
export const DOCS_RIBBON_BUILTIN_TABS = [
  'home',
  'insert',
  'draw',
  'design',
  'layout',
  'references',
  'mailings',
  'review',
  'view',
  'tableDesign',
  'tableLayout',
  'pictureFormat',
  'shapeFormat',
  'headerFooter',
] as const
export type DocsRibbonBuiltinTab = (typeof DOCS_RIBBON_BUILTIN_TABS)[number]

interface Presentation {
  id: string
  label: string
  visible?: boolean
  enabled?: boolean
}
export type DocsRibbonMenuItem = Presentation &
  (
    | { type: 'action'; actionId: string }
    | { type: 'group' | 'submenu'; items: DocsRibbonMenuItem[] }
  )
export type DocsRibbonControl = Presentation & {
  /** Raster data URL; never loaded from a remote host or evaluated as markup. */
  icon?: string
  tooltip?: string
} & ({ type: 'button'; actionId: string } | { type: 'menu'; items: DocsRibbonMenuItem[] })
export interface DocsRibbonGroup extends Presentation {
  items: DocsRibbonControl[]
}
export interface DocsRibbonTab extends Presentation {
  groups: DocsRibbonGroup[]
}
export interface DocsRibbonGroupExtension extends DocsRibbonGroup {
  tabId: DocsRibbonBuiltinTab
}
export interface DocsRibbonConfiguration {
  documentToken: string | null
  tabs?: DocsRibbonTab[]
  groups?: DocsRibbonGroupExtension[]
  quickAccess?: DocsRibbonControl[]
}
export interface DocsRibbonAction {
  itemId: string
  actionId: string
  location: 'tab' | 'quickAccess'
  tabId: string | null
  groupId: string | null
  documentToken: string | null
  document: DocsDocumentState | null
}
export interface DocsRibbon {
  /** Atomically replace this document session's contributions; built-ins are preserved. */
  set(configuration: DocsRibbonConfiguration): void
  reset(): void
  onAction(listener: (event: DocsRibbonAction) => void): () => void
}

const id = z.string().min(1).max(128)
const label = z.string().min(1).max(256)
const presentation = { id, label, visible: z.boolean().optional(), enabled: z.boolean().optional() }
const menuItem: z.ZodType<DocsRibbonMenuItem> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ ...presentation, type: z.literal('action'), actionId: id }).strict(),
    z.object({ ...presentation, type: z.literal('group'), items: z.array(menuItem) }).strict(),
    z.object({ ...presentation, type: z.literal('submenu'), items: z.array(menuItem) }).strict(),
  ]),
)
const controlPresentation = {
  ...presentation,
  icon: z
    .string()
    .max(131072)
    .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
    .optional(),
  tooltip: z.string().max(1024).optional(),
}
const control = z.discriminatedUnion('type', [
  z.object({ ...controlPresentation, type: z.literal('button'), actionId: id }).strict(),
  z.object({ ...controlPresentation, type: z.literal('menu'), items: z.array(menuItem) }).strict(),
])
const group = z.object({ ...presentation, items: z.array(control) }).strict()
const configurationSchema = z
  .object({
    documentToken: z.string().min(1).nullable(),
    tabs: z.array(z.object({ ...presentation, groups: z.array(group) }).strict()).optional(),
    groups: z.array(group.extend({ tabId: z.enum(DOCS_RIBBON_BUILTIN_TABS) })).optional(),
    quickAccess: z.array(control).optional(),
  })
  .strict()

export function parseDocsRibbon(input: unknown): DocsRibbonConfiguration {
  const ids = new Set<string>()
  let count = 0
  const visit = (value: unknown, depth: number) => {
    if (depth > 8) throw new Error('Ribbon nesting exceeds 8 levels')
    if (!value || typeof value !== 'object') return
    if (depth > 0 && ++count > 512) throw new Error('Ribbon exceeds 512 nodes')
    const node = value as Record<string, unknown>
    if (typeof node.id === 'string') {
      if (ids.has(node.id)) throw new Error(`Duplicate ribbon ID: ${node.id}`)
      ids.add(node.id)
    }
    for (const key of ['tabs', 'groups', 'items', 'quickAccess']) {
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child, depth + 1)
    }
  }
  visit(input, 0)
  const parsed = configurationSchema.parse(input)
  for (const tab of parsed.tabs ?? []) {
    if (tab.id === 'file' || DOCS_RIBBON_BUILTIN_TABS.some((id) => id === tab.id))
      throw new Error(`Reserved ribbon tab ID: ${tab.id}`)
  }
  return parsed
}

export function createDocsRibbon(current: () => DocsDocumentState | null) {
  let disposed = false
  let configuration: DocsRibbonConfiguration | null = null
  const views = new Set<() => void>()
  const actions = new Set<(event: DocsRibbonAction) => void>()
  const assertLive = () => {
    if (disposed) throw new Error('The ribbon is disposed')
  }
  const emit = () => {
    for (const listener of views) listener()
  }
  const refresh = () => {
    if (disposed || !configuration) return
    const rendered = configuration
    const token = current()?.documentToken ?? null
    if (configuration === rendered && rendered.documentToken !== token) {
      configuration = null
      emit()
    }
  }
  const available = (node: { visible?: boolean; enabled?: boolean }) =>
    node.visible !== false && node.enabled !== false
  return {
    set(input: DocsRibbonConfiguration) {
      assertLive()
      const parsed = parseDocsRibbon(input)
      if (parsed.documentToken !== (current()?.documentToken ?? null))
        throw new Error('The ribbon document token is stale')
      configuration = parsed
      emit()
    },
    reset() {
      assertLive()
      configuration = null
      emit()
    },
    onAction(listener: (event: DocsRibbonAction) => void) {
      assertLive()
      actions.add(listener)
      return () => {
        actions.delete(listener)
      }
    },
    subscribe(listener: () => void) {
      assertLive()
      views.add(listener)
      return () => {
        views.delete(listener)
      }
    },
    snapshot: () => configuration,
    refresh,
    activate(itemId: string, rendered: DocsRibbonConfiguration) {
      assertLive()
      refresh()
      if (rendered !== configuration) throw new Error('The ribbon action is stale')
      const document = current()
      if (
        rendered !== configuration ||
        rendered.documentToken !== (document?.documentToken ?? null)
      )
        throw new Error('The ribbon action is stale')
      let target: { actionId: string; tabId: string | null; groupId: string | null } | undefined
      const find = (
        nodes: readonly (DocsRibbonControl | DocsRibbonMenuItem)[],
        tabId: string | null,
        groupId: string | null,
      ) => {
        for (const node of nodes) {
          if (!available(node)) continue
          if (node.id === itemId && 'actionId' in node)
            target = { actionId: node.actionId, tabId, groupId }
          if ('items' in node) find(node.items, tabId, groupId)
        }
      }
      for (const tab of rendered.tabs ?? []) {
        if (!available(tab)) continue
        for (const group of tab.groups) if (available(group)) find(group.items, tab.id, group.id)
      }
      for (const group of rendered.groups ?? [])
        if (available(group)) find(group.items, group.tabId, group.id)
      find(rendered.quickAccess ?? [], null, null)
      if (!target) throw new Error('The ribbon action is unavailable')
      const event: DocsRibbonAction = {
        itemId,
        ...target,
        location: target.tabId === null ? 'quickAccess' : 'tab',
        documentToken: rendered.documentToken,
        document: document && { ...document },
      }
      for (const listener of actions)
        listener({ ...event, document: event.document && { ...event.document } })
    },
    dispose() {
      disposed = true
      configuration = null
      views.clear()
      actions.clear()
    },
  }
}
