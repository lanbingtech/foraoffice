import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import type { PmNode } from '../apps/docs/src/renderer/editor/convert'
import type { DesktopApi } from '../apps/docs/src/shared/ipc'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'

type Reply = {
  type: string
  publication: number
  revision?: number
  sequence?: number
  position?: number
  pages?: unknown[]
  starts?: Array<number | null>
  tocPages?: Array<{ position: number; text: string }>
  pageFrames?: Array<{
    cutIndex: number
    sourceStart: number | null
    left: number
    top: number
    width: number
    height: number
  }>
  root?: Omit<PmNode, 'content'>
  blocks?: ReadableStream<PmNode[]>
  initial?: { model?: { document: unknown } }
  content?: {
    blocks: Array<{ from: number; to: number }>
    model?: { from: number; to: number; document: unknown }
  } | null
  reveal?: { position: number; top: number }
}

type LayoutTestWindow = Window & {
  desktop: DesktopApi
  layoutPort: MessagePort
  layoutReplies: Reply[]
  layoutSource: { root?: Omit<PmNode, 'content'>; chunks: PmNode[][]; complete?: boolean }
  layoutClosed: boolean
}

const paragraphsPerPage = 70
const tocEntry =
  '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:t>First target</w:t></w:r>' +
  '<w:r><w:tab/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  '<w:r><w:instrText xml:space="preserve"> PAGEREF _First </w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  '<w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

