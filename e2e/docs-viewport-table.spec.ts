import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { Editor } from '@tiptap/core'
import type { LayoutReply } from '../apps/docs/src/renderer/editor/layout-client'
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
        '</w:tr></w:tbl><w:p><w:r><w:t>Following paragraph</w:t></w:r></w:p>' +
        '<w:tbl><w:tblGrid><w:gridCol w:w="4320"/></w:tblGrid>' +
        '<w:tr><w:trPr><w:trHeight w:val="60" w:hRule="exact"/></w:trPr><w:tc>' +
        '<w:p><w:r><w:t>Height-limited cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
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
      const readReply = <T extends LayoutReply>(matches: (reply: LayoutReply) => reply is T) =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No background table reply')), 15000)
          port1.onmessage = ({ data }: MessageEvent<LayoutReply>) => {
            if (data.type !== 'failure' && !matches(data)) return
            clearTimeout(timer)
            if (data.type === 'failure') reject(new Error(data.reason))
            else if (matches(data)) resolve(data)
          }
        })
      const readLayout = (revision: number) =>
        readReply(
          (reply): reply is Extract<LayoutReply, { type: 'layout' }> =>
            reply.type === 'layout' && reply.revision === revision,
        )
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
        const publication = await initial
        const frames: readonly ViewportTableRowFragment[] = publication.tableFragments ?? []
        const model = __aidocs.editor.state.doc
        let linePosition = -1
        let clippedPosition = -1
        model.descendants((node, position) => {
          if (node.type.name !== 'docParagraph') return
          if (node.textContent === 'Left line 90') linePosition = position
          if (node.textContent === 'Height-limited cell') clippedPosition = position
        })
        if (linePosition < 0 || clippedPosition < 0)
          throw new Error('Missing continuation or exact-height paragraph')
        const clipped = __aidocs.editor.view.nodeDOM(clippedPosition)
        if (!(clipped instanceof Element) || !clipped.closest('.cell-clip'))
          throw new Error('Fixture does not render an exact-height cell')
        const revealCell = (position: number, sequence: number) => {
          const answer = readReply(
            (reply): reply is Extract<LayoutReply, { type: 'viewport' | 'reveal-unavailable' }> =>
              (reply.type === 'viewport' || reply.type === 'reveal-unavailable') &&
              reply.sequence === sequence,
          )
          port1.postMessage({
            type: 'reveal',
            position: position + 1,
            height: innerHeight,
            publication: publication.publication,
            revision: 0,
            sequence,
            scope: 'table-cell',
          })
          return answer
        }
        const cell = await revealCell(linePosition, 1)
        const clippedCell = await revealCell(clippedPosition, 2)
        const edit = __aidocs.editor.state.tr.insertText(' X', 6)
        const revised = readLayout(1)
        port1.postMessage({
          type: 'edit',
          fromRevision: 0,
          toRevision: 1,
          steps: edit.steps.map((step) => step.toJSON()),
        })
        const after = (await revised).tableFragments ?? []
        const source = model.child(1).firstChild!
        return {
          frames,
          after,
          cell,
          clippedCell,
          linePosition,
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
    expect(result.cell).toMatchObject({
      type: 'viewport',
      revision: 0,
      reveal: { position: result.linePosition + 1 },
      content: {
        blocks: [
          {
            from: result.tablePosition,
            tableCellText: {
              position: result.linePosition,
              from: result.linePosition + 1,
              to: result.linePosition + 13,
            },
          },
        ],
        model: { document: { content: [{ type: 'docParagraph' }] } },
      },
    })
    expect(result.clippedCell).toMatchObject({ type: 'reveal-unavailable', revision: 0 })
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
