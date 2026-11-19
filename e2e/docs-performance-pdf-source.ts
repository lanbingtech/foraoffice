import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { mainStoryOracle, expectedTextboxStories } from './docs-performance-stories'

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
      colspan?: number
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
const wmlAttribute = (element: SourceElement, local: string) =>
  Object.entries(element.attributes).find(([name]) => {
    const [prefix, attribute] = name.slice(2).split(':')
    return attribute === local && wml.has(element.scope[prefix])
  })?.[1]

/** Raw archive XML supplies text; model identity supplies only the source address, never expected text. */
export function sourcePrintChains(
  documentXml: string,
  tables: SourceTable[],
  bindings: Array<{ docxIndex: number | null; originalXml: string | null; textboxes?: unknown[] }>,
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
      const edge = (local: string) => {
        const node = children(rows[r], 'trPr').flatMap((pr) => children(pr, local))[0]
        if (!node) return 0
        const value = Number(wmlAttribute(node, 'val'))
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid authored grid edge')
        return value
      }
      const before = edge('gridBefore'),
        after = edge('gridAfter')
      // parse.ts inserts one placeholder slot per authored edge, even for multiple columns.
      const offset = before > 0 ? 1 : 0
      const addresses = new Set<number>()
      const edges = new Set<number>()
      for (const cell of row.cells) {
        const address = cell.sourceCell
        if (
          !address ||
          address.table !== table.sourceTable ||
          address.row !== r ||
          !Number.isInteger(address.cell) ||
          addresses.has(address.cell)
        )
          throw new Error('Source cell address is missing or ambiguous')
        addresses.add(address.cell)
        const edgeColumns =
          address.cell === 0 && before > 0
            ? before
            : address.cell === cells.length + offset && after > 0
              ? after
              : 0
        if (edgeColumns) {
          if (!cell.gridGap || (cell.colspan ?? 1) !== edgeColumns)
            throw new Error('Authored grid edge differs from model placeholder')
          edges.add(address.cell)
          continue
        }
        const ordinal = address.cell - offset
        const raw = cells[ordinal]
        if (!raw || mapped.has(ordinal))
          throw new Error('Source cell address is missing or ambiguous')
        if (cell.gridGap) {
          if (!continuation(raw) || cellText(raw))
            throw new Error('Unsupported grid-gap source mapping')
        } else expected[`${address.table}:${r}:${address.cell}`] = cellText(raw)
        mapped.add(ordinal)
      }
      if ((before > 0 && !edges.has(0)) || (after > 0 && !edges.has(cells.length + offset)))
        throw new Error('Authored grid edge placeholder is missing')
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
  for (const story of expectedTextboxStories(
    documentXml,
    bindings.filter((block) => block.textboxes?.length),
  ))
    expected[`box:${story.docxIndex}:${story.txbxIndex}`] = story.text
  return expected
}

/** Narrow independent HF contract exercised by the supplied fixture: default
 * inherited parts and decimal PAGE. ECMA-376-1:2016 §§17.10/17.6.12/17.16.5.44.
 * Other variants/field modes remain explicit unsupported conditions. */
