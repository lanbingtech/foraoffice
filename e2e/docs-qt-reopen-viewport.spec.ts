import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'
import { launchPerformanceHost } from './docs-performance-host'
import type { Activity } from './docs-performance-layout-probe'

test('a replacement document opens with its first page in view after scrolling the previous document', async ({}, info) => {
  test.skip(
    process.platform !== 'win32' || !process.env.FORAOFFICE_QT_HOST,
    'Requires the Windows Qt host',
  )
  test.setTimeout(90_000)
  const workspace = info.outputPath('workspace')
  await mkdir(workspace, { recursive: true })
  const previous = join(workspace, 'Previous.docx')
  const next = join(workspace, 'Next.docx')
  for (const [file, title] of [
    [previous, 'Previous report'],
    [next, 'Next report'],
  ]) {
    const bodyXml = Array.from(
      { length: 224 },
      (_, index) => `<w:p><w:r><w:t>${title} paragraph ${index + 1}</w:t></w:r></w:p>`,
    ).join('')
    await writeFile(file, await buildDocx({ bodyXml }))
  }
  const session = await launchPerformanceHost({
    kind: 'qt',
    workspace,
    document: next,
    initialDocument: previous,
    sdk: resolve(
      process.env.FORAOFFICE_DOCS_PACKAGE_ROOT ?? join(__dirname, '../apps/docs/out/sdk'),
    ),
    electronApp: '',
    qtExecutable: resolve(process.env.FORAOFFICE_QT_HOST!),
  })
  try {
    const editor = session.page.locator('.editor-scroll .ProseMirror.doc-page')
    const scroller = session.page.locator('.editor-scroll')
    await expect(editor).toContainText('Previous report paragraph 224')
    await scroller.evaluate((pane) => {
      pane.scrollTop = 1500
    })
    await expect.poll(() => scroller.evaluate((pane) => pane.scrollTop)).toBeGreaterThan(1000)

    expect(await session.open()).toBe(true)
    await expect(editor).toContainText('Next report paragraph 224')
    await expect
      .poll(() =>
        session.page.evaluate(() => {
          const activity = (
            window as Window & {
              __docsLayoutActivity?: { snapshot(): Activity }
            }
          ).__docsLayoutActivity?.snapshot()
          return (
            activity &&
            !activity.contentPending &&
            activity.owners > 0 &&
            !activity.pending &&
            !activity.active &&
            !activity.fontProbes &&
            !activity.errors.length
          )
        }),
      )
      .toBe(true)
    await expect.poll(() => scroller.evaluate((pane) => pane.scrollTop)).toBe(0)
    await expect(session.page.locator('.status-page')).toHaveText(/^Page 1 of \d+$/)
  } finally {
    await session.close()
  }
})
