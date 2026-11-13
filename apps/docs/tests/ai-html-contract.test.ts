import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import type { PmNode } from '../src/renderer/editor/convert'
import {
  buildDocContext,
  CODE_BLOCK_PRESET,
  parseHtmlFragment,
  parseInlineFragment,
  serializeRangeToHtml,
} from '../src/renderer/ai/protocol'
import { executeTool } from '../src/renderer/ai/tools'

const numIds = { bullet: null, ordered: null }
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))
function createEditor(content = '<p>Before</p>') {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content,
  })
  editors.push(editor)
  return editor
}

describe('restricted HTML empty paragraphs', () => {
  it('round trips explicit empty paragraphs without adding hard breaks', async () => {
    const editor = createEditor('<p>A</p><p></p><p></p><p>B</p>')
    const html = serializeRangeToHtml(editor, 0, 3)
    const parsed = parseHtmlFragment(html, numIds)
    expect(parsed).toHaveLength(4)
    expect(parsed[1].content ?? []).toEqual([])
    expect(parsed[2].content ?? []).toEqual([])
    buildDocContext(editor)
    const result = await executeTool(
      editor,
      {
        id: 'roundtrip',
        name: 'replace_blocks',
        input: { startBlockIndex: 0, endBlockIndex: 3, html },
      },
      numIds,
    )
    expect(result.isError).not.toBe(true)
    expect(editor.state.doc.childCount).toBe(4)
    expect(editor.state.doc.child(1).content.size).toBe(0)
  })

  it('accepts a single intentional empty paragraph but not an empty wrapper', () => {
    expect(parseHtmlFragment('<p></p>', numIds)).toHaveLength(1)
    expect(parseHtmlFragment('<div></div>', numIds)).toEqual([])
    expect(parseHtmlFragment('', numIds)).toEqual([])
  })

  it('keeps br as a real hard break rather than treating it as an empty paragraph', () => {
    const blocks = parseHtmlFragment('<p>A</p><p><br></p><p><br></p><p>B</p>', numIds)
    expect(blocks).toHaveLength(4)
    expect(blocks[1].content).toEqual([{ type: 'hardBreak' }])
  })
})

