import { expect, it } from 'vitest'
import { readEditFingerprint } from '../../../e2e/docs-performance-edit-fingerprint'

const fixture = () => {
  const root = document.createElement('div')
  root.className = 'ProseMirror'
  root.innerHTML =
    '<p>Section 2  <span>123</span></p>' +
    '<div class="doc-toc-line"><span class="doc-toc-title">Chapter 7</span>' +
    '<span class="doc-toc-tail"><span class="doc-toc-dots">...</span>' +
    '<span class="doc-toc-page">9</span></span></div>' +
    '<div class="doc-textbox" contenteditable="false"><p>Box 2026</p></div>' +
    '<table><tbody><tr><th><p>Header 4</p></th></tr>' +
    '<tr class="page-repeat-header"><th><p>Repeated header</p></th></tr></tbody></table>' +
    '<div class="page-gap"><p>Footer 1</p></div>'
  return root
}

it('keeps the exact source text and paragraph count when pagination refreshes', () => {
  const root = fixture()
  const before = readEditFingerprint(root)
  expect(before).toEqual({ text: 'Section 2  123Chapter 7...Box 2026Header 4', paragraphs: 1 })

  root.querySelector('.doc-toc-page')!.textContent = '11'
  root.querySelector('.page-repeat-header')!.remove()
  root.prepend(root.querySelector('.page-gap')!)

  expect(readEditFingerprint(root)).toEqual(before)
})

it.each([
  ['p > span', '124'],
  ['p > span', '1\u6d4b23'],
  ['.doc-toc-title', 'Chapter 8'],
  ['.doc-textbox p', 'Box 2027'],
  ['th p', 'Header 5'],
])('detects an authored change to %s', (selector, editedText) => {
  const root = fixture()
  const target = root.querySelector(selector)!
  const originalText = target.textContent
  const before = readEditFingerprint(root)

  target.textContent = editedText
  const after = readEditFingerprint(root)
  expect(after.text).not.toBe(before.text)
  expect(after.paragraphs).toBe(before.paragraphs)

  target.textContent = originalText
  expect(readEditFingerprint(root)).toEqual(before)
})

it('detects an authored paragraph split with the same text', () => {
  const root = fixture()
  const before = readEditFingerprint(root)
  const first = root.querySelector(':scope > p')!
  const second = document.createElement('p')
  second.append(first.querySelector('span')!)
  first.after(second)

  expect(readEditFingerprint(root)).toEqual({ ...before, paragraphs: before.paragraphs + 1 })
})
