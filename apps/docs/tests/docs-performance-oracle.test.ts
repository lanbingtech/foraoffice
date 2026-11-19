import { expect, it } from 'vitest'
import {
  expectedInsertion,
  verifySavedContent,
  verifyPrintedContent,
  documentZoom,
} from '../../../e2e/docs-performance-oracle'

const original = {
  tail: 'Beta',
  textRuns: ['Alpha', 'Beta'],
  paragraphs: [
    { text: 'Alpha', start: 0 },
    { text: 'Beta', start: 5 },
  ],
  tables: 'two-cells',
  sections: 'A4 portrait',
}

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
