import { expect, test, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import type { Editor } from '@tiptap/core'
import { buildDocx, TINY_PNG_BASE64 } from '../packages/docx-engine/tests/helpers/build-docx'
import { closeAndSaveVideo, freeMcpPort, launchShell, waitForPageWithUrl } from './helpers'

type NativeWindow = Window & {
  __aidocs: { editor: Editor; save(): Promise<unknown>; openPath(path: string): Promise<unknown> }
}

async function launchNative(name: string) {
  const root = resolve(__dirname, '../apps/docs/out/diagnostics/electron-parity')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, `${name}-`))
  const userDataDir = join(directory, 'user-data')
  await mkdir(userDataDir)
  const document = join(directory, `${name}.docx`)
  await writeFile(
    document,
    await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t>Condition report</w:t></w:r></w:p>' +
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="3000"/></w:tblGrid>' +
        '<w:tr><w:tc><w:p><w:r><w:t>Bridge has old cracks; inspect further.</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>Keep adjacent cell.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '<w:p><w:r><w:t>Keep closing paragraph.</w:t></w:r></w:p>',
    }),
  )
  const port = await freeMcpPort()
  console.log(`[native ${name}] launching isolated shell`)
  const launched = await launchShell({
    videoDir: `native-regressions-${name}`,
    recordVideo: false,
    userDataDir,
    onboardingSeen: true,
    settings: { mcpEnabled: true, mcpPort: port, defaultSaveDir: directory },
    openFile: document,
    env: { GENOFFICE_AUTH_DIR: join(directory, 'auth') },
  })
  console.log(`[native ${name}] shell ready ${launched.page.url()}`)
  launched.app.on('window', (window) => {
    window.on('pageerror', (error) =>
      console.log(`[native ${name}] renderer error ${error.message}`),
    )
  })
  try {
    const page = await waitForPageWithUrl(launched.app, 'genoffice-app://docs')
    console.log(`[native ${name}] docs ready ${page.url()}`)
    const shellPage = await waitForPageWithUrl(launched.app, '/apps/shell/out/renderer/')
    await page.waitForFunction(() => Boolean((window as unknown as NativeWindow).__aidocs?.editor))
    await expect(page.locator('.ProseMirror[contenteditable="true"]').first()).toContainText(
      'Condition report',
    )
    await expect
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`)).status
        } catch {
          return 0
        }
      })
      .toBe(200)
    const clients: Client[] = []
    const connect = async () => {
      const client = new Client({ name: 'electron-native-regression', version: '1.0' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
      )
      clients.push(client)
      return client
    }
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { document, ...args } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const content = result.content as Array<{ type: string; text?: string }>
      return { result, text: content.map((item) => item.text ?? '').join('\n') }
    }
    const close = async () => {
      await Promise.allSettled(clients.map((client) => client.close()))
      await closeAndSaveVideo(launched, `native-regressions-${name}`)
    }
    const evidence = {
      versions: await launched.app.evaluate(() => process.versions),
      renderer: await page.evaluate(() => ({
        url: location.href,
        userAgent: navigator.userAgent,
        csp: window.document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content'),
      })),
      shellUrl: shellPage.url(),
      document,
      userDataDir,
    }
    await test.info().attach('electron-native-runtime', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
    await writeFile(join(directory, 'runtime.json'), JSON.stringify(evidence, null, 2))
    return { ...launched, shellPage, editorPage: page, document, directory, connect, call, close }
  } catch (error) {
    await closeAndSaveVideo(launched, `native-regressions-${name}-startup-failure`)
    throw error
  }
}

async function selectText(page: Page, text: string) {
  await page.evaluate((needle) => {
    const editor = (window as unknown as NativeWindow).__aidocs.editor
    let from = -1
    editor.state.doc.descendants((node, pos) => {
      if (from >= 0 || !node.isText) return
      const offset = node.text!.indexOf(needle)
      if (offset >= 0) from = pos + offset
    })
    if (from < 0) throw new Error(`Selection text missing: ${needle}`)
    editor.commands.setTextSelection({ from, to: from + needle.length })
    editor.view.focus()
  }, text)
}

test('native Electron MCP preserves table revision modes and bound cell selections through save/reopen', async () => {
  test.setTimeout(150_000)
  const native = await launchNative('tracked-table')
  const { editorPage: page, call, connect } = native
  try {
    expect(await native.app.evaluate(() => process.versions.electron)).toBeTruthy()
    expect(page.url()).toMatch(/^genoffice-app:\/\/docs/)
    await expect(page.locator('.ribbon-tabs')).not.toHaveClass(/ribbon-tabs-embedded/)
    await expect(native.shellPage.locator('.tab-bar .tab-item:not(.tab-home)')).toHaveCount(1)
    const file = page.getByRole('button', { name: 'File', exact: true })
    await file.click()
    const menuItems = page.getByRole('menuitem')
    await expect(menuItems.first()).toBeFocused()
    await expect(menuItems.first()).toHaveCSS('outline-style', 'none')
    await page.keyboard.press('ArrowDown')
    await expect(menuItems.nth(1)).toBeFocused()
    await expect(menuItems.nth(1)).toHaveCSS('outline-style', 'solid')
    await page.keyboard.press('Escape')
    await expect(file).toBeFocused()
    await expect(file).toHaveCSS('outline-style', 'solid')

    await page.getByRole('button', { name: 'Review', exact: true }).click()
    const track = page.getByRole('button', { name: 'Track Changes', exact: true })
    await track.click()
    await expect(track).toHaveClass(/active/)
    const replacement = await connect()
    await call(replacement, 'replace_blocks', {
      startBlockIndex: 1,
      endBlockIndex: 1,
      html: '<table><tr><td>Bridge has fine cracks; inspect further.</td><td>Keep adjacent cell.</td></tr></table>',
    })
    const body = page.locator('.ProseMirror[contenteditable="true"]').first()
    const oldTable = body.locator('table.doc-del')
    const newTable = body.locator('table.doc-ins')
    for (const mode of ['No Markup', 'Original', 'Simple Markup', 'All Markup']) {
      await page.getByRole('button', { name: 'Markup', exact: true }).click()
      await page
        .locator('.layout-menu')
        .getByRole('button', { name: new RegExp(`^${mode}`) })
        .click()
      if (mode === 'Original' || mode === 'All Markup') await expect(oldTable).toBeVisible()
      else await expect(oldTable).toBeHidden()
      if (mode === 'Original') await expect(newTable).toBeHidden()
      else await expect(newTable).toBeVisible()
    }

    await selectText(page, 'fine cracks')
    // A new MCP session captures the visible cell selection through production IPC.
    const polish = await connect()
    const selected = await call(polish, 'read_document')
    expect(selected.text).toContain('Selected text (11 characters): \\"fine cracks\\"')
    expect(selected.text).toContain('<sel>fine cracks</sel>')
    // Moving the live caret must not retarget this caller's already captured scope.
    await selectText(page, 'Condition report')
    await call(polish, 'replace_selection', { html: 'minor surface cracks' })
    await expect(oldTable).toContainText('Bridge has old cracks; inspect further.')
    await expect(newTable.locator('td').nth(1)).toHaveText('Keep adjacent cell.')
    await expect(newTable.locator('span.doc-del')).toHaveText('fine cracks')
    await expect(newTable.locator('span.doc-ins')).toHaveText('minor surface cracks')
    await expect(body.locator('p').first()).toHaveText('Condition report')

    await page.evaluate(() => (window as unknown as NativeWindow).__aidocs.save())
    const archive = await JSZip.loadAsync(await readFile(native.document))
    const xml = await archive.file('word/document.xml')!.async('string')
    expect(xml).toContain('minor surface cracks')
    expect(xml).toMatch(/<w:del[ >]/)
    expect(xml).toMatch(/<w:ins[ >]/)
    await page.evaluate(
      (path) => (window as unknown as NativeWindow).__aidocs.openPath(path),
      native.document,
    )
    await expect(body.locator('table.doc-ins')).toContainText('minor surface cracks')
    const reopened = await connect()
    const blocks = await call(reopened, 'read_blocks', { startBlockIndex: 0, endBlockIndex: 3 })
    expect(blocks.text).toContain('Bridge has minor surface cracks; inspect further.')
    expect(blocks.text).toContain('Keep adjacent cell.')
    expect(blocks.text).toContain('Keep closing paragraph.')
    expect(blocks.text).not.toContain('old cracks')
    expect(blocks.text).not.toContain('fine cracks')
    await page.screenshot({ path: test.info().outputPath('native-pending-table-revisions.png') })
  } finally {
    await native.close()
  }
})

test('native Electron production CSP permits data/blob media and embeds images without serializing local AI queue state', async () => {
  test.setTimeout(150_000)
  const native = await launchNative('media-and-queue')
  const { editorPage: page } = native
  try {
    const dataUrl = `data:image/png;base64,${TINY_PNG_BASE64}`
    const media = await page.evaluate(async (url) => {
      const violations: string[] = []
      const onViolation = (event: SecurityPolicyViolationEvent) => violations.push(event.blockedURI)
      document.addEventListener('securitypolicyviolation', onViolation)
      const bytes = await (await fetch(url)).arrayBuffer()
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      try {
        const blobBytes = await (await fetch(blobUrl)).arrayBuffer()
        const image = new Image()
        image.src = blobUrl
        await image.decode()
        return {
          bytes: bytes.byteLength,
          blobBytes: blobBytes.byteLength,
          width: image.naturalWidth,
          violations,
        }
      } finally {
        URL.revokeObjectURL(blobUrl)
        document.removeEventListener('securitypolicyviolation', onViolation)
      }
    }, dataUrl)
    expect(media.bytes).toBe(Buffer.from(TINY_PNG_BASE64, 'base64').length)
    expect(media.blobBytes).toBe(media.bytes)
    expect(media.width).toBe(1)
    expect(media.violations).toEqual([])
    await selectText(page, 'Condition report')
    await expect(page.locator('.ai-ask-trigger')).toBeVisible()
    await page.locator('.ai-ask-trigger').click()
    await expect(page.locator('.ai-ask-pop-input')).toBeFocused()
    await expect(page.locator('.doc-inactive-selection')).toBeVisible()
    await page.locator('.ai-ask-pop-close').click()
    await expect(page.locator('.ai-ask-pop-input')).toHaveCount(0)
    await selectText(page, 'Keep closing paragraph.')
    await page.locator('.ai-ask-trigger').click()
    await page.locator('.ai-ask-pop-input').fill('Local queued instruction only')
    await page.locator('.ai-ask-confirm').click()
    await expect(page.locator('.ai-queue-anchor')).toHaveCount(1)
    await selectText(page, 'Condition report')
    // insert_image is the public tool, dispatched through the real Electron MCP server.
    await native.call(await native.connect(), 'insert_image', {
      url: dataUrl,
      label: 'CSP regression PNG',
    })
    await expect(page.locator('.ProseMirror img').first()).toBeVisible()
    await expect
      .poll(() =>
        page
          .locator('.ProseMirror img')
          .first()
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBe(1)
    await page.evaluate(() => (window as unknown as NativeWindow).__aidocs.save())
    const archive = await JSZip.loadAsync(await readFile(native.document))
    const pictures = Object.keys(archive.files).filter((path) => /^word\/media\/[^/]+$/.test(path))
    expect(pictures.length).toBeGreaterThan(0)
    expect(await archive.file(pictures[0])!.async('base64')).toBe(TINY_PNG_BASE64)
    const xml = await archive.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:drawing>')
    expect(xml).not.toContain('blob:')
    expect(xml).not.toContain('ai-queue-anchor')
    expect(xml).not.toContain('Local queued instruction only')
    expect(xml).toContain('Keep closing paragraph.')
    await page.evaluate(
      (path) => (window as unknown as NativeWindow).__aidocs.openPath(path),
      native.document,
    )
    await expect(page.locator('.ProseMirror img').first()).toBeVisible()
    await expect
      .poll(() =>
        page
          .locator('.ProseMirror img')
          .first()
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBe(1)
    await page.screenshot({ path: test.info().outputPath('native-csp-image-and-queue.png') })
  } finally {
    await native.close()
  }
})
