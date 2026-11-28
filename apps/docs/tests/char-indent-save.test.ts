import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { executeTool } from '../src/renderer/ai/tools'
import { runUiOps } from '../src/renderer/ai/ops'

/**
 * Indent edits on paragraphs laid out with character-unit indents
 * (w:firstLineChars…). Word keeps preferring a style's `*Chars` over a twips
 * twin, so the saved w:ind has to carry the `*Chars="0"` cancel Word itself
 * writes for pt indents — otherwise the style indent supersedes the edit on
 * reload. Covers both the raw-pPr merge path and the pPr-less paragraph the
 * generator rebuilds from the model.
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
/** Normal carries a two-character first-line indent (WPS-style CJK templates) */
const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
  '<w:pPr><w:ind w:firstLineChars="200"/></w:pPr></w:style>' +
  '</w:styles>'
const BODY =
  // pPr-less: the style's indent alone
  '<w:p><w:r><w:t>plain body paragraph</w:t></w:r></w:p>' +
  // raw pPr without w:ind
  '<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t>justified body paragraph</w:t></w:r></w:p>' +
  // the paragraph's own character-unit indent (12pt text: 2 chars = 480 twips)
  '<w:p><w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/></w:pPr>' +
  '<w:r><w:t>direct two-character paragraph</w:t></w:r></w:p>'
const NUM_IDS = { bullet: null, ordered: null }

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

async function openEditor(bodyXml = BODY) {
  const { editorExtensions } = await import('../src/renderer/editor/extensions')
  const parsed = await parseDocx(await buildDocx({ bodyXml, stylesXml: STYLES }))
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  editors.push(editor)
  editor.commands.setContent(blocksToPmDoc(parsed.blocks) as never)
  return { editor, parsed }
}

async function setFirstLine(editor: Editor, indentFirstLine: number | null) {
  const exec = await executeTool(
    editor,
    {
      id: 't',
      name: 'apply_ops',
      input: {
        ops: [{ op: 'setParagraphFormat', target: { blockIndexes: [0, 1] }, indentFirstLine }],
      },
    },
    NUM_IDS,
  )
  expect(exec.isError).toBeFalsy()
}