export function sourceHeaderFooterChains(
  documentXml: string,
  settingsXml: string,
  relationshipsXml: string,
  parts: Record<string, string>,
  pageSections: number[],
): Record<string, string> {
  const descendants = (nodes: Xml, scope: Record<string, string>): SourceElement[] =>
    elements(nodes, scope).flatMap((element) => [
      element,
      ...descendants(element.children, element.scope),
    ])
  const enabled = (element: SourceElement) =>
    !['0', 'false', 'off'].includes(String(wmlAttribute(element, 'val')))
  if (
    descendants(parse(settingsXml), {}).some(
      (e) => wml.has(e.namespace) && e.local === 'evenAndOddHeaders' && enabled(e),
    )
  )
    throw new Error('Unsupported odd/even header output expectation')
  const sections = descendants(parse(documentXml), {}).filter(
    (e) => wml.has(e.namespace) && e.local === 'sectPr',
  )
  if (!sections.length)
    sections.push({ local: 'sectPr', namespace: '', scope: {}, attributes: {}, children: [] })
  const relNamespaces = new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'http://purl.oclc.org/ooxml/officeDocument/relationships',
  ])
  const rels = descendants(parse(relationshipsXml), {}).filter(
    (e) =>
      e.namespace === 'http://schemas.openxmlformats.org/package/2006/relationships' &&
      e.local === 'Relationship',
  )
  const inherited = { header: '', footer: '' }
  const sectionParts = sections.map((section) => {
    if (children(section, 'titlePg').some(enabled))
      throw new Error('Unsupported first-page header output expectation')
    const numbering = children(section, 'pgNumType')[0]
    const format = numbering && wmlAttribute(numbering, 'fmt')
    if (format !== undefined && format !== 'decimal')
      throw new Error('Unsupported page-number format')
    const startValue = numbering && wmlAttribute(numbering, 'start')
    const start = startValue === undefined ? undefined : Number(startValue)
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 0))
      throw new Error('Invalid page-number start')
    const type = children(section, 'type')[0]
    if (type && !['nextPage', 'continuous'].includes(String(wmlAttribute(type, 'val'))))
      throw new Error('Unsupported section page-number parity')
    for (const kind of ['header', 'footer'] as const) {
      const references = children(section, `${kind}Reference`).filter(
        (e) => wmlAttribute(e, 'type') === 'default',
      )
      if (references.length > 1) throw new Error('Duplicate default header/footer reference')
      if (!references.length) continue
      const reference = references[0]
      const id = Object.entries(reference.attributes).find(([key]) => {
        const [prefix, local] = key.slice(2).split(':')
        return local === 'id' && relNamespaces.has(reference.scope[prefix])
      })?.[1]
      const matches = rels.filter((r) => r.attributes['@_Id'] === id)
      const rel = matches[0]
      if (
        matches.length !== 1 ||
        !rel ||
        ![...relNamespaces].some((ns) => rel.attributes['@_Type'] === `${ns}/${kind}`) ||
        ![undefined, 'Internal'].includes(rel.attributes['@_TargetMode'] as string | undefined)
      )
        throw new Error('Header/footer relationship is missing or has the wrong type/mode')
      const target = new URL(
        String(rel.attributes['@_Target']),
        'https://archive.invalid/word/document.xml',
      )
      const part = target.pathname.slice(1)
      if (
        target.origin !== 'https://archive.invalid' ||
        target.search ||
        target.hash ||
        !(part in parts)
      )
        throw new Error('Header/footer relationship target is missing')
      inherited[kind] = part
    }
    return { ...inherited, start }
  })
  type Token = string | { page: true }
  const project = (nodes: Xml, scope: Record<string, string>): Token[] => {
    const output: Token[] = []
    let field: { instruction: string; separated: boolean } | null = null
    const page = (instruction: string) => {
      if (!/^PAGE(?:\s+\\\*\s+MERGEFORMAT)?$/i.test(instruction.trim()))
        throw new Error('Unsupported header/footer field instruction')
      output.push({ page: true })
    }
    const text = (element: SourceElement) =>
      element.children.map((node) => String(node['#text'] ?? '')).join('')
    const walk = (nodes: Xml, scope: Record<string, string>) => {
      for (const element of elements(nodes, scope)) {
        if (
          element.namespace === 'http://schemas.openxmlformats.org/markup-compatibility/2006' &&
          element.local === 'AlternateContent'
        ) {
          if (field) throw new Error('Unsupported field crossing alternate content')
          const branches = elements(element.children, element.scope)
          if (
            branches.some(
              (branch) =>
                branch.namespace !== element.namespace ||
                !['Choice', 'Fallback'].includes(branch.local),
            )
          )
            throw new Error('Unrecognized header/footer alternate-content branch')
          const alternatives = branches.map((branch) => project(branch.children, branch.scope))
          if (!branches.some((branch) => branch.local === 'Fallback')) alternatives.push([])
          if (
            !alternatives.length ||
            alternatives.some(
              (branch) => JSON.stringify(branch) !== JSON.stringify(alternatives[0]),
            )
          )
            throw new Error('Header/footer alternate text requires a consumer profile')
          output.push(...alternatives[0])
          continue
        }
        if (wml.has(element.namespace)) {
          if (element.local === 'fldSimple') {
            page(String(wmlAttribute(element, 'instr')))
            continue
          }
          if (element.local === 'fldChar') {
            const type = wmlAttribute(element, 'fldCharType')
            if (type === 'begin' && !field) field = { instruction: '', separated: false }
            else if (type === 'separate' && field && !field.separated) field.separated = true
            else if (type === 'end' && field) {
              page(field.instruction)
              field = null
            } else throw new Error('Unsupported header/footer field topology')
            continue
          }
          if (element.local === 'instrText') {
            if (!field || field.separated)
              throw new Error('Unsupported header/footer instruction topology')
            field.instruction += text(element)
            continue
          }
          if (element.local === 't') {
            if (!field) output.push(text(element))
            continue
          }
        }
        walk(element.children, element.scope)
      }
    }
    walk(nodes, scope)
    if (field) throw new Error('Unclosed header/footer field')
    return output
  }
  for (const [part, xml] of Object.entries(parts))
    if (
      /^word\/(footnotes|endnotes)\.xml$/.test(part) &&
      descendants(parse(xml), {}).some(
        (e) =>
          wml.has(e.namespace) &&
          e.local === 't' &&
          e.children.some((n) => String(n['#text'] ?? '').trim()),
      )
    )
      throw new Error('Text-bearing note output needs an explicit source owner')
  const expected: Record<string, string> = {}
  let previous = -1,
    number = 0
  pageSections.forEach((section, pageIndex) => {
    const current = sectionParts[section]
    if (!Number.isSafeInteger(section) || section < previous || !current)
      throw new Error('Print section identity is missing or out of order')
    number = section !== previous ? (current.start ?? number + 1) : number + 1
    previous = section
    for (const kind of ['header', 'footer'] as const) {
      const part = current[kind]
      const tokens = part ? project(parse(parts[part]), {}) : []
      const text = tokens
        .map((token) => (typeof token === 'string' ? token : String(number)))
        .join('')
        .replace(/\s+/g, '')
      if (text) expected[`hf:${pageIndex}:${kind}`] = text
    }
  })
  return expected
}
