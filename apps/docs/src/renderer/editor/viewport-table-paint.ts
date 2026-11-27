import type { EditorView } from '@tiptap/pm/view'
import {
  boxInCanvas,
  intersectsViewport,
  type LayoutBox,
  type ViewportBounds,
} from './viewport-fragments'

interface PaintStyle {
  style: string
  className?: string
  attributes?: Record<string, string>
}

interface InlinePaint extends PaintStyle {
  tag:
    | 'a'
    | 'b'
    | 'br'
    | 'del'
    | 'em'
    | 'i'
    | 'ins'
    | 's'
    | 'small'
    | 'span'
    | 'strong'
    | 'sub'
    | 'sup'
    | 'u'
    | 'div'
  children: (InlinePaint | string)[]
}

interface TablePaintBox {
  box: LayoutBox
  style: string
}

interface TableParagraphPaint extends TablePaintBox, PaintStyle {
  position?: number
  children: (InlinePaint | string)[]
}

export interface TablePaint {
  position: number
  clip: LayoutBox
  cells: TablePaintBox[]
  edges?: TablePaintBox[]
  paragraphs: TableParagraphPaint[]
}

const inlineTags = new Set<string>([
  'a',
  'b',
  'br',
  'del',
  'em',
  'i',
  'ins',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'u',
])

const cellStyle = ['background-color', 'border-top', 'border-right', 'border-bottom', 'border-left']
const sides = ['top', 'right', 'bottom', 'left'] as const
const textLayoutStyle =
  /^(font|color$|background-color$|line-height$|direction$|unicode-bidi$|writing-mode$|text-|word-|letter-spacing$|white-space|display$|vertical-align$|position$|inset-|top$|left$|right$|bottom$|float$|clear$|transform$|clip-path$|padding-|margin-|border-|box-sizing$|width$|height$|min-|max-|overflow|visibility$|--)/

function paintStyle(style: CSSStyleDeclaration, properties: readonly string[]): string {
  return properties.map((property) => `${property}:${style.getPropertyValue(property)}`).join(';')
}

function captureStyle(element: Element, style: CSSStyleDeclaration): PaintStyle {
  const attributes = Object.fromEntries(
    Array.from(element.attributes)
      .filter(({ name }) => name.startsWith('data-') || name === 'lang' || name === 'dir')
      .map(({ name, value }) => [name, value]),
  )
  return {
    style: paintStyle(
      style,
      Array.from(style).filter((name) => textLayoutStyle.test(name)),
    ),
    className: element.getAttribute('class') ?? undefined,
    attributes,
  }
}

function hasBorder(style: CSSStyleDeclaration): boolean {
  return sides.some((side) => style.getPropertyValue(`border-${side}-style`) !== 'none')
}

function isPlainLayer(style: CSSStyleDeclaration): boolean {
  return (
    !hasBorder(style) &&
    style.backgroundColor === 'rgba(0, 0, 0, 0)' &&
    style.backgroundImage === 'none'
  )
}

