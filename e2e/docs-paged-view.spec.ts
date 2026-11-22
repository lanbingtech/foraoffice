import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { Editor } from '@tiptap/core'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'

type ProbeWindow = Window & {
  __commentClickMounts?: boolean[]
  __aidocs: { editor: Editor; openPath(path: string): Promise<unknown>; save(): Promise<unknown> }
  __pageDebug: { pageCutSig: string; slices: unknown[] }
  __docsLayoutActivity: { snapshot(): { active: number; pending: number; contentPending: boolean } }
}

test('a distant viewport retains its size, page, native caret and editable destination', async ({}, info) => {
  const folder = info.outputPath('paged-view')
  await mkdir(folder, { recursive: true })
  const fixture = join(folder, 'pages.docx')
  const commentFixture = join(folder, 'comments.docx')
  const primer = join(folder, 'primer.docx')
  const paragraph = (label: string, pageBreak = false) =>
    `<w:p>${pageBreak ? '<w:pPr><w:pageBreakBefore/></w:pPr>' : ''}<w:r><w:t>${label}</w:t></w:r></w:p>`
  await writeFile(primer, await buildDocx({ bodyXml: paragraph('Ready to edit') }))
  const bodyXml = Array.from(
    { length: 160 },
    (_, index) =>
      paragraph(`Page ${index + 1} first line`, index > 0) +
      paragraph(`Page ${index + 1} second line`),
  ).join('')
  await writeFile(fixture, await buildDocx({ bodyXml }))
  const commentBody = bodyXml.replace(
    '<w:r><w:t>Page 20 first line</w:t></w:r>',
    '<w:commentRangeStart w:id="1"/><w:r><w:t>Page 20 first line</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>',
  )
  await writeFile(
    commentFixture,
    await buildDocx({
      bodyXml: commentBody,
      extraRels:
        '<Relationship Id="comments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>',
      extraParts: [
        {
          path: 'word/comments.xml',
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
          xml: '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="Reviewer"><w:p><w:r><w:t>Review page 20</w:t></w:r></w:p></w:comment></w:comments>',
        },
      ],
    }),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => name !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    executablePath: process.env.FORAOFFICE_PAGED_VIEW_ELECTRON,
    args: [process.env.FORAOFFICE_PAGED_VIEW_ENTRY ?? resolve(__dirname, '../apps/docs'), primer],
    env: { ...env, AI_OFFICE_USER_DATA: join(folder, 'profile'), GENOFFICE_LANG: 'en' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.ProseMirror').first()).toContainText('Ready to edit')
    await page.evaluate(
      (path) => (window as unknown as ProbeWindow).__aidocs.openPath(path),
      fixture,
    )
    await page.waitForFunction(() => {
      const win = window as unknown as ProbeWindow
      const activity = win.__docsLayoutActivity.snapshot()
      return (
        win.__pageDebug?.slices.length === 160 &&
        !activity.pending &&
        !activity.active &&
        !activity.contentPending
      )
    })
    await page.evaluate(() => (window as unknown as ProbeWindow).__aidocs.editor.view.focus())
    const destination = await page.evaluate(() => {
      const { view } = (window as unknown as ProbeWindow).__aidocs.editor
      const pane = view.dom.closest('.editor-scroll')!
      const target = [...view.dom.children].find(
        (child) => child.textContent === 'Page 117 first line',
      )!
      return Math.round(
        pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20,
      )
    })
    const read = (top: number) =>
      page.evaluate(async (position) => {
        const win = window as unknown as ProbeWindow
        const { view } = win.__aidocs.editor
        const pane = view.dom.closest('.editor-scroll')!
        pane.scrollTop = position
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        )
        const viewport = pane.getBoundingClientRect()
        const visible = Array.from(view.dom.children).flatMap((child) => {
          if (!child.textContent) return []
          const box = child.getBoundingClientRect()
          return box.bottom > viewport.top && box.top < viewport.bottom
            ? [[child.textContent, Math.round(box.top - viewport.top)]]
            : []
        })
        const native = document.getSelection()
        const { state } = view
        return {
          attached: view.dom.childElementCount,
          scroll: [pane.scrollTop, pane.scrollHeight, pane.scrollWidth],
          page: document.querySelector('.status-page')?.textContent,
          visible,
          cuts: win.__pageDebug.pageCutSig,
          model: [state.doc.childCount, state.selection.anchor, state.selection.head],
          native:
            native?.anchorNode && view.dom.contains(native.anchorNode)
              ? view.posAtDOM(native.anchorNode, native.anchorOffset)
              : null,
        }
      }, top)

    const baseline = await read(destination)
    expect(baseline.visible.length).toBeGreaterThan(0)
    await read(0)
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('docs:paged-view-probe', { detail: true })),
    )
    const { attached, ...result } = await read(destination)
    const { attached: original, ...expected } = baseline
    expect(attached).toBeLessThan(original / 2)
    expect(result).toEqual(expected)

    await page.evaluate(() => {
      const editor = (window as unknown as ProbeWindow).__aidocs.editor
      editor.commands.setTextSelection({ from: 1, to: 6 })
    })
    await read(0)
    const retained = await read(destination)
    expect(retained.model.slice(1)).toEqual([1, 6])
    expect(retained.native).toBe(1)
    expect(retained.attached).toBeLessThan(original / 2)
    await page.evaluate(() =>
      (window as unknown as ProbeWindow).__aidocs.editor.commands.setTextSelection(1),
    )

    const targetMounted = () =>
      page.evaluate(() => {
        const { view, state } = (window as unknown as ProbeWindow).__aidocs.editor
        let mounted = false
        state.doc.forEach((node, pos) => {
          if (node.textContent === 'Page 20 first line')
            mounted = view.nodeDOM(pos)?.isConnected ?? false
        })
        return mounted
      })
    expect(await targetMounted()).toBe(false)

    await page.keyboard.press('Control+g')
    await page.locator('.find-panel .find-select').first().selectOption('page')
    const goTo = page.locator('.find-panel input.find-goto-input')
    await goTo.fill('20')
    await goTo.press('Enter')
    await expect(page.locator('.status-page')).toContainText(/Page 20 of/i)
    expect(await targetMounted()).toBe(true)
    expect(await page.locator('.doc-page.ProseMirror > *').count()).toBeLessThan(original / 2)
    await page.locator('.find-panel .find-close').click()
    await page.evaluate(() => (window as unknown as ProbeWindow).__aidocs.editor.view.focus())
    await page.keyboard.insertText('edited ')
    await expect(page.locator('.ProseMirror').first()).toContainText('edited Page 20 first line')
    await page.keyboard.press('Control+z')
    await expect(page.locator('.ProseMirror').first()).not.toContainText('edited ')
    await page.keyboard.press('Control+a')
    await expect
      .poll(() =>
        page.evaluate(() => {
          const { doc, selection } = (window as unknown as ProbeWindow).__aidocs.editor.state
          return selection.from === 0 && selection.to === doc.content.size
        }),
      )
      .toBe(true)

    await test.step('a Comments list card follows an anchor outside the viewport', async () => {
      await page.evaluate(() => (window as unknown as ProbeWindow).__aidocs.save())
      await page.evaluate(
        (path) => (window as unknown as ProbeWindow).__aidocs.openPath(path),
        commentFixture,
      )
      await page.locator('.ribbon-mode-split [aria-haspopup="menu"]').click()
      await page.getByRole('menuitemradio', { name: 'List' }).click()
      await page.waitForFunction(() => {
        const win = window as unknown as ProbeWindow
        const activity = win.__docsLayoutActivity.snapshot()
        return (
          win.__pageDebug?.slices.length === 160 &&
          !activity.pending &&
          !activity.active &&
          !activity.contentPending
        )
      })
      const card = page.locator('.comment-thread[data-comment-id="1"] .comment-card')
      const text = page.locator('.ProseMirror .doc-comment[data-comment-ids="1"]')
      await expect(card).toContainText('Review page 20')
      await card.click()
      await expect(text).toBeInViewport()
      await read(0)
      const departure = await page.evaluate(() => {
        const root = (window as unknown as ProbeWindow).__aidocs.editor.view.dom
        const pane = root.closest('.editor-scroll')!
        const block = [...root.children].find(
          (child) => child.textContent === 'Page 117 first line',
        )!
        return Math.round(
          pane.scrollTop +
            block.getBoundingClientRect().top -
            pane.getBoundingClientRect().top -
            20,
        )
      })
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent('docs:paged-view-probe', { detail: true })),
      )
      const beforeClick = await read(departure)
      expect(beforeClick.visible.some(([text]) => text === 'Page 117 first line')).toBe(true)
      expect(await text.count()).toBe(0)
      await page.evaluate(() => {
        document.addEventListener(
          'click',
          () => {
            const win = window as unknown as ProbeWindow
            const root = win.__aidocs.editor.view.dom
            win.__commentClickMounts = [
              [...root.children].some((child) => child.textContent === 'Page 117 first line'),
              root.querySelector('.doc-comment[data-comment-ids="1"]') !== null,
            ]
          },
          { once: true },
        )
      })
      await card.click()
      expect(
        await page.evaluate(() => (window as unknown as ProbeWindow).__commentClickMounts),
      ).toEqual([true, true])
      await expect(text).toBeInViewport({ timeout: 2000 })
      expect(await page.locator('.doc-page.ProseMirror > *').count()).toBeLessThan(original / 2)
    })
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  }
})
