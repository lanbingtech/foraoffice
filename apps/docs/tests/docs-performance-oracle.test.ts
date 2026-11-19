import { expect, it } from 'vitest'
import {
  verifyNativeCompositionEvents,
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

it('accepts an exact edit whose text shares a prefix with the retained text', () => {
  const source = 'AA测量ZZ'
  const edited = 'AA测试测量ZZ'
  const change = '测试'
  expect(() => verifyKeyboardTextEdit(source, edited, change)).not.toThrow()
  expect(() => verifyKeyboardTextEdit(edited, source, null, change)).not.toThrow()
})

it('rejects collateral text changes even when the expected delta and length are present', () => {
  const source = 'AA测量ZZ'
  const edited = 'AA测试测量ZZ'
  const change = '测试'
  expect(() => verifyKeyboardTextEdit(source, 'AX测试测量ZZ', change)).toThrow(
    'Authored insertion differs',
  )
  expect(() => verifyKeyboardTextEdit(source, 'AA测试测量ZX', change)).toThrow(
    'Authored insertion differs',
  )
  expect(() => verifyKeyboardTextEdit(edited, 'AA测量ZX', null, change)).toThrow(
    'Authored deletion differs',
  )
})

it('rejects an empty insertion or deletion', () => {
  expect(() => verifyKeyboardTextEdit('same', 'same', '')).toThrow('Authored insertion differs')
  expect(() => verifyKeyboardTextEdit('same', 'same', null, '')).toThrow(
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

it('verifies a persisted TOC page cache change against its archived field and observed page', async () => {
  const run = (contents: string) => `<w:r>${contents}</w:r>`
  const field = (kind: string) => run(`<w:fldChar w:fldCharType="${kind}"/>`)
  const toc = (page: string, reference = 'Chapter', title = 'Index heading') =>
    '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/>' +
    '</w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:hyperlink w:anchor="Chapter">' +
    run(`<w:t>${title}</w:t>`) +
    run('<w:tab/>') +
    field('begin') +
    run(`<w:instrText> PAGEREF ${reference} \\h </w:instrText>`) +
    field('separate') +
    run(`<w:t>${page}</w:t>`) +
    field('end') +
    '</w:hyperlink></w:p></w:sdtContent></w:sdt>'
  const archive = (text: string, tocXml: string) =>
    buildDocx({
      bodyXml:
        `<w:p>${run(`<w:t>${text}</w:t>`)}</w:p>${tocXml}` +
        '<w:p><w:bookmarkStart w:id="1" w:name="Chapter"/>' +
        run('<w:t>Body heading</w:t>') +
        '<w:bookmarkEnd w:id="1"/></w:p>',
    })
  const source = await archive('Before', toc('10'))
  const sourceXml = await (await JSZip.loadAsync(source)).file('word/document.xml')!.async('string')
  const expected = expectedInsertion(await documentOracle(source), 'Before', 2, 'EDIT')
  const checked = async (tocXml: string, page = '9') =>
    verifySavedContent(
      expected,
      await documentOracle(await archive('BeEDITfore', tocXml), {
        sourceXml,
        observedTocPages: [{ anchor: 'Chapter', page }],
      }),
    )
  await expect(checked(toc('9'))).resolves.toBeUndefined()
  await expect(checked(toc('10'))).resolves.toBeUndefined()
  await expect(checked(toc('7'))).rejects.toThrow()
  await expect(checked(toc('9', 'Changed'))).rejects.toThrow()
  await expect(checked(toc('9', 'Chapter', 'Changed title'))).rejects.toThrow()
  await expect(
    checked(toc('9').replace('<w:instrText>', '<w:instrText xmlns:w="urn:invalid-field">')),
  ).rejects.toThrow('TOC field structure')
  await expect(
    checked(toc('9').replace('w:fldCharType="end"', 'w:fldCharType="begin"')),
  ).rejects.toThrow()
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

it('keeps independent paragraph positions correct when composing native and later saved edits', () => {
  const first = expectedInsertion(original, 'Alpha', 2, '测试')
  const both = expectedInsertion(first, 'Beta', 2, 'MARK')
  expect(both.textRuns.join('')).toBe('Al测试phaBeMARKta')
  expect(both.paragraphs.map((p) => ({ text: p.text, start: p.start }))).toEqual([
    { text: 'Al测试pha', start: 0 },
    { text: 'BeMARKta', start: 7 },
  ])
})

it('attributes a fresh owned native preedit/commit while recording the measured untrusted compositionend', () => {
  const common = { trusted: true, mainEditor: true }
  const events = [
    { ...common, type: 'compositionstart', at: 100, data: '' },
    { ...common, type: 'compositionupdate', at: 101, data: "ce'shi" },
    { ...common, type: 'compositionupdate', at: 102, data: '测试', twoFrameCallbacksMs: 24 },
    { ...common, type: 'compositionend', at: 103, data: '测试', trusted: false },
  ]
  expect(verifyNativeCompositionEvents(events, 99, '测试')).toMatchObject({
    endTrusted: false,
    lastUpdateTwoFrameCallbacksMs: 24,
  })
  expect(() => verifyNativeCompositionEvents(events, 101, '测试')).toThrow(
    'Fresh owned native composition',
  )
  expect(() =>
    verifyNativeCompositionEvents(
      events.map((e) => ({ ...e, mainEditor: false })),
      99,
      '测试',
    ),
  ).toThrow('Fresh owned native composition')
  expect(() => verifyNativeCompositionEvents(events, 99, null)).toThrow(
    'Native composition outcome differs',
  )
  expect(
    verifyNativeCompositionEvents(
      events.map((e) => (e.at >= 102 ? { ...e, data: '' } : e)),
      99,
      null,
    ),
  ).toMatchObject({ endTrusted: false })
})