function collapseUniformEdges(cells: readonly { box: LayoutBox; style: CSSStyleDeclaration }[]) {
  let sharedColor: string | undefined
  const edges: TablePaintBox[] = []
  for (const { box, style } of cells) {
    for (const side of sides) {
      const kind = style.getPropertyValue(`border-${side}-style`)
      if (kind === 'none') continue
      const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`))
      const color = style.getPropertyValue(`border-${side}-color`)
      // Opaque solid edges of one color share the native grid line. Their
      // union paints the widest of coincident edges. Other conflicts need
      // the complete browser border resolution.
      if (kind !== 'solid' || !(width > 0) || !color.startsWith('rgb(')) return
      if (sharedColor !== undefined && sharedColor !== color) return
      sharedColor = color
      const horizontal = side === 'top' || side === 'bottom'
      const edge: LayoutBox = {
        left: box.left + (side === 'right' ? box.width : 0) - width / 2,
        top: box.top + (side === 'bottom' ? box.height : 0) - width / 2,
        width: horizontal ? box.width + width : width,
        height: horizontal ? width : box.height + width,
      }
      edges.push({ box: edge, style: `background-color:${color}` })
    }
  }
  return edges
}

function captureInline(parent: Element): (InlinePaint | string)[] | undefined {
  const children: (InlinePaint | string)[] = []
  for (const node of parent.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      children.push(node.textContent ?? '')
      continue
    }
    if (
      node instanceof HTMLElement &&
      node.matches('.page-gap-inline, .page-gap-cut') &&
      node.childNodes.length === 0
    ) {
      // Retain the native inline flow spacer and its CSS-painted band.
      children.push({
        tag: 'div',
        className: node.className,
        style: node.style.cssText,
        children: [],
      })
      continue
    }
    if (!(node instanceof HTMLElement) || !inlineTags.has(node.localName)) return
    const style = getComputedStyle(node)
    if (style.display === 'none') continue
    if (style.display !== 'inline' || style.position !== 'static' || style.float !== 'none') return
    const nested = captureInline(node)
    if (!nested) return
    children.push({
      tag: node.localName as InlinePaint['tag'],
      ...captureStyle(node, style),
      children: nested,
    })
  }
  return children
}

interface IndexedCell {
  row: HTMLTableRowElement
  element?: HTMLTableCellElement
  box: LayoutBox
  through: number
}

interface TableIndex {
  bounds: LayoutBox
  collapsed: boolean
  cells: IndexedCell[]
}

function indexTable(
  table: HTMLTableElement,
  canvas: DOMRectReadOnly,
  scale: number,
): TableIndex | undefined {
  const style = getComputedStyle(table)
  if (!isPlainLayer(style)) return
  const groups = table.querySelectorAll(
    ':scope > colgroup, :scope > colgroup > col, :scope > tbody, :scope > thead, :scope > tfoot',
  )
  if (Array.from(groups).some((group) => !isPlainLayer(getComputedStyle(group)))) return
  const bounds = boxInCanvas(table.getBoundingClientRect(), canvas, scale)
  const cells: IndexedCell[] = []
  for (const row of table.rows) {
    if (row.classList.contains('page-gap-table')) {
      const box = boxInCanvas(row.getBoundingClientRect(), canvas, scale)
      cells.push({ row, box, through: box.top + box.height })
      continue
    }
    for (const element of row.cells) {
      const box = boxInCanvas(element.getBoundingClientRect(), canvas, scale)
      if (box.width > 0 && box.height > 0)
        cells.push({ row, element, box, through: box.top + box.height })
    }
  }
  cells.sort((a, b) => a.box.top - b.box.top)
  for (let index = 1; index < cells.length; index++)
    cells[index].through = Math.max(cells[index].through, cells[index - 1].through)
  return { bounds, collapsed: style.borderCollapse === 'collapse', cells }
}

/** The index lives for one layout publication. Repeated reveals only read
 * the DOM descendants of cells that can contribute ink to this window. */
export function tablePaintReader(view: EditorView) {
  const indices = new Map<number, TableIndex | undefined>()
  return (
    position: number,
    viewport: ViewportBounds,
    canvas: DOMRectReadOnly,
    scale: number,
  ): TablePaint | undefined => {
    if (!indices.has(position)) {
      const table = view.nodeDOM(position)
      indices.set(
        position,
        table instanceof HTMLTableElement ? indexTable(table, canvas, scale) : undefined,
      )
    }
    const indexed = indices.get(position)
    if (indexed) return measureTablePaint(view, indexed, position, viewport, canvas, scale)
  }
}

function measureTablePaint(
  view: EditorView,
  indexed: TableIndex,
  position: number,
  viewport: ViewportBounds,
  canvas: DOMRectReadOnly,
  scale: number,
): TablePaint | undefined {
  const { bounds, collapsed } = indexed
  const top = Math.max(viewport.top, bounds.top)
  const bottom = Math.min(viewport.bottom, bounds.top + bounds.height)
  if (bottom <= top || bounds.width <= 0) return
  const clip = { left: 0, width: canvas.width / scale, top, height: bottom - top }
  const cells: TablePaintBox[] = []
  const measuredCells: Array<{ box: LayoutBox; style: CSSStyleDeclaration }> = []
  const paragraphs: TableParagraphPaint[] = []
  let first = 0
  let last = indexed.cells.length
  while (first < last) {
    const middle = (first + last) >>> 1
    if (indexed.cells[middle].through > viewport.top) last = middle
    else first = middle + 1
  }
  for (let i = first; i < indexed.cells.length; i++) {
    const { row, element: cell, box } = indexed.cells[i]
    if (box.top >= viewport.bottom) break
    if (!intersectsViewport(box, viewport)) continue
    if (!cell || !isPlainLayer(getComputedStyle(row))) return
    const style = getComputedStyle(cell)
    if (style.backgroundImage !== 'none' || cell.hasAttribute('data-cell-clip')) return
    cells.push({ box, style: paintStyle(style, collapsed ? ['background-color'] : cellStyle) })
    if (collapsed) measuredCells.push({ box, style })
    for (const block of cell.children) {
      const rect = boxInCanvas(block.getBoundingClientRect(), canvas, scale)
      if (!intersectsViewport(rect, viewport) || rect.width <= 0) continue
      if (block.localName !== 'p') return
      const blockStyle = getComputedStyle(block)
      if (
        blockStyle.writingMode !== 'horizontal-tb' ||
        blockStyle.backgroundImage !== 'none' ||
        blockStyle.transform !== 'none'
      )
        return
      if (blockStyle.visibility !== 'visible') continue
      const children = captureInline(block)
      if (!children) return
      const authored = row.classList.contains('page-repeat-header')
        ? undefined
        : view.state.doc.resolve(view.posAtDOM(block, 0))
      const at =
        authored?.depth === 4 && view.nodeDOM(authored.before()) === block
          ? authored.before()
          : undefined
      paragraphs.push({
        box: rect,
        ...captureStyle(block, blockStyle),
        position: at,
        children,
      })
    }
  }
  if (!cells.length) return
  const edges = collapsed ? collapseUniformEdges(measuredCells) : []
  if (!edges) return
  return { position, clip, cells, ...(edges.length ? { edges } : {}), paragraphs }
}

function positionBox(element: HTMLElement, rect: LayoutBox, origin: LayoutBox): void {
  const style = {
    position: 'absolute',
    'box-sizing': 'border-box',
    margin: '0',
    left: `${rect.left - origin.left}px`,
    top: `${rect.top - origin.top}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    'max-width': 'none',
    'min-width': '0',
    'max-height': 'none',
    'min-height': '0',
    transform: 'none',
  }
  for (const [key, value] of Object.entries(style))
    element.style.setProperty(key, value, 'important')
}

function applyPaintStyle(element: HTMLElement, paint: PaintStyle): void {
  element.style.cssText = paint.style
  if (paint.className) element.className = paint.className
  for (const [name, value] of Object.entries(paint.attributes ?? {}))
    element.setAttribute(name, value)
}

export function renderTablePaint(
  document: Document,
  paint: TablePaint,
  hiddenPosition: number,
  table: LayoutBox,
): HTMLElement {
  const root = document.createElement('div')
  const clip = document.createElement('div')
  clip.style.overflow = 'hidden'
  positionBox(clip, paint.clip, table)
  const render = (parent: HTMLElement, children: readonly (InlinePaint | string)[]) => {
    for (const node of children) {
      if (typeof node === 'string') parent.append(node)
      else {
        const element = document.createElement(node.tag)
        applyPaintStyle(element, node)
        render(element, node.children)
        parent.append(element)
      }
    }
  }
  for (const item of [...paint.cells, ...(paint.edges ?? [])]) {
    const cell = document.createElement('div')
    cell.style.cssText = item.style
    positionBox(cell, item.box, paint.clip)
    clip.append(cell)
  }
  for (const item of paint.paragraphs) {
    if (item.position === hiddenPosition) continue
    const paragraph = document.createElement('p')
    applyPaintStyle(paragraph, item)
    positionBox(paragraph, item.box, paint.clip)
    render(paragraph, item.children)
    clip.append(paragraph)
  }
  root.append(clip)
  return root
}
