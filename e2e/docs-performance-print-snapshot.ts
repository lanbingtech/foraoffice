import type { createPrintSourceDiagnostic } from '../apps/docs/src/renderer/print-source-diagnostic'
import type { createDocumentStoryDiagnostic } from '../apps/docs/src/renderer/document-story-diagnostic'
import type { PdfRect, PdfSourceSnapshot } from './docs-performance-pdf'

/** Serialized into the real preview after timing. Coordinates are print CSS px converted to PDF points. */
export function capturePrintSourceSnapshot() {
  const win = window as Window & {
    __previewDebug?: { sourceCells?: ReturnType<typeof createPrintSourceDiagnostic> }
    __pageDebug?: { sourceStories?: ReturnType<typeof createDocumentStoryDiagnostic>['snapshot'] }
  }
  const source = win.__previewDebug?.sourceCells?.()
  const bindings = win.__pageDebug?.sourceStories?.()
  if (
    !source ||
    source.version !== 1 ||
    source.disposed ||
    !source.modelCurrent ||
    !bindings ||
    bindings.version !== 1 ||
    bindings.disposed
  )
    throw new Error('Current print source diagnostics are missing or disposed')
  if (!matchMedia('print').matches || devicePixelRatio !== 1)
    throw new Error('Positioned PDF proof requires recorded print media and DPR1')
  const root = document.querySelector<HTMLElement>('.pagination-preview')
  if (!root || Number(getComputedStyle(root).zoom || '1') !== 1)
    throw new Error('Positioned PDF proof requires unscaled print preview')
  const snapshot: PdfSourceSnapshot = { pages: [], regions: [] }
  const pageSections: number[] = []
  const intersect = (a: PdfRect, b: PdfRect): PdfRect | null => {
    const x = Math.max(a.x, b.x),
      y = Math.max(a.y, b.y)
    const right = Math.min(a.x + a.width, b.x + b.width)
    const bottom = Math.min(a.y + a.height, b.y + b.height)
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
  }
  const box = (element: Element): PdfRect => {
    const r = element.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }
  const pages = [...root.querySelectorAll<HTMLElement>('.pv-page')]
  pages.forEach((paper, page) => {
    const section = paper.dataset.pvSection
    if (section === undefined || !/^\d+$/.test(section))
      throw new Error('Print section identity is missing')
    pageSections.push(Number(section))
    const origin = box(paper)
    const width = parseFloat(paper.style.width),
      height = parseFloat(paper.style.height)
    // Qt print-media trial:793.733px authored→793.71875px layout (0.01425px quantization).
    if (!(width > 0 && height > 0) || Math.abs(origin.width - width) > 0.02)
      throw new Error('Authored print paper geometry is missing or scaled')
    snapshot.pages.push({ width: width * 0.75, height: height * 0.75 })
    const visible = (
      element: HTMLElement,
      horizontal?: Pick<PdfRect, 'x' | 'width'>,
    ): PdfRect | null => {
      const measured = box(element)
      let rect: PdfRect | null = intersect(
        horizontal ? { ...measured, x: horizontal.x, width: horizontal.width } : measured,
        origin,
      )
      for (
        let ancestor: HTMLElement | null = element;
        rect && ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor)
        if (style.display === 'none' || style.visibility === 'hidden') return null
        const bounds = box(ancestor)
        if (style.clipPath !== 'none' && style.clipPath) {
          const match = /^inset\(([^)]+)\)$/.exec(style.clipPath)
          const values = match?.[1]
            .split(/\s+/)
            .map((value) => (/^-?\d*\.?\d+(?:px)?$/.test(value) ? parseFloat(value) : NaN))
          if (
            !values ||
            values.length < 1 ||
            values.length > 4 ||
            values.some((v) => !Number.isFinite(v))
          )
            throw new Error('Unsupported visible print clip-path; source ownership is ambiguous')
          const [top, right = top, bottom = top, left = right] = values
          rect = intersect(rect, {
            x: bounds.x + left,
            y: bounds.y + top,
            width: bounds.width - left - right,
            height: bounds.height - top - bottom,
          })
        }
        if (
          rect &&
          (ancestor !== element || horizontal !== undefined) &&
          /hidden|clip|auto|scroll/.test(style.overflowX + style.overflowY)
        )
          rect = intersect(rect, bounds)
        if (ancestor === paper) break
      }
      return rect
    }
    const add = (element: HTMLElement, owner: string, role: 'body' | 'repeat') => {
      const clip = owner === 'body' ? element.closest<HTMLElement>('.pv-clip') : null
      if (owner === 'body' && !clip) throw new Error('Printed body clip geometry is missing')
      // The paper clip also paints hanging CJK punctuation in the side margins.
      const bounds = clip ? visible(clip) : undefined
      if (bounds === null) return
      const rect = visible(element, bounds)
      if (!rect) return
      snapshot.regions.push({
        page,
        owner,
        role,
        rect: {
          x: (rect.x - origin.x) * 0.75,
          y: (rect.y - origin.y) * 0.75,
          width: rect.width * 0.75,
          height: rect.height * 0.75,
        },
      })
    }
    for (const content of paper.querySelectorAll<HTMLElement>('.pv-content')) {
      const role = content.hasAttribute('data-pv-body') ? 'body' : 'repeat'
      if (role === 'body') add(content, 'body', role)
      // Prune spacers carry no source identity or text. Inspect only actual native tables.
      for (const table of content.querySelectorAll<HTMLElement>('table.doc-table[data-idx]')) {
        if (!visible(table)) continue
        const native = source.tables.find(
          (candidate) => String(candidate.docxIndex) === table.dataset.idx,
        )
        if (!native?.sourceTable)
          throw new Error('Printed table has no exact model source identity')
        const rows = [...table.querySelectorAll<HTMLElement>('tr')].filter(
          (row) => row.closest('table') === table,
        )
        if (rows.length !== native.rows.length)
          throw new Error('Printed/source table row topology differs')
        rows.forEach((row, index) => {
          if (!visible(row)) return
          const cells = [...row.children].filter((cell) => cell.matches('td,th')) as HTMLElement[]
          if (cells.length !== native.rows[index].cells.length)
            throw new Error('Printed/source table cell topology differs')
          cells.forEach((cell, c) => {
            if (!visible(cell)) return
            const identity = native.rows[index].cells[c].sourceCell
            if (!identity || identity.table !== native.sourceTable)
              throw new Error('Printed cell source identity is unknown')
            const owner = `${identity.table}:${identity.row}:${identity.cell}`
            for (const child of cell.children) add(child as HTMLElement, owner, role)
          })
        })
      }
    }
    for (const textbox of paper.querySelectorAll<HTMLElement>('.doc-textbox')) {
      if (!textbox.textContent?.trim() || textbox.closest('.page-hf')) continue
      const index = textbox.closest<HTMLElement>('[data-idx]')?.dataset.idx
      const ordinal = textbox.dataset.sourceTxbxIndex
      if (!index || !/^\d+$/.test(index) || ordinal === undefined || !/^\d+$/.test(ordinal))
        throw new Error('Printed textbox source identity is unknown')
      add(textbox, `box:${index}:${ordinal}`, 'body')
    }
    for (const kind of ['header', 'footer'] as const)
      for (const area of paper.querySelectorAll<HTMLElement>(`.page-hf-${kind}`)) {
        const owner = `hf:${page}:${kind}`
        add(area, owner, 'body')
        // Anchored HF paragraphs can extend beyond the strip's normal-flow box.
        for (const paragraph of area.querySelectorAll<HTMLElement>('.page-hf-para'))
          add(paragraph, owner, 'body')
      }
  })
  return {
    snapshot,
    pageSections,
    source,
    bindings,
    conditions: { media: 'print', devicePixelRatio, cssPxToPoints: 0.75 },
  }
}
