import { test, expect, chromium, type Page } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { buildBlankDocx } from '../packages/docx-engine/src'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { DocsEditorHandle } from '../apps/docs/src/renderer/embedded'
import { runRealCodexDocs } from './real-codex'
import { runRealDshDocs } from './real-dsh'
import { createRequire } from 'node:module'

declare global {
  interface Window {
    docsEditor?: DocsEditorHandle
  }
}

test('the packaged Qt host manually edits and shares the same live Word runtime with standard MCP', async () => {
  test.setTimeout(180_000)
  if (
    process.env.FORAOFFICE_CODEX_WSL_BINARY ||
    process.env.FORAOFFICE_CODEX_NODE_ENTRY ||
    process.env.FORAOFFICE_DSH_NODE
  )
    test.setTimeout(330_000)
  test.skip(process.platform !== 'win32', 'This acceptance target is the installed Windows Qt host')
  const executable =
    process.env.FORAOFFICE_QT_HOST ?? 'D:/temp/foraoffice-qt-build/docs-qt-host.exe'
  const packageRoot =
    process.env.FORAOFFICE_DOCS_PACKAGE_ROOT ?? resolve(__dirname, '../apps/docs/out/sdk')
  expect(existsSync(executable), 'Build the native Qt host first').toBe(true)
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-qt-'))
  const documents = join(root, 'documents')
  await mkdir(documents)
  const attached = join(documents, 'attached.txt')
  const knowledge = join(documents, 'knowledge.txt')
  await writeFile(attached, 'Qt attachment evidence')
  await writeFile(knowledge, 'Qt knowledge evidence')
  const recipients = join(documents, 'recipients.csv')
  await writeFile(recipients, 'Name\nAda\nGrace\n')
  const source = join(documents, 'source.docx')
  const picture = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  )
  const picturePath = join(documents, 'picked.png')
  await writeFile(picturePath, picture)
  const fixture = await JSZip.loadAsync(await buildBlankDocx())
  fixture.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Qt source text</w:t></w:r></w:p></w:body></w:document>',
  )
  await writeFile(source, await fixture.generateAsync({ type: 'nodebuffer' }))
  const reservation = createServer()
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No debugger port')
  const port = address.port
  await new Promise<void>((done) => reservation.close(() => done()))
  const child = spawn(
    executable,
    [
      '--package',
      packageRoot,
      '--node',
      process.execPath,
      '--workspace',
      documents,
      '--state',
      join(root, '.state'),
      '--open',
      source,
      '--language',
      'en',
      '--harness-stdio',
      '--attachment',
      attached,
      '--knowledge',
      knowledge,
    ],
    {
      env: {
        ...process.env,
        QTWEBENGINE_REMOTE_DEBUGGING: `127.0.0.1:${port}`,
        FORAOFFICE_DOCS_DIAGNOSTICS: '1',
        QT_FORCE_STDERR_LOGGING: '1',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let diagnostic = ''
  let stdout = ''
  let grant: { url: string; token: string } | undefined
  child.stderr.on('data', (data) => {
    diagnostic = (diagnostic + data).slice(-6000)
  })
  child.stdout.on('data', (data) => {
    stdout += data
    let newline: number
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      try {
        const message = JSON.parse(line)
        if (message.event === 'actionReady') grant = message.grant
      } catch {
        /* Qt diagnostic lines carry no protocol data. */
      }
    }
  })
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
  let page: Page | undefined
  let mcp: Client | undefined
  let succeeded = false
  let fileDialogOpen = false
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(`Qt exited ${child.exitCode}: ${diagnostic}`)
          try {
            return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
          } catch {
            return false
          }
        },
        { timeout: 45_000 },
      )
      .toBe(true)
    // Qt owns its existing profile and does not implement Chromium context management.
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
    const context = browser.contexts()[0]
    await expect
      .poll(() =>
        context.pages().find((page) => page.url().startsWith('foraoffice-docs://editor/')),
      )
      .toBeTruthy()
    page = context.pages().find((page) => page.url().startsWith('foraoffice-docs://editor/'))!
    page.on('pageerror', (error) => {
      diagnostic += `\nRenderer error: ${error.message}`
    })
    const body = page.locator('.ProseMirror').first()
    await expect(body).toHaveText('Qt source text', { timeout: 45_000 })
    const ribbonTabs = page.locator('.ribbon-tabs')
    await expect(ribbonTabs).toHaveCSS('padding-left', '10px')
    await expect(ribbonTabs).toHaveCSS('padding-right', '10px')
    await expect(ribbonTabs).toHaveCSS('-webkit-app-region', 'no-drag')
    const fileBox = await page.getByRole('button', { name: 'File', exact: true }).boundingBox()
    const saveBox = await page.locator('.qa-btn').first().boundingBox()
    const ribbonBox = await ribbonTabs.boundingBox()
    expect(fileBox!.x - ribbonBox!.x).toBe(10)
    expect(saveBox!.x - fileBox!.x - fileBox!.width).toBe(8)
    await ribbonTabs.screenshot({ path: test.info().outputPath('qt-embedded-ribbon.png') })
    const fileButton = page.getByRole('button', { name: 'File', exact: true })
    const initialState = await page.evaluate(() => window.docsEditor!.documents.state())
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        theme,
      )
      for (const keyboard of [false, true]) {
        await body.click()
        if (keyboard) {
          await fileButton.focus()
          await page.keyboard.press('ArrowDown')
        } else {
          await fileButton.click()
        }
        const first = page.getByRole('menuitem').first()
        await expect(first).toBeFocused()
        await expect(first).toHaveCSS('outline-style', keyboard ? 'solid' : 'none')
        const keyboardColor = await first.evaluate((item) => getComputedStyle(item).outlineColor)
        if (keyboard) {
          await page.keyboard.press('ArrowDown')
          await page.keyboard.press('ArrowDown')
          await expect(page.getByRole('menuitem', { name: /^Save As/ })).toBeFocused()
        }
        const invoked = keyboard
          ? page.keyboard.press('Enter')
          : page.getByRole('menuitem', { name: /^Save As/ }).click()
        fileDialogOpen = true
        await promisify(execFile)(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-File',
            resolve(__dirname, 'native-file-dialog.ps1'),
            '-TargetProcessId',
            String(child.pid),
            '-Cancel',
            '-RequireDialog',
          ],
          { timeout: 20_000 },
        )
        await invoked
        fileDialogOpen = false
        await expect(fileButton).toBeFocused()
        await expect(fileButton).toHaveCSS('outline-style', keyboard ? 'solid' : 'none')
        if (keyboard) {
          await expect(fileButton).toHaveCSS('outline-color', keyboardColor)
          await expect(fileButton).toHaveCSS('outline-offset', '2px')
        }
        expect(await page.evaluate(() => window.docsEditor!.documents.state())).toEqual(
          initialState,
        )
        await page.screenshot({
          path: test
            .info()
            .outputPath(`qt-file-focus-${theme}-${keyboard ? 'keyboard' : 'pointer'}.png`),
        })
      }
    }
    expect(await page.evaluate(() => 'desktop' in window)).toBe(false)
    await expect(page.locator('.ai-dock')).toHaveCount(0)
    await body.click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.insertText('Manual ')
    await expect(body).toHaveText('Manual Qt source text')
    await page.keyboard.press('Control+Home')
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.locator('.ai-ask-trigger').click()
    await expect.poll(() => !!grant).toBe(true)
    mcp = new Client({ name: 'qt-acceptance', version: '1' }, { capabilities: {} })
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(packageRoot, 'services/mcp-stdio.cjs')],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          FORAOFFICE_DOCS_ENDPOINT: grant!.url,
          FORAOFFICE_DOCS_TOKEN: grant!.token,
        },
      }),
    )
    const tool = async (name: string, input: Record<string, unknown>) => {
      const result = await mcp!.callTool({ name, arguments: input })
      if (result.isError) throw new Error(JSON.stringify(result.content))
      return result
    }
    await tool('replace_selection', { html: 'MCP' })
    await expect(body).toHaveText('MCP Qt source text')
    await tool('document_history', { action: 'undo' })
    await expect(body).toHaveText('Manual Qt source text')
    await tool('document_history', { action: 'redo' })
    const target = join(documents, 'saved.docx')
    expect((await tool('save_document', { path: target })).structuredContent).toMatchObject({
      committed: true,
      pending: false,
    })
    expect(
      await (
        await JSZip.loadAsync(await readFile(target))
      )
        .file('word/document.xml')!
        .async('string'),
    ).toContain('MCP')
    expect(JSON.stringify((await tool('read_attachment', { index: 0 })).content)).toContain(
      'Qt attachment evidence',
    )
    expect(
      JSON.stringify((await tool('search_knowledge_base', { query: 'evidence' })).content),
    ).toContain('Qt knowledge evidence')
    expect(JSON.stringify((await tool('read_knowledge_file', { index: 0 })).content)).toContain(
      'Qt knowledge evidence',
    )
    const converted = join(documents, 'cli-converted.md')
    const cli = await tool('run_cli', {
      args: ['convert', source, '--to', 'md', '--out', converted],
    })
    expect(cli.structuredContent).toMatchObject({ committed: true })
    expect(await readFile(converted, 'utf8')).toContain('Qt source text')
    await tool('get_document_context', {})
    for (const [type, content] of [
      ['md', '# Qt created Markdown'],
      ['html', '<html><body>Qt created HTML</body></html>'],
    ] as const) {
      expect(
        (await tool('create_document', { type, title: `Qt ${type}`, content })).structuredContent,
      ).toMatchObject({ committed: true })
      expect(await readFile(join(documents, `Qt ${type}.${type}`), 'utf8')).toBe(content)
    }
    expect(
      (
        await tool('create_document', {
          type: 'pdf',
          title: 'Qt PDF',
          content: '<p>Qt created PDF content</p>',
        })
      ).structuredContent,
    ).toMatchObject({ committed: true })
    const backend = createRequire(__filename)(
      join(packageRoot, 'services/services.cjs'),
    ) as typeof import('../apps/docs/src/services')
    const reader = await backend.createDocsResourceServices({
      stateDirectory: join(root, 'verification-state'),
      readRoots: [documents],
      writeRoots: [],
    })
    try {
      const pdf = join(documents, 'Qt PDF.pdf')
      await reader.setAttachments([pdf])
      expect((await reader.readAttachment(pdf, 0, 24_000)).text).toContain('Qt created PDF content')
      const exportedPdf = join(documents, 'Qt current document.pdf')
      const exported = page.evaluate(() =>
        (window as unknown as { __exportPdf(): Promise<boolean> }).__exportPdf(),
      )
      fileDialogOpen = true
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-File',
          resolve(__dirname, 'native-file-dialog.ps1'),
          '-TargetProcessId',
          String(child.pid),
          '-SaveFile',
          '-TargetFilePath',
          exportedPdf,
        ],
        { timeout: 20_000 },
      )
      fileDialogOpen = false
      expect(await exported).toBe(true)
      await reader.setAttachments([exportedPdf])
      expect((await reader.readAttachment(exportedPdf, 0, 24_000)).text).toContain(
        'MCP Qt source text',
      )
      const printed = await PDFDocument.load(await readFile(exportedPdf))
      expect(printed.getPageCount()).toBe(1)
      const sourceXml = await fixture.file('word/document.xml')!.async('string')
      // The fixture above replaces document.xml, so its missing section uses
      // the editor's Letter default (8.5 x 11 inches), rather than HTML's A4.
      expect(sourceXml).not.toContain('w:pgSz')
      expect(printed.getPage(0).getWidth()).toBeCloseTo(612, 0)
      expect(printed.getPage(0).getHeight()).toBeCloseTo(792, 0)
      for (const [format, label] of [
        ['html', 'Convert to HTML…'],
        ['md', 'Convert to Markdown…'],
      ] as const) {
        const output = join(documents, `Qt exported.${format}`)
        await page.getByRole('button', { name: 'File', exact: true }).click()
        await page.getByRole('menuitem', { name: label, exact: true }).click()
        fileDialogOpen = true
        await promisify(execFile)(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-File',
            resolve(__dirname, 'native-file-dialog.ps1'),
            '-TargetProcessId',
            String(child.pid),
            '-SaveFile',
            '-TargetFilePath',
            output,
          ],
          { timeout: 20_000 },
        )
        fileDialogOpen = false
        await expect
          .poll(
            async () =>
              existsSync(output) && (await readFile(output, 'utf8')).includes('MCP Qt source text'),
          )
          .toBe(true)
      }
    } finally {
      reader.dispose()
    }
    const priorPages = new Set(browser.contexts().flatMap((context) => context.pages()))
    const createdWord = await tool('create_document', {
      type: 'docx',
      title: 'Qt Word',
      content: '<p>Qt created Word content</p>',
    })
    expect(createdWord.structuredContent).toMatchObject({ committed: true })
    const createdWordPath = join(documents, 'Qt Word.docx')
    expect(
      await (
        await JSZip.loadAsync(await readFile(createdWordPath))
      )
        .file('word/document.xml')!
        .async('string'),
    ).toContain('Qt created Word content')
    await expect
      .poll(() =>
        browser!
          .contexts()
          .flatMap((context) => context.pages())
          .find(
            (candidate) =>
              !priorPages.has(candidate) && candidate.url().startsWith('foraoffice-docs://editor/'),
          ),
      )
      .toBeTruthy()
    const createdPage = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find(
        (candidate) =>
          !priorPages.has(candidate) && candidate.url().startsWith('foraoffice-docs://editor/'),
      )!
    await expect(createdPage.locator('.ProseMirror').first()).toHaveText('Qt created Word content')
    await createdPage.evaluate(() => window.close())
    await expect.poll(() => createdPage.isClosed()).toBe(true)
    await expect(body).toHaveText('MCP Qt source text')
    for (const harness of ['Codex', 'DSH'] as const) {
      if (
        harness === 'Codex' &&
        !process.env.FORAOFFICE_CODEX_WSL_BINARY &&
        !process.env.FORAOFFICE_CODEX_NODE_ENTRY
      )
        continue
      if (harness === 'DSH' && !process.env.FORAOFFICE_DSH_NODE) continue
      await body.click()
      await page.keyboard.press('Control+Home')
      for (let index = 0; index < 3; index++) await page.keyboard.press('Shift+ArrowRight')
      await expect.poll(() => page!.evaluate(() => window.getSelection()?.toString())).toBe('MCP')
      grant = undefined
      await page.locator('.ai-ask-trigger').click()
      await expect.poll(() => !!grant).toBe(true)
      const bridge = grant!
      const cwd = join(root, harness.toLowerCase())
      await mkdir(cwd)
      const modelOutput = join(documents, `${harness.toLowerCase()}-saved.docx`)
      const prompt = `Use the connected ForaOffice MCP tools to read the live Word document, change only the captured selected word from MCP to ${harness}, and save the live document to ${JSON.stringify(modelOutput)}. Keep all other text. Use the editing tools without filesystem or shell commands. Report completion only after the tools confirm the save.`
      if (harness === 'Codex') {
        const windowsSandbox = process.env.FORAOFFICE_CODEX_WINDOWS_SANDBOX
        if (
          windowsSandbox !== undefined &&
          windowsSandbox !== 'elevated' &&
          windowsSandbox !== 'mxc'
        )
          throw new Error('Unsupported Codex acceptance sandbox selection')
        const binary = process.env.FORAOFFICE_CODEX_WSL_BINARY
        const home = process.env.FORAOFFICE_CODEX_WSL_HOME
        if (binary && !home) throw new Error('The isolated Codex WSL home is required')
        await runRealCodexDocs({
          entry: process.env.FORAOFFICE_CODEX_NODE_ENTRY,
          cwd,
          bridge,
          prompt,
          windowsSandbox,
          wsl: binary
            ? {
                binary,
                home: home!,
                distribution: process.env.FORAOFFICE_CODEX_WSL_DISTRO ?? 'Ubuntu',
              }
            : undefined,
        })
      } else {
        const packages = process.env.FORAOFFICE_DSH_PACKAGES
        const credentials = process.env.FORAOFFICE_DSH_CREDENTIALS
        if (!packages || !credentials)
          throw new Error(
            'DSH acceptance needs the installed packages and Harness credential-store paths',
          )
        await runRealDshDocs({
          node: process.env.FORAOFFICE_DSH_NODE!,
          packages,
          credentials,
          cwd,
          bridge,
          prompt,
        })
      }
      await expect(body).toHaveText(`${harness} Qt source text`)
      expect(
        await (
          await JSZip.loadAsync(await readFile(modelOutput))
        )
          .file('word/document.xml')!
          .async('string'),
      ).toContain(`${harness} Qt source text`)
      await tool('read_document', {})
      await tool('replace_selection', { html: 'MCP' })
      await expect(body).toHaveText('MCP Qt source text')
      await tool('save_document', { path: target, overwrite: true })
    }
    const documentId = await page.evaluate(() => {
      const scope = window.docsEditor!.runtime.capture()
      scope.close()
      return scope.documentId
    })
    await page.keyboard.press('Control+o')
    fileDialogOpen = true
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        resolve(__dirname, 'native-file-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
        '-TargetFilePath',
        target,
        '-ScreenshotPath',
        join(root, 'native-open.png'),
      ],
      { timeout: 20_000 },
    )
    fileDialogOpen = false
    await expect
      .poll(() =>
        page!.evaluate(() => {
          const scope = window.docsEditor!.runtime.capture()
          scope.close()
          return scope.documentId
        }),
      )
      .not.toBe(documentId)
    await expect(body).toHaveText('MCP Qt source text')
    const stale = await mcp.callTool({
      name: 'replace_selection',
      arguments: { html: 'Late result' },
    })
    expect(stale.isError).toBe(true)
    await expect(body).toHaveText('MCP Qt source text')
    await body.click()
    await page.keyboard.press('Control+End')
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await page.getByRole('button', { name: 'Picture', exact: true }).click()
    fileDialogOpen = true
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        resolve(__dirname, 'native-file-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
        '-TargetFilePath',
        picturePath,
      ],
      { timeout: 20_000 },
    )
    fileDialogOpen = false
    const importedImage = page.locator('.ProseMirror img').first()
    await expect(importedImage).toBeVisible()
    expect(
      await importedImage.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1,
      ),
    ).toBe(true)
    await page.keyboard.press('Control+s')
    await expect
      .poll(async () => {
        const saved = await JSZip.loadAsync(await readFile(target))
        for (const entry of Object.values(saved.files)) {
          if (
            /^word\/media\//.test(entry.name) &&
            !entry.dir &&
            (await entry.async('nodebuffer')).equals(picture)
          )
            return true
        }
        return false
      })
      .toBe(true)
    const clipboard = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-File', resolve(__dirname, 'clipboard-guard.ps1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const clipboardLines = createInterface({ input: clipboard.stdout })
    let clipboardError = ''
    clipboard.stderr.on('data', (chunk) => {
      clipboardError += chunk
    })
    const clipboardExited = new Promise<number | null>((done) => clipboard.once('exit', done))
    try {
      await new Promise<void>((done, reject) => {
        clipboardLines.once('line', (line) =>
          line === 'ready' ? done() : reject(new Error('Clipboard guard was not ready')),
        )
        clipboard.once('error', reject)
        clipboard.once('exit', (code) =>
          reject(new Error(`Clipboard guard exited ${code}: ${clipboardError}`)),
        )
      })
      await importedImage.click()
      await page.keyboard.press('Control+c')
      await expect
        .poll(async () => {
          const result = await promisify(execFile)(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-STA',
              '-Command',
              'Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { [Console]::Write([System.Windows.Forms.Clipboard]::GetImage().Width) }',
            ],
            { timeout: 6000 },
          )
          return result.stdout
        })
        .toBe('1')
      await page.evaluate(() => navigator.clipboard.writeText(' Clipboard fixture'))
      await body.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.press('Control+v')
      await expect(body).toContainText('Clipboard fixture')
      await page.keyboard.press('Control+Home')
      for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
      const copiedText = await page.evaluate(() => window.getSelection()?.toString() ?? '')
      expect(copiedText.length).toBeGreaterThan(0)
      await page.evaluate(() => navigator.clipboard.writeText('Clipboard copy sentinel'))
      await page.keyboard.press('Control+c')
      await expect.poll(() => page!.evaluate(() => navigator.clipboard.readText())).toBe(copiedText)
      await page.keyboard.press('Control+s')
      await expect
        .poll(async () =>
          (
            await (
              await JSZip.loadAsync(await readFile(target))
            )
              .file('word/document.xml')!
              .async('string')
          ).includes('Clipboard fixture'),
        )
        .toBe(true)
    } finally {
      clipboard.stdin.end()
      expect(await clipboardExited, clipboardError).toBe(0)
      clipboardLines.close()
    }
    await body.click()
    await page.keyboard.press('Control+End')
    await page.getByRole('button', { name: 'Mailings', exact: true }).click()
    await page.getByRole('button', { name: 'Start Mail Merge', exact: true }).click()
    const mergePanel = page.locator('.modal-mailmerge')
    await mergePanel.getByRole('button', { name: 'Select Recipient List…', exact: true }).click()
    fileDialogOpen = true
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        resolve(__dirname, 'native-file-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
        '-TargetFilePath',
        recipients,
      ],
      { timeout: 20_000 },
    )
    fileDialogOpen = false
    await mergePanel
      .locator('.mailmerge-field')
      .filter({ hasText: /^Name$/ })
      .click()
    await mergePanel
      .getByRole('radio', { name: 'One document for all records', exact: true })
      .check()
    await mergePanel.getByRole('button', { name: 'Finish & Merge', exact: true }).click()
    const mergedPath = join(documents, 'merged.docx')
    fileDialogOpen = true
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        resolve(__dirname, 'native-file-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
        '-SaveFile',
        '-TargetFilePath',
        mergedPath,
      ],
      { timeout: 20_000 },
    )
    fileDialogOpen = false
    await expect
      .poll(async () => {
        if (!existsSync(mergedPath)) return false
        const xml = await (
          await JSZip.loadAsync(await readFile(mergedPath))
        )
          .file('word/document.xml')!
          .async('string')
        return xml.includes('Ada') && xml.includes('Grace') && xml.includes('Clipboard fixture')
      })
      .toBe(true)
    await mergePanel.getByRole('button', { name: 'Close', exact: true }).click()
    await page.keyboard.press('Control+s')
    await page.screenshot({ path: join(root, 'qt-rich-editor.png') })
    const savedGeneration = await page.evaluate(() => {
      const scope = window.docsEditor!.runtime.capture()
      scope.close()
      return scope.documentId
    })
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(' Unsaved lifecycle')
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        resolve(__dirname, 'native-file-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
        '-MenuCommand',
        'New',
        '-Decision',
        'Cancel',
      ],
      { timeout: 20_000 },
    )
    await expect(body).toContainText('Unsaved lifecycle')
    expect(
      await page.evaluate(() => {
        const scope = window.docsEditor!.runtime.capture()
        scope.close()
        return scope.documentId
      }),
    ).toBe(savedGeneration)
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        resolve(__dirname, 'native-file-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
        '-MenuCommand',
        'New',
        '-Decision',
        'Discard',
      ],
      { timeout: 20_000 },
    )
    await expect
      .poll(() =>
        page!.evaluate(() => {
          const scope = window.docsEditor!.runtime.capture()
          scope.close()
          return scope.documentId
        }),
      )
      .not.toBe(savedGeneration)
    await expect(body).toHaveText('')
    await body.click()
    await page.keyboard.insertText('Untitled Qt document')
    await page.keyboard.press('Control+s')
    await expect
      .poll(async () => {
        for (const name of await readdir(documents)) {
          if (!name.endsWith('.docx') || ['source.docx', 'saved.docx'].includes(name)) continue
          const zip = await JSZip.loadAsync(await readFile(join(documents, name)))
          if (
            (await zip.file('word/document.xml')!.async('string')).includes('Untitled Qt document')
          )
            return true
        }
        return false
      })
      .toBe(true)
    const saveAsPath = join(documents, 'qt-save-as.docx')
    fileDialogOpen = true
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        resolve(__dirname, 'native-file-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
        '-MenuCommand',
        'Save As',
        '-SaveFile',
        '-TargetFilePath',
        saveAsPath,
        '-ScreenshotPath',
        join(root, 'native-save-as.png'),
      ],
      { timeout: 20_000 },
    )
    fileDialogOpen = false
    await expect
      .poll(
        async () =>
          existsSync(saveAsPath) &&
          (
            await (
              await JSZip.loadAsync(await readFile(saveAsPath))
            )
              .file('word/document.xml')!
              .async('string')
          ).includes('Untitled Qt document'),
      )
      .toBe(true)
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(' Saved before new')
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        resolve(__dirname, 'native-file-dialog.ps1'),
        '-TargetProcessId',
        String(child.pid),
        '-MenuCommand',
        'New',
        '-Decision',
        'Save',
      ],
      { timeout: 20_000 },
    )
    await expect(body).toHaveText('')
    expect(
      await (
        await JSZip.loadAsync(await readFile(saveAsPath))
      )
        .file('word/document.xml')!
        .async('string'),
    ).toContain('Saved before new')
    await body.click()
    await page.keyboard.insertText('Disposable Qt document')
    await page.keyboard.press('Control+Home')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
    grant = undefined
    await page.locator('.ai-ask-trigger').click()
    await expect.poll(() => !!grant).toBe(true)
    await mcp.close()
    mcp = new Client({ name: 'qt-disposal-acceptance', version: '1' }, { capabilities: {} })
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(__dirname, '../apps/docs/out/services/mcp-stdio.cjs')],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          FORAOFFICE_DOCS_ENDPOINT: grant!.url,
          FORAOFFICE_DOCS_TOKEN: grant!.token,
        },
      }),
    )
    await tool('save_document', { path: join(documents, 'disposed.docx') })
    await page.screenshot({ path: join(root, 'qt-editor.png') })
    await page.evaluate(() => window.docsEditor!.dispose())
    const disposedRead = await mcp.callTool({ name: 'read_document', arguments: {} }, undefined, {
      signal: AbortSignal.timeout(2500),
    })
    expect(disposedRead.isError).toBe(true)
    succeeded = true
  } catch (error) {
    await writeFile(
      join(root, 'failure.txt'),
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
    throw error
  } finally {
    await writeFile(join(root, 'qt-stderr.log'), diagnostic)
    if (!succeeded && child.pid)
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-File',
          resolve(__dirname, 'native-file-dialog.ps1'),
          '-TargetProcessId',
          String(child.pid),
          '-Decision',
          'Cancel',
          '-TimeoutMs',
          '1000',
        ],
        { timeout: 5000 },
      ).catch(() => {})
    if (fileDialogOpen && child.pid)
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-File',
          resolve(__dirname, 'native-file-dialog.ps1'),
          '-TargetProcessId',
          String(child.pid),
          '-Cancel',
          '-TimeoutMs',
          '2000',
        ],
        { timeout: 6000 },
      ).catch(() => {})
    await mcp?.close()
    if (!succeeded) await page?.evaluate(() => window.docsEditor?.dispose()).catch(() => {})
    await browser?.close()
    if (child.exitCode === null && child.pid) {
      // A non-forced WM_CLOSE gives the owned Qt window its normal close/save guard.
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-File',
          resolve(__dirname, 'native-file-dialog.ps1'),
          '-TargetProcessId',
          String(child.pid),
          '-CloseWindow',
        ],
        { timeout: 6000 },
      )
    }
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          closeTimer = setTimeout(
            () => reject(new Error('The Qt host did not close normally: ' + diagnostic)),
            15_000,
          )
        }),
      ])
      await writeFile(join(root, 'qt-stderr.log'), diagnostic)
      expect(code).toBe(0)
    } finally {
      clearTimeout(closeTimer)
    }
  }
})
