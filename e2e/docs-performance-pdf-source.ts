import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { mainStoryOracle } from './docs-performance-stories'

type Xml = Array<Record<string, unknown>>
interface SourceElement {
  local: string
  namespace: string
  scope: Record<string, string>
  attributes: Record<string, unknown>
  children: Xml
}
interface SourceTable {
  docxIndex: number | null
  sourceTable: string | null
  rows: Array<{
    rowIndex: number
    cells: Array<{
      gridGap: boolean
      sourceCell?: { table: string; row: number; cell: number } | null
    }>
  }>
}
const wml = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])
const parse = (xml: string): Xml =>
  new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    trimValues: false,
    parseTagValue: false,
  }).parse(xml) as Xml
const elements = (nodes: Xml, inherited: Record<string, string>): SourceElement[] =>
  nodes.flatMap((node) => {
    const scope = { ...inherited }
    const attributes = (node[':@'] ?? {}) as Record<string, unknown>
    for (const [name, value] of Object.entries(attributes)) {
      if (name === '@_xmlns') scope[''] = String(value)
      else if (name.startsWith('@_xmlns:')) scope[name.slice(8)] = String(value)
    }
    return Object.entries(node).flatMap(([name, value]) => {
      if (!Array.isArray(value) || name.startsWith('#')) return []
      const [prefix, local] = name.includes(':') ? name.split(':') : ['', name]
      return [{ local, namespace: scope[prefix] ?? '', scope, attributes, children: value as Xml }]
    })
  })
const children = (element: SourceElement, local: string) =>
  elements(element.children, element.scope).filter(
    (child) => wml.has(child.namespace) && child.local === local,
  )

/** Raw archive XML supplies text; model identity supplies only the source address, never expected text. */
export function sourcePrintChains(
  documentXml: string,
  tables: SourceTable[],
  bindings: Array<{ docxIndex: number | null; originalXml: string | null }>,
): Record<string, string> {
  const parsed = parse(documentXml)
  const body = (nodes: Xml, scope: Record<string, string>): SourceElement | undefined => {
    for (const element of elements(nodes, scope)) {
      if (wml.has(element.namespace) && element.local === 'body') return element
      const found = body(element.children, element.scope)
      if (found) return found
    }
  }
  const context = body(parsed, {})
  if (!context) throw new Error('Print source document body is missing')
  const tableCount = (nodes: Xml, scope: Record<string, string>): number =>
    elements(nodes, scope).reduce((count, element) => {
      if (wml.has(element.namespace) && element.local === 'txbxContent') return count
      if (
        element.namespace === 'http://schemas.openxmlformats.org/markup-compatibility/2006' &&
        element.local === 'Fallback'
      )
        return count
      return (
        count +
        (wml.has(element.namespace) && element.local === 'tbl'
          ? 1
          : tableCount(element.children, element.scope))
      )
    }, 0)
  if (tableCount(context.children, context.scope) !== tables.length)
    throw new Error('Source table coverage differs')
  const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false })
  const cellText = (cell: SourceElement) =>
    mainStoryOracle(
      builder.build([
        {
          source: cell.children,
          ':@': Object.fromEntries(
            Object.entries(cell.scope).map(([prefix, uri]) => [
              prefix ? `@_xmlns:${prefix}` : '@_xmlns',
              uri,
            ]),
          ),
        },
      ]),
      { allowEmpty: true },
    ).textRuns.join('')
  const continuation = (cell: SourceElement) => {
    const merge = children(cell, 'tcPr').flatMap((properties) => children(properties, 'vMerge'))[0]
    if (!merge) return false
    const value = Object.entries(merge.attributes).find(([name]) => {
      const [prefix, local] = name.slice(2).split(':')
      return local === 'val' && wml.has(merge.scope[prefix])
    })?.[1]
    if (value !== undefined && value !== 'continue' && value !== 'restart')
      throw new Error('Unsupported merge source value')
    return value !== 'restart'
  }
  const expected: Record<string, string> = {}
  let remaining = documentXml
  const seen = new Set<number>()
  for (const table of tables) {
    const binding = bindings.find((candidate) => candidate.docxIndex === table.docxIndex)
    const xml = binding?.originalXml
    if (!xml || !documentXml.includes(xml))
      throw new Error('Printed table source XML is not archived')
    if (table.docxIndex === null || !table.sourceTable || seen.has(table.docxIndex))
      throw new Error('Printed table source identity is missing or duplicated')
    seen.add(table.docxIndex)
    const roots = elements(parse(xml), context.scope)
    if (roots.length !== 1 || !wml.has(roots[0].namespace) || roots[0].local !== 'tbl')
      throw new Error('Unsupported wrapped table source mapping')
    const rows = children(roots[0], 'tr')
    if (rows.length !== table.rows.length) throw new Error('Source/model row counts differ')
    table.rows.forEach((row, r) => {
      if (row.rowIndex !== r) throw new Error('Source model row address differs')
      const cells = children(rows[r], 'tc'),
        mapped = new Set<number>()
      for (const cell of row.cells) {
        if (cell.gridGap) throw new Error('Unsupported grid-gap source mapping')
        const address = cell.sourceCell
        if (
          !address ||
          address.table !== table.sourceTable ||
          address.row !== r ||
          !Number.isInteger(address.cell) ||
          !cells[address.cell] ||
          mapped.has(address.cell)
        )
          throw new Error('Source cell address is missing or ambiguous')
        mapped.add(address.cell)
        expected[`${address.table}:${r}:${address.cell}`] = cellText(cells[address.cell])
      }
      cells.forEach((cell, c) => {
        if (mapped.has(c)) return
        if (!continuation(cell)) throw new Error('Unmapped source cell')
        if (cellText(cell))
          throw new Error('Nonempty hidden source cell requires explicit story policy')
      })
    })
    remaining = remaining.replace(xml, '')
  }
  expected.body = mainStoryOracle(remaining).textRuns.join('')
  return expected
}
