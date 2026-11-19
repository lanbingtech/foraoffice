import { expect, it } from 'vitest'
import {
  expectedInsertion,
  verifySavedContent,
  verifyPrintedContent,
  documentZoom,
  verifyKeyboardTextEdit,
} from '../../../e2e/docs-performance-oracle'
import { documentOracle } from '../../../e2e/docs-performance-fixture'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import JSZip from 'jszip'

const original = {
  tail: 'Beta',
  textRuns: ['Alpha', 'Beta'],
  paragraphs: [
    { text: 'Alpha', start: 0 },
    { text: 'Beta', start: 5 },
  ],
  tables: 'two-cells',
  sections: 'A4 portrait',
  opaqueXml: [],
  relationships: [],
}

it('requires the exact requested authored edit, independently of generated pagination fields', () => {
  expect(() => verifyKeyboardTextEdit('Chapter text', 'Chap测ter text', '测')).not.toThrow()
  expect(() => verifyKeyboardTextEdit('Chapter text', 'Chaper text', null, 't')).not.toThrow()
  expect(() => verifyKeyboardTextEdit('Chapter text', 'Chapwrongter text', '测')).toThrow(
    'Authored insertion differs',
  )
  expect(() => verifyKeyboardTextEdit('Chapter text', 'Chap text', null, 't')).toThrow(
    'Authored deletion differs',
  )
})

it('rejects losing an unselected opaque fallback even when all ordinary text and the intended edit survive', async () => {
  const initial = '<w:p><w:r><w:t>Editable public paragraph</w:t></w:r></w:p>'
  const opaque =
    '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><a:graphic/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="width:96pt"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>'
  const ending = '<w:p><w:r><w:t>Public end</w:t></w:r></w:p>'
  const pack = (bodyXml: string) =>
    buildDocx({
      bodyXml,
      docRootExtraAttrs:
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"',
    })
  const body = (paragraph: string, object: string) =>
    paragraph.replace('</w:p>', object.replace(/^<w:p>|<\/w:p>$/g, '') + '</w:p>') + ending
  const before = await documentOracle(await pack(body(initial, opaque)))
  const expected = expectedInsertion(before, 'Editable public paragraph', 2, 'EDIT')
  const edited = initial.replace('Editable', 'EdEDITitable')
  expect(() => verifySavedContent(expected, before)).toThrow('text')
  const saved = await documentOracle(await pack(body(edited, opaque)))
  expect(() => verifySavedContent(expected, saved)).not.toThrow()
  const lost = await documentOracle(
    await pack(body(edited, opaque.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/, ''))),
  )
  expect(() => verifySavedContent(expected, lost)).toThrow('opaque')
})

it('rejects retargeting preserved package relationships even when ordinary text is unchanged', async () => {
  const bytes = await buildDocx({
    bodyXml: '<w:p><w:r><w:t>Public original text</w:t></w:r></w:p>',
    withImage: true,
  })
  const before = await documentOracle(bytes)
  const changed = await JSZip.loadAsync(bytes)
  const rels = changed.file('word/_rels/document.xml.rels')!
  const xml = await rels.async('string')
  expect(xml).toContain('media/image1.png')
  changed.file(rels.name, xml.replace('media/image1.png', 'media/replacement.png'))
  const saved = await documentOracle(await changed.generateAsync({ type: 'uint8array' }))
  expect(() => verifySavedContent(before, saved)).toThrow('relationships')
})

it('requires original content, table structure and section settings in addition to the intended edit', () => {
  const expected = expectedInsertion(original, 'Alpha', 2, 'EDIT')
  expect(() =>
    verifySavedContent(expected, {
      ...original,
      textRuns: ['AlEDITpha', 'Beta'],
      paragraphs: [
        { text: 'AlEDITpha', start: 0 },
        { text: 'Beta', start: 9 },
      ],
    }),
  ).not.toThrow()
  expect(() => verifySavedContent(expected, { ...original, textRuns: ['AlEDITpha'] })).toThrow(
    'text',
  )
  expect(() => verifySavedContent(expected, { ...expected, tables: 'one-cell' })).toThrow('tables')
  expect(() => verifySavedContent(expected, { ...expected, sections: 'Letter landscape' })).toThrow(
    'sections',
  )
})

it('rejects a marker-only or truncated PDF and requires all expected text in order and all visible pages', () => {
  const expected = expectedInsertion(original, 'Alpha', 2, 'EDIT')
  expect(() => verifyPrintedContent(expected, 'AlEDITpha\nBeta', 2, 2)).not.toThrow()
  expect(() => verifyPrintedContent(expected, 'AlEDITpha', 1, 2)).toThrow()
  expect(() => verifyPrintedContent(expected, 'AlEDITpha', 2, 2)).toThrow('text')
  expect(() => verifyPrintedContent(expected, 'Beta AlEDITpha', 2, 2)).toThrow('text')
})

it('records the actual zoom owner above ProseMirror', () => {
  document.body.innerHTML =
    '<div class="doc-zoom" style="zoom:0.75"><div class="ProseMirror" style="zoom:1"></div></div>'
  expect(documentZoom(document.querySelector<HTMLElement>('.ProseMirror')!)).toBe('0.75')
})
