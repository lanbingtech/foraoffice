import { XMLParser } from 'fast-xml-parser'

type Node = Record<string | symbol, unknown>
interface Element {
  name: string
  local: string
  uri: string
  scope: Record<string, string>
  attributes: Record<string, unknown>
  children: Node[]
  start: number
}
const namespaces = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])
const metadata = XMLParser.getMetaDataSymbol() as symbol
const parse = (xml: string): Node[] => {
  const parsed = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    trimValues: false,
    parseTagValue: false,
    captureMetaData: true,
  }).parse(xml) as Node[]
  // fast-xml-parser normalizes CRLF before recording metadata indices. Convert
  // those indices back to the exact archive string used for source fragments.
  const removed = [...xml.matchAll(/\r\n/g)].map((match, index) => match.index - index)
  const restore = (nodes: Node[]) => {
    for (const node of nodes) {
      const position = node[metadata] as { startIndex: number } | undefined
      if (position) {
        let lower = 0,
          upper = removed.length
        while (lower < upper) {
          const middle = (lower + upper) >>> 1
          if (removed[middle] < position.startIndex) lower = middle + 1
          else upper = middle
        }
        position.startIndex += lower
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) restore(value as Node[])
    }
  }
  restore(parsed)
  return parsed
}
const elements = (nodes: Node[], inherited: Record<string, string>): Element[] =>
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
      return [
        {
          name,
          local,
          uri: scope[prefix] ?? '',
          scope,
          attributes,
          children: value as Node[],
          start: (node[metadata] as { startIndex: number }).startIndex,
        },
      ]
    })
  })
const children = (node: Element, local: string) =>
  elements(node.children, node.scope).filter(
    (child) => namespaces.has(child.uri) && child.local === local,
  )
const attribute = (node: Element, local: string) =>
  Object.entries(node.attributes).find(([name]) => {
    const [prefix, key] = name.slice(2).split(':')
    return key === local && namespaces.has(node.scope[prefix])
  })?.[1]
const one = (nodes: Element[], description: string) => {
  if (nodes.length !== 1) throw new Error(`Missing or ambiguous ${description}`)
  return nodes[0]
}
const integer = (value: unknown, description: string) => {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new Error(`Invalid ${description}`)
  return Number(value)
}
const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** Independent archive expectation, not an editor converter. ECMA-376-1:2016
 * §§17.3.1.19,17.9.2/.11/.17/.18/.25: an explicit level-zero decimal list.
 * Unexercised overrides, linked styles and multilevel contracts fail closed. */
