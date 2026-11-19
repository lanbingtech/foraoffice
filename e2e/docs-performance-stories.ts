import { XMLParser } from 'fast-xml-parser'

type Xml = Array<Record<string, unknown>>
type Token = { kind: 'start' } | { kind: 'end' } | { kind: 'text'; value: string }
const wml = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])
const compatibility = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const parseXml = (xml: string): Xml =>
  new XMLParser({
    preserveOrder: true,
    trimValues: false,
    parseTagValue: false,
    ignoreAttributes: false,
  }).parse(xml) as Xml
const inScope = (node: Record<string, unknown>, inherited: Record<string, string>) => {
  const namespaces = { ...inherited }
  for (const [name, value] of Object.entries((node[':@'] ?? {}) as Record<string, unknown>)) {
    if (name === '@_xmlns') namespaces[''] = String(value)
    else if (name.startsWith('@_xmlns:')) namespaces[name.slice(8)] = String(value)
  }
  return namespaces
}

/** A common main-story projection, independent of the consumer's unknown Requires profile. */
export function mainStoryOracle(xml: string) {
  const parsed = parseXml(xml)
  const project = (nodes: Xml, inherited: Record<string, string>): Token[] =>
    nodes.flatMap((node) => {
      const namespaces = inScope(node, inherited)
      return Object.entries(node).flatMap(([name, value]): Token[] => {
        if (name === ':@' || name.startsWith('#') || !Array.isArray(value)) return []
        const [prefix, local] = name.includes(':') ? name.split(':') : ['', name]
        const namespace = namespaces[prefix] ?? ''
        if (wml.has(namespace) && local === 'txbxContent') return []
        if (namespace === compatibility && local === 'AlternateContent') {
          const alternatives: Token[][] = []
          let fallback = false
          for (const branch of value as Xml) {
            const branchName = Object.keys(branch).find((key) => key !== ':@')
            if (!branchName) continue
            const [bp, bl] = branchName.includes(':') ? branchName.split(':') : ['', branchName]
            if (
              inScope(branch, namespaces)[bp] !== compatibility ||
              !['Choice', 'Fallback'].includes(bl)
            )
              throw new Error('Unrecognized alternate-content branch')
            alternatives.push(project([branch], namespaces))
            fallback ||= bl === 'Fallback'
          }
          if (!fallback) alternatives.push([])
          if (
            alternatives.some(
              (branch) => JSON.stringify(branch) !== JSON.stringify(alternatives[0]),
            )
          )
            throw new Error(
              'Unresolved alternate main-story content: consumer namespace profile is unknown',
            )
          return alternatives[0] ?? []
        }
        if (local === 't') {
          if (!wml.has(namespace)) throw new Error('Unclassified text-bearing XML story')
          const text = (value as Xml)
            .map((entry) => String(entry['#text'] ?? ''))
            .join('')
            .replace(/\s+/g, '')
          return text ? [{ kind: 'text', value: text }] : []
        }
        const contents = project(value as Xml, namespaces)
        return wml.has(namespace) && local === 'p'
          ? [{ kind: 'start' }, ...contents, { kind: 'end' }]
          : contents
      })
    })
  const tokens = project(parsed, {})
  const textRuns: string[] = []
  const paragraphs: Array<{ text: string; start: number }> = []
  const open: Array<{ text: string; start: number }> = []
  let position = 0
  for (const token of tokens) {
    if (token.kind === 'start') open.push({ text: '', start: position })
    else if (token.kind === 'end') {
      const paragraph = open.pop()
      if (!paragraph) throw new Error('Unbalanced main-story paragraph')
      paragraphs.push(paragraph)
    } else {
      textRuns.push(token.value)
      position += token.value.length
      for (const paragraph of open) paragraph.text += token.value
    }
  }
  const tail = paragraphs.filter((paragraph) => paragraph.text).at(-1)?.text
  if (!tail) throw new Error('Main story requires a nonempty final paragraph')
  return { textRuns, paragraphs, tail }
}

export interface TextboxStory {
  docxIndex: number
  txbxIndex: number
  text: string
}
export interface RenderedTextboxStory {
  docxIndex: number | null
  txbxIndex?: number
  text: string
  laidOut: boolean
}