describe('read-only document metadata', () => {
  it.each([
    {
      type: 'docInlineMath',
      attrs: { latex: 'x', text: 'x', mathml: '<math><mi>x</mi></math>', omml: '<m:oMath/>' },
    },
    { type: 'docRuby', attrs: { base: '漢字', ruby: 'かんじ' } },
    { type: 'hardBreak', attrs: {} },
  ])('marks a field result carried by $type read-only', async (node) => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          content: [{ ...node, marks: [{ type: 'instrField', attrs: { instr: 'REF example' } }] }],
        },
      ],
    })
    buildDocContext(editor)
    const before = editor.getJSON()
    const html = serializeRangeToHtml(editor, 0, 0)
    expect(html).toContain('data-doc-readonly="field"')
    const result = await executeTool(
      editor,
      {
        id: 'field-atom',
        name: 'replace_blocks',
        input: { startBlockIndex: 0, endBlockIndex: 0, html },
      },
      numIds,
    )
    expect(result).toMatchObject({ isError: true, mutated: false })
    expect(editor.getJSON()).toEqual(before)
  })
  it.each(['table', 'code'])('marks field results in %s projections read-only', (container) => {
    const editor = createEditor()
    const paragraph: PmNode = {
      type: 'docParagraph',
      attrs:
        container === 'code'
          ? { shadingFill: CODE_BLOCK_PRESET.shadingFill, borders: CODE_BLOCK_PRESET.borders }
          : {},
      content: [
        {
          type: 'text',
          text: '2020-01-01',
          marks: [{ type: 'instrField', attrs: { instr: 'DATE' } }],
        },
      ],
    }
    const node: PmNode =
      container === 'table'
        ? parseHtmlFragment('<table><tr><td>Date</td></tr></table>', numIds)[0]
        : paragraph
    if (container === 'table') node.content![0].content![0].content = [paragraph]
    editor.commands.setContent({ type: 'doc', content: [node] })
    const html = serializeRangeToHtml(editor, 0, 0)
    expect(html).toContain('data-doc-readonly="field"')
    expect(() => parseHtmlFragment(html, numIds)).toThrow(/read-only/i)
  })

  it('marks non-LaTeX inline math read-only instead of making token text writable math', () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          content: [
            {
              type: 'docInlineMath',
              attrs: {
                latex: null,
                text: 'x / y',
                mathml: '<math><mi>x</mi></math>',
                omml: '<m:oMath/>',
              },
            },
          ],
        },
      ],
    })
    const html = serializeRangeToHtml(editor, 0, 0)
    expect(html).toContain('data-doc-readonly="formula"')
    expect(() => parseHtmlFragment(html, numIds)).toThrow(/read-only/i)
  })
  it.each([
    { label: 'Image', blockType: 'image' },
    { label: 'Field', blockType: 'passthrough', previewText: 'Visible field result' },
    { label: 'Section break paragraph', blockType: 'passthrough' },
    { label: 'Formula', blockType: 'passthrough', formulaDisplay: { tokens: ['x', '/', 'y'] } },
  ])('marks the $label representation read-only and refuses its echo atomically', async (attrs) => {
    const editor = createEditor()
    editor.commands.setContent({ type: 'doc', content: [{ type: 'docProtected', attrs }] })
    buildDocContext(editor)
    const before = editor.getJSON()
    const html = serializeRangeToHtml(editor, 0, 0)
    expect(html).toContain('data-doc-readonly=')
    const result = await executeTool(
      editor,
      {
        id: 'echo',
        name: 'replace_blocks',
        input: { startBlockIndex: 0, endBlockIndex: 0, html },
      },
      numIds,
    )
    expect(result).toMatchObject({ isError: true, mutated: false })
    expect(result.output).toMatch(/read-only/i)
    expect(editor.getJSON()).toEqual(before)
  })

  it.each(['insert_content', 'replace_blocks', 'replace_selection'])(
    '%s rejects read-only wrappers before editing',
    async (name) => {
      const editor = createEditor()
      editor.commands.setTextSelection({ from: 1, to: 7 })
      buildDocContext(editor)
      const before = editor.getJSON()
      const result = await executeTool(
        editor,
        {
          id: name,
          name,
          input: {
            startBlockIndex: 0,
            endBlockIndex: 0,
            html: '<p data-doc-readonly="protected">Read-only representation</p>',
          },
        },
        numIds,
      )
      expect(result).toMatchObject({ isError: true, mutated: false })
      expect(editor.getJSON()).toEqual(before)
    },
  )

  it('rejects read-only wrappers in both parsers, including a stripped p wrapper', () => {
    const html = '<p data-doc-readonly="field">Visible result</p>'
    expect(() => parseHtmlFragment(html, numIds)).toThrow(/read-only/i)
    expect(() => parseInlineFragment(html)).toThrow(/read-only/i)
  })

  it('allows authored text that merely discusses the old diagnostic wording', async () => {
    const editor = createEditor()
    buildDocContext(editor)
    const literal = '[Protected content: Image, kept as is]'
    const result = await executeTool(
      editor,
      {
        id: 'literal',
        name: 'replace_blocks',
        input: { startBlockIndex: 0, endBlockIndex: 0, html: `<p>${literal}</p>` },
      },
      numIds,
    )
    expect(result.isError).not.toBe(true)
    expect(editor.getText()).toBe(literal)
  })

  it('refuses legacy diagnostic echo when it would overwrite a protected object', async () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'docProtected', attrs: { label: 'Image', blockType: 'image' } }],
    })
    buildDocContext(editor)
    const before = editor.getJSON()
    const result = await executeTool(
      editor,
      {
        id: 'legacy',
        name: 'replace_blocks',
        input: {
          startBlockIndex: 0,
          endBlockIndex: 0,
          html: '<p>[Protected content: Image, kept as is]</p>',
        },
      },
      numIds,
    )
    expect(result).toMatchObject({ isError: true, mutated: false })
    expect(editor.getJSON()).toEqual(before)
  })
})