test('the Docs layout port opens in isolation and never publishes a failed document', async () => {
  const folder = test.info().outputPath('background-layout')
  await mkdir(folder, { recursive: true })
  const fixture = join(folder, 'three-pages.docx')
  await writeFile(
    fixture,
    await buildDocx({
      bodyXml: [1, 2, 3]
        .flatMap((n) => [
          `<w:p>${n > 1 ? '<w:pPr><w:pageBreakBefore/></w:pPr>' : ''}<w:r><w:t>Page ${n}</w:t></w:r></w:p>`,
          ...Array.from({ length: paragraphsPerPage - 1 }, (_, i) => {
            if (n === 1 && i === 0) return tocEntry
            const bookmarkStart =
              n === 1 && i === 1 ? '<w:bookmarkStart w:id="1" w:name="_First"/>' : ''
            const bookmarkEnd = bookmarkStart ? '<w:bookmarkEnd w:id="1"/>' : ''
            return `<w:p>${bookmarkStart}<w:r><w:t>Page ${n}, paragraph ${i + 1}</w:t></w:r>${bookmarkEnd}</w:p>`
          }),
        ])
        .join(''),
      stylesXml:
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="16"/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="180" w:lineRule="exact"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
        '</w:styles>',
    }),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => name !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>
  const app = await electron.launch({
    args: ['--force-device-scale-factor=1.25', resolve(__dirname, '../apps/docs'), fixture],
    env: { ...env, AI_OFFICE_USER_DATA: join(folder, 'profile'), GENOFFICE_LANG: 'en' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('.ProseMirror').first()).toContainText('Page 3')
    const connect = (
      open: 'cancel' | 'discard-source' | 'abort-source' | 'valid' | 'invalid' | 'stale-scale',
    ) =>
      page.evaluate(
        async ({ open, fixture }) => {
          const owner = window as unknown as LayoutTestWindow
          const file = await owner.desktop.openDocxPath(fixture)
          if (!file || 'needsPassword' in file) throw new Error('Cannot read layout fixture')
          const ports = new MessageChannel()
          owner.layoutPort = ports.port1
          owner.layoutReplies = []
          owner.layoutSource = { chunks: [] }
          owner.layoutClosed = false
          ports.port1.addEventListener('close', () => (owner.layoutClosed = true), { once: true })
          ports.port1.onmessage = ({ data }: MessageEvent<Reply>) => {
            if (data.type === 'source' && data.blocks) {
              const { blocks, ...snapshot } = data
              owner.layoutReplies.push(snapshot)
              const imported = owner.layoutSource
              imported.root = snapshot.root
              if (open === 'discard-source') {
                void blocks.cancel()
                return
              }
              if (open === 'abort-source') {
                const abort = new AbortController()
                void blocks
                  .pipeTo(new WritableStream({ write: () => abort.abort() }), {
                    signal: abort.signal,
                  })
                  .catch((error) => {
                    if (error.name !== 'AbortError') throw error
                  })
                return
              }
              void blocks
                .pipeTo(
                  new WritableStream({
                    write(chunk) {
                      imported.chunks.push(chunk)
                    },
                  }),
                )
                .then(() => (imported.complete = true))
              return
            }
            owner.layoutReplies.push(data)
            if (data.type !== 'layout') return
            ports.port1.postMessage({
              type: 'viewport',
              sequence: 1,
              publication: data.publication,
              bounds: { top: 0, bottom: 650 },
            })
          }
          window.postMessage(
            {
              type: 'docs:connect-layout',
              width: innerWidth,
              height: innerHeight,
              expectedScale: window.devicePixelRatio + (open === 'stale-scale' ? 1 : 0),
            },
            '*',
            [ports.port2],
          )
          if (open === 'cancel' || open === 'stale-scale') return
          const bytes =
            open !== 'invalid'
              ? await fetch(file.dataUrl).then((r) => r.arrayBuffer())
              : new ArrayBuffer(10)
          ports.port1.postMessage(
            {
              type: 'open',
              width: innerWidth,
              height: innerHeight,
              language: 'en',
              includeSource: true,
              file: { path: '', dataUrl: '', name: file.name, hash: file.hash, data: bytes },
            },
            [bytes],
          )
        },
        { open, fixture },
      )
    const windowCount = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    await connect('stale-scale')
    await page.waitForFunction(() => (window as unknown as LayoutTestWindow).layoutClosed)
    await expect.poll(windowCount).toBe(1)

    await connect('cancel')
    await expect.poll(windowCount).toBe(2)
    await page.evaluate(() => (window as unknown as LayoutTestWindow).layoutPort.close())
    await expect.poll(windowCount).toBe(1)

    await connect('valid')
    await page.waitForFunction(() =>
      (window as unknown as LayoutTestWindow).layoutReplies.some(
        (reply) => reply.type === 'viewport' && reply.content?.blocks.length,
      ),
    )
    const visible = await page.evaluate(() => {
      const replies = (window as unknown as LayoutTestWindow).layoutReplies
      const layout = replies.filter((reply) => reply.type === 'layout').at(-1)
      return { pages: layout?.pages?.length, starts: layout?.starts, frames: layout?.pageFrames }
    })
    expect(visible.pages).toBe(3)
    expect(visible.starts).toHaveLength(3)
    expect(visible.frames?.map((frame) => frame.cutIndex)).toEqual([0, 1, 2])
    expect(visible.frames?.map((frame) => frame.sourceStart)).toEqual(visible.starts)
    expect(visible.frames?.every((frame) => frame.width > 0 && frame.height > 0)).toBe(true)
    await page.waitForFunction(() => (window as unknown as LayoutTestWindow).layoutSource.complete)
    const source = await page.evaluate(() => {
      const { layoutReplies, layoutSource } = window as unknown as LayoutTestWindow
      const messages = layoutReplies.map((reply) => reply.type)
      return {
        revision: layoutReplies.find((reply) => reply.type === 'source')?.revision,
        beforeLayout: messages.indexOf('source') < messages.indexOf('layout'),
        rootType: layoutSource.root?.type,
        chunks: layoutSource.chunks.map((chunk) => chunk.length),
        lines: layoutSource.chunks
          .flat()
          .map((node) => node.content?.map((run) => run.text).join('')),
      }
    })
    expect(source).toEqual({
      revision: 0,
      beforeLayout: true,
      rootType: 'doc',
      chunks: [50, 50, 50, 50, 10],
      lines: [1, 2, 3].flatMap((n) => [
        `Page ${n}`,
        ...Array.from({ length: paragraphsPerPage - 1 }, (_, i) =>
          n === 1 && i === 0 ? undefined : `Page ${n}, paragraph ${i + 1}`,
        ),
      ]),
    })
    const worker = app.windows().find((window) => window.url().includes('/layout.html'))!
    const measurePaper = (target: Page) =>
      target.evaluate(() => {
        const paper = document.createElement('div')
        paper.style.position = 'absolute'
        paper.style.width = '793.733333px'
        document.body.appendChild(paper)
        const width = paper.getBoundingClientRect().width
        paper.remove()
        return { scale: window.devicePixelRatio, width }
      })
    const foregroundPaper = await measurePaper(page)
    expect(foregroundPaper.scale).toBe(1.25)
    expect(await measurePaper(worker)).toEqual(foregroundPaper)
    const identity = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((win) => ({
        layout: win.webContents.getURL().includes('/layout.html'),
        visible: win.isVisible(),
        pid: win.webContents.getOSProcessId(),
      })),
    )
    expect(identity.find((win) => win.layout)?.visible).toBe(false)
    expect(new Set(identity.map((win) => win.pid)).size).toBe(2)
    const position = await page.evaluate(() => {
      const owner = window as unknown as LayoutTestWindow
      const layout = owner.layoutReplies.filter((reply) => reply.type === 'layout').at(-1)!
      const start = layout.starts?.[2]
      if (start == null || layout.revision == null)
        throw new Error('The last page has no versioned source position')
      const position = start + 2
      owner.layoutPort.postMessage({
        type: 'reveal',
        publication: layout.publication,
        revision: layout.revision,
        sequence: 10,
        position,
        height: 400,
      })
      owner.layoutPort.postMessage({
        type: 'reveal',
        publication: 0,
        revision: layout.revision,
        sequence: 11,
        position,
        height: 400,
      })
      return position
    })
    await page.waitForFunction(() =>
      (window as unknown as LayoutTestWindow).layoutReplies.some(
        (reply) => reply.type === 'reveal-unavailable' && reply.sequence === 11,
      ),
    )
    const target = await page.evaluate(() => {
      const replies = (window as unknown as LayoutTestWindow).layoutReplies
      return {
        result: replies.find((reply) => reply.sequence === 10),
        stale: replies.find((reply) => reply.sequence === 11),
      }
    })
    expect(target.result?.reveal?.position).toBe(position)
    expect(target.result?.reveal?.top).toBeGreaterThan(1000)
    expect(target.result?.content?.model?.from).toBeLessThanOrEqual(position)
    expect(target.result?.content?.model?.to).toBeGreaterThan(position)
    expect(JSON.stringify(target.result?.content?.model?.document)).toContain('Page 3')
    expect(target.stale).toMatchObject({ type: 'reveal-unavailable', publication: 0, position })
    await page.evaluate(() => {
      const owner = window as unknown as LayoutTestWindow
      owner.layoutPort.postMessage({
        type: 'edit',
        fromRevision: 0,
        toRevision: 1,
        steps: [
          {
            stepType: 'replace',
            from: 1,
            to: 1,
            slice: { content: [{ type: 'text', text: 'Revised ' }] },
          },
        ],
      })
    })
    await page.waitForFunction(() =>
      (window as unknown as LayoutTestWindow).layoutReplies.some(
        (reply) =>
          reply.type === 'layout' &&
          reply.revision === 1 &&
          JSON.stringify(reply.initial?.model?.document ?? null).includes('Revised Page 1'),
      ),
    )
    await expect(page.locator('.ProseMirror').first()).not.toContainText('Revised Page 1')
    await expect(worker.locator('.doc-toc-page')).toHaveText('1')
    const revisedToc = await page.evaluate(() => {
      const replies = (window as unknown as LayoutTestWindow).layoutReplies
      const layout = replies.findLast((reply) => reply.type === 'layout' && reply.revision === 1)!
      const model = layout.initial?.model?.document as PmNode | undefined
      return {
        cache: model?.content?.find((node) => node.type === 'docProtected')?.attrs?.fieldDisplay,
        measured: layout.tocPages,
      }
    })
    expect(revisedToc.cache).toMatchObject({ pageRefBookmark: '_First', right: '9' })
    expect(revisedToc.measured).toEqual([{ position: 'Revised Page 1'.length + 2, text: '1' }])
    await page.evaluate(() => {
      const owner = window as unknown as LayoutTestWindow
      owner.layoutPort.postMessage({
        type: 'edit',
        fromRevision: 1,
        toRevision: 2,
        steps: [
          {
            stepType: 'replace',
            from: 1,
            to: 1,
            slice: { content: [{ type: 'text', text: 'X' }] },
          },
          { stepType: 'replace', from: 1, to: 2 },
        ],
      })
    })
    await page.waitForFunction(() =>
      (window as unknown as LayoutTestWindow).layoutReplies.some(
        (reply) =>
          reply.type === 'layout' &&
          reply.revision === 2 &&
          JSON.stringify(reply.initial?.model?.document ?? null).includes('Revised Page 1'),
      ),
    )
    expect(
      await page.evaluate(
        () =>
          (window as unknown as LayoutTestWindow).layoutReplies.findLast(
            (reply) => reply.type === 'layout' && reply.revision === 2,
          )?.tocPages,
      ),
    ).toEqual(revisedToc.measured)

    await connect('discard-source')
    await page.waitForFunction(() =>
      (window as unknown as LayoutTestWindow).layoutReplies.some(
        (reply) => reply.type === 'layout' && reply.pages?.length === 3,
      ),
    )

    await connect('abort-source')
    await page.waitForFunction(() =>
      (window as unknown as LayoutTestWindow).layoutReplies.some(
        (reply) => reply.type === 'failure',
      ),
    )
    expect(
      await page.evaluate(() =>
        (window as unknown as LayoutTestWindow).layoutReplies.map((reply) => reply.type),
      ),
    ).toEqual(['source', 'failure'])

    await connect('invalid')
    await page.waitForFunction(() =>
      (window as unknown as LayoutTestWindow).layoutReplies.some(
        (reply) => reply.type === 'failure',
      ),
    )
    expect(
      await page.evaluate(() =>
        (window as unknown as LayoutTestWindow).layoutReplies.some(
          (reply) => reply.type === 'layout' || reply.type === 'source',
        ),
      ),
    ).toBe(false)
    await page.evaluate(() => (window as unknown as LayoutTestWindow).layoutPort.close())
    await expect.poll(windowCount).toBe(1)
  } finally {
    await app.close()
  }
})