/** Source addresses follow the existing non-fallback, outermost txbxIndex contract. */
export function expectedTextboxStories(
  documentXml: string,
  bindings: Array<{ docxIndex: number | null; originalXml: string | null }>,
): TextboxStory[] {
  let bodyNamespaces: Record<string, string> | undefined
  const findBody = (nodes: Xml, inherited: Record<string, string>) => {
    for (const node of nodes) {
      const namespaces = inScope(node, inherited)
      for (const [name, value] of Object.entries(node)) {
        if (!Array.isArray(value)) continue
        const [prefix, local] = name.includes(':') ? name.split(':') : ['', name]
        if (wml.has(namespaces[prefix]) && local === 'body') bodyNamespaces = namespaces
        else findBody(value as Xml, namespaces)
      }
    }
  }
  const parsed = parseXml(documentXml)
  findBody(parsed, {})
  if (!bodyNamespaces) throw new Error('Document body namespace context is missing')
  const result: TextboxStory[] = []
  const seen = new Set<number>()
  const collect = (nodes: Xml, inherited: Record<string, string>) => {
    const texts: string[] = []
    const contentText = (nodes: Xml, inherited: Record<string, string>): string =>
      nodes
        .map((node) => {
          const namespaces = inScope(node, inherited)
          return Object.entries(node)
            .map(([name, value]) => {
              if (!Array.isArray(value)) return ''
              const [prefix, local] = name.includes(':') ? name.split(':') : ['', name]
              if (wml.has(namespaces[prefix]) && local === 'txbxContent') return ''
              if (local === 't') {
                if (!wml.has(namespaces[prefix])) throw new Error('Unclassified textbox text story')
                return (value as Xml).map((entry) => String(entry['#text'] ?? '')).join('')
              }
              return contentText(value as Xml, namespaces)
            })
            .join('')
        })
        .join('')
    const walk = (nodes: Xml, inherited: Record<string, string>) => {
      for (const node of nodes) {
        const namespaces = inScope(node, inherited)
        for (const [name, value] of Object.entries(node)) {
          if (!Array.isArray(value)) continue
          const [prefix, local] = name.includes(':') ? name.split(':') : ['', name]
          if (namespaces[prefix] === compatibility) {
            if (local === 'Fallback') continue
            if (
              local === 'AlternateContent' &&
              (value as Xml).filter((branch) => {
                const scope = inScope(branch, namespaces)
                return Object.keys(branch).some((key) => {
                  const [bp, bl] = key.includes(':') ? key.split(':') : ['', key]
                  return scope[bp] === compatibility && bl === 'Choice'
                })
              }).length > 1
            )
              throw new Error(
                'Multiple alternate textbox Choices require an explicit consumer profile',
              )
          }
          if (wml.has(namespaces[prefix]) && local === 'txbxContent') {
            const text = contentText(value as Xml, namespaces).replace(/\s+/g, '')
            texts.push(text)
            continue
          }
          walk(value as Xml, namespaces)
        }
      }
    }
    walk(nodes, inherited)
    return texts
  }
  for (const binding of bindings) {
    const xml = binding.originalXml
    const at = xml ? documentXml.indexOf(xml) : -1
    if (!xml || at < 0 || documentXml.indexOf(xml, at + 1) >= 0)
      throw new Error('Textbox source XML is not uniquely present in the archive')
    if (binding.docxIndex === null || seen.has(binding.docxIndex))
      throw new Error('Textbox block source identity is missing or duplicated')
    seen.add(binding.docxIndex)
    const docxIndex = binding.docxIndex
    collect(parseXml(xml), bodyNamespaces).forEach((text, txbxIndex) => {
      if (text) result.push({ docxIndex, txbxIndex, text })
    })
  }
  if (
    JSON.stringify(collect(parsed, {}).filter(Boolean).sort()) !==
    JSON.stringify(result.map((story) => story.text).sort())
  )
    throw new Error('Archived textbox stories lack source bindings')
  return result
}

export function verifyTextboxStories(expected: TextboxStory[], actual: RenderedTextboxStory[]) {
  for (const box of actual) {
    const text = box.text.replace(/\s+/g, '')
    if (!text) continue
    if (box.docxIndex === null || box.txbxIndex === undefined)
      throw new Error('Unknown rendered textbox source identity')
    const source = expected.find(
      (story) => story.docxIndex === box.docxIndex && story.txbxIndex === box.txbxIndex,
    )
    if (!source || source.text !== text)
      throw new Error('Textbox story text differs from its archived source')
    if (!box.laidOut) throw new Error('Textbox story has no layout geometry')
  }
  for (const story of expected)
    if (
      actual.filter(
        (box) =>
          box.docxIndex === story.docxIndex &&
          box.txbxIndex === story.txbxIndex &&
          box.text.replace(/\s+/g, ''),
      ).length !== 1
    )
      throw new Error('Missing or duplicated rendered textbox story')
}