export function generatedPrintText(documentXml: string, numberingXml = '') {
  const edits: Array<{ at: number; text: string }> = []
  const counters = new Map<string, number>()
  const numbering = elements(parse(numberingXml), {}).filter(
    (node) => namespaces.has(node.uri) && node.local === 'numbering',
  )
  const marker = (paragraph: Element): string => {
    const properties = children(paragraph, 'pPr').flatMap((node) => children(node, 'numPr'))
    if (!properties.length) return ''
    const propertiesNode = one(properties, 'paragraph numbering properties')
    const id = String(attribute(one(children(propertiesNode, 'numId'), 'paragraph numId'), 'val'))
    integer(id, 'paragraph numId')
    if (id === '0') return '' // §17.9.18 explicitly removes numbering.
    const level = one(children(propertiesNode, 'ilvl'), 'explicit paragraph numbering level')
    if (integer(attribute(level, 'val'), 'paragraph numbering level') !== 0)
      throw new Error('Unsupported multilevel print numbering')
    const root = one(numbering, 'archive numbering part')
    const instance = one(
      children(root, 'num').filter((node) => String(attribute(node, 'numId')) === id),
      'numbering instance',
    )
    if (children(instance, 'lvlOverride').length) throw new Error('Unsupported numbering override')
    const abstractId = attribute(
      one(children(instance, 'abstractNumId'), 'abstract numbering reference'),
      'val',
    )
    const definition = one(
      children(root, 'abstractNum').filter(
        (node) => String(attribute(node, 'abstractNumId')) === String(abstractId),
      ),
      'abstract numbering definition',
    )
    if (children(definition, 'numStyleLink').length || children(definition, 'styleLink').length)
      throw new Error('Unsupported linked numbering style')
    const definitionLevel = one(
      children(definition, 'lvl').filter((node) => attribute(node, 'ilvl') === '0'),
      'decimal numbering level',
    )
    const format = children(definitionLevel, 'numFmt')
    if (
      format.length > 1 ||
      (format.length &&
        (attribute(format[0], 'val') !== 'decimal' || attribute(format[0], 'format') !== undefined))
    )
      throw new Error('Unsupported print numbering format')
    if (
      children(definitionLevel, 'lvlRestart').length ||
      children(definitionLevel, 'lvlPicBulletId').length ||
      children(definitionLevel, 'isLgl').length
    )
      throw new Error('Unsupported print numbering level behavior')
    const starts = children(definitionLevel, 'start')
    if (starts.length > 1) throw new Error('Ambiguous numbering start')
    const start = starts.length ? integer(attribute(starts[0], 'val'), 'numbering start') : 0
    const textNode = one(children(definitionLevel, 'lvlText'), 'numbering level text')
    const pattern = String(attribute(textNode, 'val') ?? '')
    if (attribute(textNode, 'null') !== undefined || !/^[^%]*%1[^%]*$/.test(pattern))
      throw new Error('Unsupported print numbering label')
    const next = counters.get(id) ?? start
    if (!Number.isSafeInteger(next + 1)) throw new Error('Numbering counter overflow')
    counters.set(id, next + 1)
    return pattern.replace('%1', String(next))
  }
  const equationFields = (paragraph: Element, alternate: boolean) => {
    const fields: Array<{
      instruction: string
      cached: boolean
      nested: boolean
      separated: boolean
      invalid: boolean
    }> = []
    const visit = (nodes: Node[], scope: Record<string, string>) => {
      for (const node of elements(nodes, scope)) {
        if (namespaces.has(node.uri)) {
          if (node.local === 'p' || node.local === 'txbxContent') continue
          if (node.local === 'fldSimple' && /^\s*EQ\b/i.test(String(attribute(node, 'instr'))))
            throw new Error('Unsupported simple EQ print field')
          if (node.local === 'fldChar') {
            const kind = attribute(node, 'fldCharType')
            if (kind === 'begin') {
              if (fields.length) fields[fields.length - 1].nested = true
              fields.push({
                instruction: '',
                cached: false,
                nested: false,
                separated: false,
                invalid: false,
              })
            } else if (kind === 'separate' && fields.length) {
              const field = fields[fields.length - 1]
              field.invalid ||= field.separated
              field.separated = true
            } else if (kind === 'end') {
              const field = fields.pop()
              if (field && /^\s*EQ\b/i.test(field.instruction)) {
                // Explicit compatibility scope: the measured legacy overlay's two
                // scalar operands are emitted in argument order by the editor.
                const overlay =
                  /^\s*EQ\s+\\o\s*\\ac\(\s*([^\s\\(),])\s*,\s*([^\s\\(),])\s*\)\s*$/iu.exec(
                    field.instruction,
                  )
                if (
                  !overlay ||
                  field.invalid ||
                  field.cached ||
                  field.nested ||
                  fields.length ||
                  alternate
                )
                  throw new Error('Unsupported EQ overlay print field')
                const tagEnd = documentXml.indexOf('>', node.start) + 1
                const at =
                  documentXml[tagEnd - 2] === '/'
                    ? tagEnd
                    : documentXml.indexOf(`</${node.name}>`, tagEnd) + node.name.length + 3
                if (tagEnd <= 0 || at < tagEnd) throw new Error('Missing EQ field end')
                const prefix = node.name.includes(':') ? `${node.name.split(':')[0]}:` : ''
                edits.push({
                  at,
                  text: `<${prefix}t>${escape(overlay[1] + overlay[2])}</${prefix}t>`,
                })
              }
            } else if (fields.length) fields[fields.length - 1].invalid = true
          } else if (node.local === 'instrText') {
            const text = node.children.map((child) => String(child['#text'] ?? '')).join('')
            if (fields.length) {
              const field = fields[fields.length - 1]
              field.invalid ||= field.separated
              field.instruction += text
            } else if (/^\s*EQ\b/i.test(text)) throw new Error('Unbalanced EQ print field')
          } else if (node.local === 't' && fields.length) {
            fields[fields.length - 1].cached = true
          }
        }
        visit(node.children, node.scope)
      }
    }
    visit(paragraph.children, paragraph.scope)
    if (fields.some((field) => /^\s*EQ\b/i.test(field.instruction)))
      throw new Error('Unbalanced EQ print field')
  }
  const walk = (nodes: Node[], scope: Record<string, string>, alternate = false) => {
    for (const node of elements(nodes, scope)) {
      if (namespaces.has(node.uri) && node.local === 'txbxContent') continue
      const isAlternate =
        alternate || node.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006'
      if (namespaces.has(node.uri) && node.local === 'p') {
        equationFields(node, isAlternate)
        const label = marker(node)
        if (label) {
          if (isAlternate) throw new Error('Unsupported alternate generated print text')
          const content = elements(node.children, node.scope).find(
            (child) => !(namespaces.has(child.uri) && child.local === 'pPr'),
          )
          const at = content?.start ?? documentXml.indexOf(`</${node.name}>`, node.start)
          if (at < 0) throw new Error('Missing numbered paragraph end')
          const prefix = node.name.includes(':') ? `${node.name.split(':')[0]}:` : ''
          edits.push({
            at,
            text: `<${prefix}r><${prefix}t>${escape(label)}</${prefix}t></${prefix}r>`,
          })
        }
      }
      walk(node.children, node.scope, isAlternate)
    }
  }
  walk(parse(documentXml), {})
  const fragment = (xml: string, at: number) => {
    if (documentXml.slice(at, at + xml.length) !== xml)
      throw new Error('Generated print fragment is not archived at its source position')
    let output = xml
    for (const edit of edits
      .filter((edit) => edit.at >= at && edit.at < at + xml.length)
      .sort((a, b) => b.at - a.at))
      output = output.slice(0, edit.at - at) + edit.text + output.slice(edit.at - at)
    return output
  }
  return { documentXml: fragment(documentXml, 0), fragment }
}
