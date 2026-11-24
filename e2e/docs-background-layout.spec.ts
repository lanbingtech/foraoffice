import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import type { DesktopApi } from '../apps/docs/src/shared/ipc'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'

type Reply = {
  type: string
  publication: number
  revision?: number
  pages?: unknown[]
  starts?: Array<number | null>
  initial?: { model?: { document: unknown } }
  content?: { blocks: Array<{ from: number; to: number }> }
}

type LayoutTestWindow = Window & {
  desktop: DesktopApi
  layoutPort: MessagePort
  layoutReplies: Reply[]
  layoutClosed: boolean
}

test('the Docs layout port opens in isolation and never publishes a failed document', async () => {
  const folder = test.info().outputPath('background-layout')
  await mkdir(folder, { recursive: true })
  const fixture = join(folder, 'three-pages.docx')
  await writeFile(
    fixture,
    await buildDocx({
      bodyXml: [1, 2, 3]
        .map(
          (n) =>
            `<w:p>${n > 1 ? '<w:pPr><w:pageBreakBefore/></w:pPr>' : ''}<w:r><w:t>Page ${n}</w:t></w:r></w:p>`,
        )
        .join(''),
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
    const connect = (open: 'cancel' | 'valid' | 'invalid' | 'stale-scale') =>
      page.evaluate(
        async ({ open, fixture }) => {
          const owner = window as unknown as LayoutTestWindow
          const file = await owner.desktop.openDocxPath(fixture)
          if (!file || 'needsPassword' in file) throw new Error('Cannot read layout fixture')
          const ports = new MessageChannel()
          owner.layoutPort = ports.port1
          owner.layoutReplies = []
          owner.layoutClosed = false
          ports.port1.addEventListener('close', () => (owner.layoutClosed = true), { once: true })
          ports.port1.onmessage = ({ data }: MessageEvent<Reply>) => {
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
            open === 'valid'
              ? await fetch(file.dataUrl).then((r) => r.arrayBuffer())
              : new ArrayBuffer(10)
          ports.port1.postMessage(
            {
              type: 'open',
              width: innerWidth,
              height: innerHeight,
              language: 'en',
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
      return { pages: layout?.pages?.length, starts: layout?.starts?.length }
    })
    expect(visible).toEqual({ pages: 3, starts: 3 })
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

    await connect('invalid')
    await page.waitForFunction(() =>
      (window as unknown as LayoutTestWindow).layoutReplies.some(
        (reply) => reply.type === 'failure',
      ),
    )
    expect(
      await page.evaluate(() =>
        (window as unknown as LayoutTestWindow).layoutReplies.some(
          (reply) => reply.type === 'layout',
        ),
      ),
    ).toBe(false)
    await page.evaluate(() => (window as unknown as LayoutTestWindow).layoutPort.close())
    await expect.poll(windowCount).toBe(1)
  } finally {
    await app.close()
  }
})
