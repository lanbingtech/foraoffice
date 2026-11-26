import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { Editor } from '@tiptap/core'
import type { ViewportTableRowFragment } from '../apps/docs/src/renderer/editor/viewport-table-source'
import type { DesktopApi } from '../apps/docs/src/shared/ipc'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'

type DocsWindow = Window & {
  desktop: DesktopApi
  __aidocs: { editor: Editor }
  __pageDebug?: { fastPasses?: number }
}

test('background pagination maps split table lines to their authored cells', async () => {
  const root = test.info().outputPath('split-table')
  const fixture = join(root, 'table.docx')
  await mkdir(root, { recursive: true })
  const paragraphs = (side: string, count: number) =>
    Array.from(
      { length: count },
      (_, i) => `<w:p><w:r><w:t>${side} line ${i + 1}</w:t></w:r></w:p>`,
    ).join('')
  await writeFile(
    fixture,
    await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t>Intro</w:t></w:r></w:p>' +
        '<w:tbl><w:tblPr><w:tblW w:w="8640" w:type="dxa"/></w:tblPr>' +
        '<w:tblGrid><w:gridCol w:w="4320"/><w:gridCol w:w="4320"/></w:tblGrid><w:tr>' +
        `<w:tc><w:tcPr><w:tcW w:w="4320" w:type="dxa"/></w:tcPr>${paragraphs('Left', 115)}</w:tc>` +
        `<w:tc><w:tcPr><w:tcW w:w="4320" w:type="dxa"/></w:tcPr>${paragraphs('Right', 76)}</w:tc>` +
        '</w:tr></w:tbl><w:p><w:r><w:t>Following paragraph</w:t></w:r></w:p>',
    }),
  )
  const env = { ...process.env, AI_OFFICE_USER_DATA: join(root, 'profile'), GENOFFICE_LANG: 'en' }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    args: ['--force-device-scale-factor=1', resolve(__dirname, '../apps/docs'), fixture],
    env,
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.ProseMirror').first()).toContainText('Left line 115')
    const result = await page.evaluate(async (filePath) => {
      const { desktop, __aidocs } = window as unknown as DocsWindow
      const file = await desktop.openDocxPath(filePath)
      if (!file || 'needsPassword' in file) throw new Error('Could not open table fixture')
      const bytes =
        file.data ?? (await fetch(file.dataUrl).then((response) => response.arrayBuffer()))
      const { port1, port2 } = new MessageChannel()
      const readLayout = (revision: number) =>
        new Promise<readonly ViewportTableRowFragment[]>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No background table layout')), 15000)
          port1.onmessage = ({ data }) => {
            if (data.type !== 'failure' && (data.type !== 'layout' || data.revision !== revision))
              return
            clearTimeout(timer)
            if (data.type === 'failure') reject(new Error(data.reason))
            else resolve(data.tableFragments ?? [])
          }
        })
      const initial = readLayout(0)
      try {
        window.postMessage(
          {
            type: 'docs:connect-layout',
            width: innerWidth,
            height: innerHeight,
            expectedScale: devicePixelRatio,
          },
          '*',
          [port2],
        )
        port1.postMessage(
          {
            type: 'open',
            width: innerWidth,
            height: innerHeight,
            language: 'en',
            file: { ...file, path: '', dataUrl: '', data: bytes },
          },
          [bytes],
        )
        const frames = await initial
        const model = __aidocs.editor.state.doc
        const edit = __aidocs.editor.state.tr.insertText(' X', 6)
        const revised = readLayout(1)
        port1.postMessage({
          type: 'edit',
          fromRevision: 0,
          toRevision: 1,
          steps: edit.steps.map((step) => step.toJSON()),
        })
        const after = await revised
        const source = model.child(1).firstChild!
        return {
          frames,
          after,
          tablePosition: model.firstChild!.nodeSize,
          source: [source.firstChild!.textContent, source.lastChild!.textContent],
          texts: [0, 1].map((index) =>
            frames
              .map(({ cells }) => model.textBetween(cells[index].from, cells[index].to, ''))
              .join(''),
          ),
        }
      } catch (error) {
        port1.close()
        throw error
      }
    }, fixture)
    expect(result.frames.length).toBeGreaterThan(1)
    expect(result.frames.map(({ cutIndex }) => cutIndex)).toEqual(
      result.frames.map((_, index) => index),
    )
    expect(result.texts).toEqual(result.source)
    expect(
      result.frames.every(
        ({ tablePosition, rowIndex }) => tablePosition === result.tablePosition && rowIndex === 0,
      ),
    ).toBe(true)
    expect(result.after).toEqual(
      result.frames.map((frame) => ({
        ...frame,
        tablePosition: frame.tablePosition + 2,
        cells: frame.cells.map(({ from, to }) => ({ from: from + 2, to: to + 2 })),
      })),
    )
    const worker = app.windows().find((window) => window.url().includes('/layout.html'))!
    expect(
      await worker.evaluate(() => (window as unknown as DocsWindow).__pageDebug?.fastPasses),
    ).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
