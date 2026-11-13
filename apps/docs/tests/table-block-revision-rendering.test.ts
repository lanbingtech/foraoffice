import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { tableModelToPmNode } from '../src/renderer/editor/convert'
import { acceptAllRevisions, rejectAllRevisions } from '../src/renderer/editor/revisions'
import { revisionAuthorCss } from '../src/renderer/editor/revision-filters'

const editors: Editor[] = []
const hosts: HTMLElement[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

function fixture() {
  const table = (kind: 'ins' | 'del', text: string) => {
    const node = tableModelToPmNode({ rows: [[{ paras: [text] }]], colWidthsPct: [100] })
    return {
      ...node,
      attrs: {
        ...node.attrs,
        blockRevision: { kind, author: 'Reviewer', date: '2026-11-12T00:00:00Z' },
      },
    }
  }
  const host = document.createElement('main')
  host.className = 'app'
  const style = document.createElement('style')
  const css = readFileSync(resolve(__dirname, '../src/renderer/styles.css'), 'utf8')
  // Exercise the production revision rules without unrelated layout styles.
  style.textContent = css.slice(
    css.indexOf('/* tracked changes: insertions underlined'),
    css.indexOf('/* paragraph format changes live in their Formatted:'),
  )
  const element = document.createElement('div')
  host.append(style, element)
  document.body.append(host)
  hosts.push(host)
  const editor = new Editor({
    element,
    extensions: editorExtensions,
    content: { type: 'doc', content: [table('del', 'Old table'), table('ins', 'New table')] },
  })
  editors.push(editor)
  return { editor, host, tables: () => [...host.querySelectorAll('table.doc-table')] }
}

describe('whole-table revisions in the editor DOM', () => {
  it('carries deletion/insertion and authorship on the table without changing its grid', () => {
    const { tables } = fixture()
    const [deleted, inserted] = tables()
    expect(deleted.classList.contains('doc-del')).toBe(true)
    expect(deleted.getAttribute('data-del-author')).toBe('Reviewer')
    expect(inserted.classList.contains('doc-ins')).toBe(true)
    expect(inserted.getAttribute('data-ins-author')).toBe('Reviewer')
    expect(getComputedStyle(deleted).display).toBe('table')
    expect(getComputedStyle(inserted).display).toBe('table')
    expect(deleted.querySelectorAll('col')).toHaveLength(1)
    expect(inserted.querySelectorAll('td')).toHaveLength(1)
    expect(getComputedStyle(deleted).textDecoration).toContain('line-through')
    expect(getComputedStyle(inserted).textDecoration).toContain('underline')
  })

  it.each(['none', 'simple'])('hides deleted tables in %s mode', (mode) => {
    const { host, tables } = fixture()
    host.classList.add(`rev-display-${mode}`)
    const [deleted, inserted] = tables()
    expect(getComputedStyle(deleted).display).toBe('none')
    expect(getComputedStyle(inserted).display).toBe('table')
    expect(getComputedStyle(inserted).textDecoration).toBe('none')
  })

  it('shows the old table and hides the new table in Original', () => {
    const { host, tables } = fixture()
    host.classList.add('rev-display-original')
    const [deleted, inserted] = tables()
    expect(getComputedStyle(deleted).display).toBe('table')
    expect(getComputedStyle(deleted).textDecoration).toBe('none')
    expect(getComputedStyle(inserted).display).toBe('none')
  })

  it('honors insertion/deletion and reviewer filters through the existing revision classes', () => {
    const { host, tables } = fixture()
    host.classList.add('rev-hide-insdel')
    expect(getComputedStyle(tables()[0]).display).toBe('none')
    host.classList.remove('rev-hide-insdel')
    const style = document.createElement('style')
    style.textContent = revisionAuthorCss(['Reviewer'], ['Reviewer'])
    host.append(style)
    expect(getComputedStyle(tables()[0]).display).toBe('none')
    expect(getComputedStyle(tables()[1]).textDecoration).toBe('none')
  })

  it.each(['accept', 'reject'] as const)('removes revision chrome after %s', (action) => {
    const { editor, tables } = fixture()
    if (action === 'accept') acceptAllRevisions(editor)
    else rejectAllRevisions(editor)
    expect(tables()).toHaveLength(1)
    expect(tables()[0].textContent).toBe(action === 'accept' ? 'New table' : 'Old table')
    expect(tables()[0].matches('.doc-ins,.doc-del')).toBe(false)
  })
})