describe('character-unit indents: saving an indent edit', () => {
  it('keeps an unedited paragraph with an explicit zero character indent as original XML', async () => {
    const { parsed, editor } = await openEditor(
      '<w:p><w:pPr><w:ind w:hanging="420" w:firstLineChars="0"/></w:pPr><w:r><w:t>text</w:t></w:r></w:p>',
    )
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(plan.saveBlocks[0]).toEqual({ kind: 'original', docxIndex: 0 })
    runUiOps(editor, [
      {
        op: 'setParagraphAttrs',
        target: { blockIndexes: [0] },
        attrs: { indentFirstLine: 720, indentFirstLineChars: null },
      },
    ])
    const updated = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const reopened = await parseDocx(await saveDocx(parsed, updated.saveBlocks))
    expect(reopened.blocks[0].format?.indentFirstLine).toBe(720)
    expect(reopened.blocks[0].rawPPr?.match(/w:firstLineChars="0"/g)).toHaveLength(1)
  })

  it('parses the style indent into both paragraphs (12pt text: 2 chars = 480 twips)', async () => {
    const { parsed } = await openEditor()
    expect(parsed.blocks[0].rawPPr).toBeUndefined()
    expect(parsed.blocks[0].format).toEqual({
      indentFirstLine: 480,
      charIndents: { firstLine: 200 },
    })
    expect(parsed.blocks[1].format).toMatchObject({ align: 'justify', indentFirstLine: 480 })
  })

  it('a new first-line indent is saved with the cancel and survives a reload', async () => {
    const { editor, parsed } = await openEditor()
    await setFirstLine(editor, 720)
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(plan.changedCount).toBe(2)
    const saved = await saveDocx(parsed, plan.saveBlocks)

    const reparsed = await parseDocx(saved)
    const xml = reparsed.internal.documentXml
    expect(xml).toContain('<w:pPr><w:ind w:firstLine="720" w:firstLineChars="0"/></w:pPr>')
    expect(xml).toContain(
      '<w:pPr><w:ind w:firstLine="720" w:firstLineChars="0"/><w:jc w:val="both"/></w:pPr>',
    )
    // the edit wins over the style on reload — Word resolves it the same way
    expect(reparsed.blocks[0].format).toEqual({
      indentFirstLine: 720,
      directCharIndents: { firstLine: 0 },
    })
    expect(reparsed.blocks[1].format).toEqual({
      align: 'justify',
      indentFirstLine: 720,
      directCharIndents: { firstLine: 0 },
    })
  })

  it('removing the first-line indent writes the bare cancel', async () => {
    const { editor, parsed } = await openEditor()
    await setFirstLine(editor, null)
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks)

    const reparsed = await parseDocx(saved)
    const xml = reparsed.internal.documentXml
    expect(xml).toContain('<w:pPr><w:ind w:firstLineChars="0"/></w:pPr>')
    expect(xml).toContain('<w:pPr><w:ind w:firstLineChars="0"/><w:jc w:val="both"/></w:pPr>')
    expect(reparsed.blocks[0].format).toEqual({ directCharIndents: { firstLine: 0 } })
    expect(reparsed.blocks[1].format).toEqual({
      align: 'justify',
      directCharIndents: { firstLine: 0 },
    })
  })

  it('an unrelated edit keeps the paragraphs character-indented', async () => {
    const { editor, parsed } = await openEditor()
    const exec = await executeTool(
      editor,
      {
        id: 't',
        name: 'apply_ops',
        input: {
          ops: [{ op: 'setParagraphFormat', target: { blockIndexes: [1] }, align: 'center' }],
        },
      },
      NUM_IDS,
    )
    expect(exec.isError).toBeFalsy()
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks)
    const reparsed = await parseDocx(saved)
    expect(reparsed.internal.documentXml).not.toContain('firstLineChars="0"')
    expect(reparsed.blocks[1].format).toEqual({
      align: 'center',
      indentFirstLine: 480,
      charIndents: { firstLine: 200 },
    })
  })

  it('the dialog’s character-unit edit rewrites w:firstLineChars and survives a reload', async () => {
    const { editor, parsed } = await openEditor()
    // the Paragraph dialog applies the char unit with its resolved twips twin
    // (3 chars at 12pt = 720 twips) through the UI op setParagraphAttrs
    runUiOps(editor, [
      {
        op: 'setParagraphAttrs',
        target: { blockIndexes: [2] },
        attrs: { indentFirstLineChars: 300, indentFirstLine: 720 },
      },
    ])
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const saved = await saveDocx(parsed, plan.saveBlocks)

    const reparsed = await parseDocx(saved)
    expect(reparsed.internal.documentXml).toContain(
      '<w:ind w:firstLineChars="300" w:firstLine="720"/>',
    )
    expect(reparsed.blocks[2].format).toMatchObject({
      indentFirstLine: 720,
      charIndents: { firstLine: 300 },
      directCharIndents: { firstLine: 300 },
    })
  })
})

describe('character-unit indents: a document nobody edited', () => {
  it('leaves a style-inherited paragraph byte-identical', async () => {
    // Normal carries w:firstLineChars="200"; a pPr-less paragraph inherits it.
    // The parsed block holds the inherited value, but the document carries no
    // direct indent — so the save plan has to compare direct values on both
    // sides, or the block looks edited and comes back with a frozen indent.
    const { editor, parsed } = await openEditor()
    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    expect(plan.changedCount, 'nothing was edited, so nothing may be regenerated').toBe(0)
    const saved = await saveDocx(parsed, plan.saveBlocks)
    const reparsed = await parseDocx(saved)
    const xml = reparsed.internal.documentXml
    // the paragraph is pPr-less in the source and must come back that way
    expect(xml).toContain('<w:p><w:r><w:t>plain body paragraph</w:t></w:r></w:p>')
    // and the style's own indent must not have been frozen onto it
    expect(xml).not.toContain('<w:ind w:firstLine="480"/>')
  })
})
