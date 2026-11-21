import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type * as Measurement from '../apps/docs/src/renderer/editor/settled-measure'

test('natural-wrap batches preserve Chromium glyph boxes in the body, floats, cells and columns', async ({
  page,
}) => {
  const bundle = await build({
    entryPoints: [resolve(__dirname, '../apps/docs/src/renderer/editor/settled-measure.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'measurement',
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const actual = await page.evaluate(() => {
    const { SettledParagraphCache, measureNatural } = (
      window as unknown as { measurement: typeof Measurement }
    ).measurement
    const gap = '<span class="page-gap-inline" style="display:inline-block"></span>'
    const latin = 'A word on the first line. Another word on the next line. '
    const cjk = '正文，文字、標點。兩端對齊的段落，標點與斷行。'
    const paragraph = (text: string, lead = '') => `<p>${lead}${text}${gap}${text}${text}</p>`
    const body = paragraph(latin) + paragraph(cjk) + paragraph(latin)
    const cell = `<table><tbody><tr><td>
      <span class="doc-cell-boxes"></span>${paragraph(cjk)}${paragraph(latin)}
      </td></tr></tbody></table>`
    const floating = paragraph(latin, '<span class="doc-inline-img--wrap-square-right"></span>')
    const styles = document.createElement('style')
    styles.textContent = `
      article { width: 320px; transform: scale(.75); transform-origin: top left; }
      p { margin: 0; line-height: 20px; font: 16px/20px sans-serif; text-align: justify; }
      table { table-layout: fixed; border-spacing: 0; width: 100%; }
      .page-gap-inline { width: 100%; height: 42px; }
      .doc-cell-boxes { float: left; width: 110px; height: 145px; }
      .doc-inline-img--wrap-square-right { float: right; width: 110px; height: 220px; }
    `
    document.head.append(styles)
    const read = (el: HTMLElement) => {
      const origin = el.getBoundingClientRect()
      const range = document.createRange()
      return Array.from(el.childNodes).flatMap((child) => {
        if (!(child instanceof Text)) return []
        return Array.from({ length: child.length }, (_, i) => {
          range.setStart(child, i)
          range.setEnd(child, i + 1)
          const r = range.getBoundingClientRect()
          return [r.left - origin.left, r.top - origin.top, r.width, r.height]
        })
      })
    }
    return [
      { html: body + cell + body, columns: false },
      { html: body + floating + body + cell + body, columns: false },
      { html: body + body, columns: true },
    ].map(({ html, columns }) => {
      const root = document.createElement('article')
      root.innerHTML = html
      if (columns) root.style.columnCount = '2'
      document.body.append(root)
      const elements = Array.from(root.querySelectorAll('p'))
      const paragraphs = elements.map((_, pos) => ({ node: {} as ProseMirrorNode, pos }))
      const view = { dom: root, nodeDOM: (pos: number) => elements[pos] } as unknown as EditorView
      const baseline = elements.map((el) => measureNatural(el, () => read(el)))
      const cache = new SettledParagraphCache<number[][]>((result) => result)
      const measured = cache.measurePass(view, paragraphs, (_, el) => read(el))
      const gapsRestored = Array.from(root.querySelectorAll<HTMLElement>('.page-gap-inline')).every(
        (gap) => gap.style.display === 'inline-block',
      )
      root.remove()
      return { baseline, measured, gapsRestored }
    })
  })
  for (const { baseline, measured, gapsRestored } of actual) {
    expect(baseline.flat()).not.toHaveLength(0)
    expect(measured).toEqual(baseline)
    expect(gapsRestored).toBe(true)
  }
})
