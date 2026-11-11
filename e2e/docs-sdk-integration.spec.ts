import { test, expect, chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import { createRequire } from 'node:module'
import type { PdfiumModule } from '../packages/pdf2docx/src'
import type { DocsEditorHandle } from '../apps/docs/src/renderer/embedded'
import type { DocsFileMenuAction } from '../apps/docs/src/renderer/sdk/file-menu'
import { withPdfDocument } from '../packages/pdf2docx/src/extract/pdfium'
import { renderPageByIndexPng } from '../packages/pdf2docx/src/extract'

const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
type FixtureWindow = Window & {
  editor: DocsEditorHandle
  sdkReady: boolean
  fixture: {
    saved: number[]
    fallback: string[]
    readonly: boolean
    cancel: boolean
    menuActions: DocsFileMenuAction[]
    documentStates: boolean[]
    saveKinds: boolean[]
  }
}

test('the real Qt public SDK preserves DOCX resources and identical printed content with view annotations', async () => {
  test.skip(process.platform !== 'win32', 'Native Qt fixture uses the configured Windows build')
  test.setTimeout(180_000)
  const executable =
    process.env.FORAOFFICE_QT_SDK_TEST ?? 'D:/temp/foraoffice-qt-build/docs-qt-sdk-test.exe'
  const output = await mkdtemp(join(tmpdir(), 'foraoffice-sdk-output-'))
  const cache = await readFile(join(dirname(executable), 'CMakeCache.txt'), 'utf8')
  const qtConfig = /^Qt6_DIR:PATH=(.+)$/m.exec(cache)?.[1].trim()
  if (!qtConfig) throw new Error('The Qt SDK test build has no Qt6_DIR')
  const qtBin = resolve(qtConfig, '../../../bin')
  await promisify(execFile)(executable, ['-o', join(output, 'native-results.txt') + ',txt'], {
    timeout: 170_000,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: qtBin + ';' + process.env.PATH,
      FORAOFFICE_QT_TEST_NODE: process.execPath,
      FORAOFFICE_QT_TEST_PACKAGE: resolve(__dirname, '../apps/docs/out/sdk'),
      FORAOFFICE_QT_TEST_RESULTS: output,
    },
  })
  const archive = await JSZip.loadAsync(await readFile(join(output, 'hosted.docx')))
  const xml = await archive.file('word/document.xml')!.async('string')
  expect(xml).toContain('word')
  expect(xml).not.toContain('sdk-range-decoration')
  expect(xml).not.toContain('sdk-annotation')
  const pictures = Object.values(archive.files).filter(
    (file) => file.name.startsWith('word/media/') && !file.dir,
  )
  expect(pictures.length).toBeGreaterThan(0)
  expect(await pictures[0].async('base64')).toBe(image)
  const require = createRequire(__filename)
  const { init } = await import('@embedpdf/pdfium')
  const wasm = await readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
  const wrapped = await init({
    wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  })
  const module = (wrapped.pdfium ?? wrapped) as unknown as PdfiumModule & {
    _PDFiumExt_Init(): void
  }
  module._PDFiumExt_Init()
  const render = (bytes: Uint8Array) =>
    withPdfDocument(module, bytes, (document) =>
      Array.from({ length: module._FPDF_GetPageCount(document) }, (_, index) => {
        const page = renderPageByIndexPng(module, document, index, 1)
        if (!page) throw new Error('Could not render native print output')
        return page.png
      }),
    )
  const decorated = render(await readFile(join(output, 'annotated.pdf')))
  const clean = render(await readFile(join(output, 'clean.pdf')))
  expect(decorated.length).toBeGreaterThan(0)
  expect(decorated).toEqual(clean)
})

test('a browser host owns pathless storage while native inspection and advisory annotations keep their semantics', async () => {
  test.setTimeout(120_000)
  const root = resolve(__dirname, '../apps/docs/out/embedded')
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/') {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><html><head><link rel="stylesheet" href="/sdk/editor.css"></head><body>
        <div id="root"></div><script type="module">
        import {mountDocsEditor,createExternalDocsHost} from '/sdk/editor.js';
        const defaults={getLanguage:'en',getSystemLocale:'en-US',getTheme:'light',getDocumentTheme:'follow',
          getAuthorName:'SDK fixture',getAutoSaveDefault:{on:false,updatedAt:0},
          getAiPanelPrefs:{side:'left',fontSize:'default',spellcheck:false,openInNewDocs:false,showAiSidebar:false},
          spellLanguages:{active:[],available:[]},docPasswordIntentRevision:0};
        window.fixture={saved:[],fallback:[],readonly:false,cancel:false,menuActions:[],documentStates:[],saveKinds:[]};
        const services=new Proxy({}, {get(_,name){
          if(name==='then')return undefined;
          if(name.startsWith('on'))return ()=>()=>{};
          if(name==='confirmDocumentReplace')return async()=>true;
          if(name==='readImageSource')return async()=>({base64:'${image}',mime:'image/png',name:'fixture.png'});
          return async(...args)=>{if(name.startsWith('saveDocx'))window.fixture.fallback.push(name);return defaults[name];};
        }});
        const host=createExternalDocsHost('browser',services);
        const doc=()=>({id:'browser:object',name:'Browser.docx',readOnly:window.fixture.readonly,
          ...(window.fixture.saved.length?{data:Uint8Array.from(window.fixture.saved).buffer}:{})});
        host.documents={autoSave:{enabled:true,intervalMs:600000,onBlur:true},initialDocument:async()=>location.search.includes('empty')?null:doc(),
          newDocument:async()=>window.fixture.cancel?null:doc(),openDocument:async()=>doc(),
          saveDocument:async r=>{window.fixture.saved=Array.from(new Uint8Array(r.data));window.fixture.saveKinds.push(r.auto);
            return {ok:true,committed:true,pending:false,document:{id:'browser:object',name:'Browser.docx'}};}};
        host.checkers={fixture:s=>{const at=s.text.indexOf('[');return at<0?[]:[{from:s.positions[at],to:s.positions[at]+1,message:'Fixture diagnostic'}];}};
        window.editor=await mountDocsEditor(document.getElementById('root'),{host});
        await window.editor.ready;window.sdkReady=true;
        window.remountSdk=async()=>{
          const old=window.editor.documents;
          let finishOpen;
          host.documents.openDocument=()=>new Promise(resolve=>{finishOpen=resolve;});
          const pendingOpen=old.open();
          window.editor.dispose();
          const replacement=createExternalDocsHost('browser',services);
          window.fixture.newHostCalls=0;
          replacement.documents={...host.documents,newDocument:async()=>{window.fixture.newHostCalls++;return doc();}};
          window.editor=await mountDocsEditor(document.getElementById('root'),{host:replacement});
          await window.editor.ready;
          finishOpen(doc());
          const oldOpenResult=await pendingOpen;
          let refused=false;try{await old.new();}catch{refused=true;}
          return {refused,calls:window.fixture.newHostCalls,oldOpenResult};
        };
        </script></body></html>`)
      return
    }
    try {
      if (!path.startsWith('/sdk/')) {
        response.writeHead(404).end()
        return
      }
      const file = resolve(root, decodeURIComponent(path.slice(5)))
      if (!file.startsWith(root + sep)) {
        response.writeHead(403).end()
        return
      }
      response.setHeader(
        'content-type',
        (
          { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<
            string,
            string
          >
        )[extname(file)] ?? 'application/octet-stream',
      )
      response.end(await readFile(file))
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No browser fixture port')
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const errors: string[] = []
  try {
    browser = await chromium.launch({
      headless: true,
      // Windows uses the installed browser; CI elsewhere can use Playwright's bundled Chromium.
      channel:
        process.env.FORAOFFICE_BROWSER_CHANNEL ??
        (process.platform === 'win32' ? 'chrome' : undefined),
    })
    for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
      const layoutPage = await browser.newPage({ viewport: { width: 1360, height: 900 } })
      try {
        await layoutPage.addInitScript((platform) => {
          Object.defineProperty(navigator, 'platform', { get: () => platform })
        }, platform)
        await layoutPage.goto(`http://127.0.0.1:${address.port}/`)
        await layoutPage.waitForFunction(() => (window as unknown as FixtureWindow).sdkReady)
        for (const theme of ['light', 'dark']) {
          await layoutPage.evaluate(
            (theme) => document.documentElement.setAttribute('data-theme', theme),
            theme,
          )
          const tabs = layoutPage.locator('.ribbon-tabs')
          await expect(tabs).toHaveCSS('padding-left', '10px')
          await expect(tabs).toHaveCSS('padding-right', '10px')
          await expect(tabs).toHaveCSS('-webkit-app-region', 'no-drag')
          const file = await layoutPage
            .getByRole('button', { name: 'File', exact: true })
            .boundingBox()
          const save = await layoutPage.locator('.qa-btn').first().boundingBox()
          const row = await tabs.boundingBox()
          expect(file!.x - row!.x, `${platform} ${theme} File inset`).toBe(10)
          // Native File styling has a 6px margin plus the row's 2px gap.
          expect(save!.x - file!.x - file!.width, `${platform} ${theme} File/Save gap`).toBe(8)
          await layoutPage.screenshot({
            path: test.info().outputPath(`embedded-${platform.split(' ')[0]}-${theme}.png`),
          })
          await layoutPage.locator('.ProseMirror').first().click()
          await layoutPage.keyboard.insertText('Focus fixture')
          const fileButton = layoutPage.getByRole('button', { name: 'File', exact: true })
          await fileButton.click()
          const entries = layoutPage.getByRole('menuitem')
          await expect(entries.first()).toBeFocused()
          await expect(entries.first()).toHaveCSS('outline-style', 'none')
          await expect(entries.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
          await layoutPage.keyboard.press('ArrowDown')
          await expect(entries.nth(1)).toBeFocused()
          await expect(entries.nth(1)).toHaveCSS('outline-style', 'solid')
          const focusColor = await entries
            .nth(1)
            .evaluate((item) => getComputedStyle(item).outlineColor)
          await layoutPage.keyboard.press('Escape')
          await expect(fileButton).toBeFocused()
          await expect(fileButton).toHaveCSS('outline-style', 'solid')
          await expect(fileButton).toHaveCSS('outline-color', focusColor)
          await expect(fileButton).toHaveCSS('outline-offset', '2px')
          await layoutPage.keyboard.press('ArrowUp')
          await expect(entries.last()).toBeFocused()
          await layoutPage.keyboard.press('Home')
          await expect(entries.first()).toBeFocused()
          await layoutPage.keyboard.press('Tab')
          await expect(layoutPage.getByRole('menu')).toHaveCount(0)
          await expect(layoutPage.locator('.qa-btn').first()).toBeFocused()
          await layoutPage.keyboard.press('Shift+Tab')
          await expect(fileButton).toBeFocused()
          await expect(fileButton).toHaveCSS('outline-style', 'solid')
          await layoutPage.keyboard.press('Enter')
          await expect(entries.first()).toBeFocused()
          await expect(entries.first()).toHaveCSS('outline-style', 'solid')
          await layoutPage.keyboard.press('Escape')
        }
      } finally {
        await layoutPage.close()
      }
    }
    const page = await browser.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/?empty`)
    await page.waitForFunction(() => (window as unknown as FixtureWindow).sdkReady)
    expect(
      await page.evaluate(() => (window as unknown as FixtureWindow).editor.documents.state()),
    ).toBeNull()
    expect(
      await page.evaluate(() => (window as unknown as FixtureWindow).editor.documents.new()),
    ).toBe(true)
    const body = page.locator('.ProseMirror').first()
    await body.click()
    await page.keyboard.insertText('same same same [invalid')
    const bodyInstance = await body.elementHandle()
    const beforeMenu = await page.evaluate(() => {
      const target = window as unknown as FixtureWindow
      const { editor } = target
      const state = editor.documents.state()!
      editor.ui.fileMenu.onAction((event) => target.fixture.menuActions.push(event))
      editor.ui.fileMenu.set({
        documentToken: state.documentToken,
        items: [
          { type: 'command', id: 'save', command: 'save' },
          {
            type: 'submenu',
            id: 'workflow',
            label: 'Workflow',
            items: [{ type: 'action', id: 'publish', actionId: 'host.publish', label: 'Publish' }],
          },
        ],
      })
      return { snapshot: editor.inspection.snapshot(), state }
    })
    const fileButton = page.getByRole('button', { name: 'File', exact: true })
    const fileBox = await fileButton.boundingBox()
    const saveBox = await page.locator('.qa-btn').first().boundingBox()
    expect(fileBox!.x + fileBox!.width).toBeLessThanOrEqual(saveBox!.x + 1)
    await fileButton.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: /^Save/ })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menuitem', { name: 'Publish', exact: true })).toBeFocused()
    await expect(page.getByRole('menuitem', { name: 'Publish', exact: true })).toHaveCSS(
      'outline-style',
      'solid',
    )
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Workflow' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(fileButton).toBeFocused()
    await fileButton.click()
    await page.getByRole('menuitem', { name: 'Workflow' }).click()
    await page.getByRole('menuitem', { name: 'Publish', exact: true }).click()
    expect(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.menuActions),
    ).toEqual([
      expect.objectContaining({
        actionId: 'host.publish',
        documentToken: beforeMenu.state.documentToken,
      }),
    ])
    await page.evaluate(() => {
      const { editor } = window as unknown as FixtureWindow
      editor.ui.fileMenu.set({
        documentToken: editor.documents.state()!.documentToken,
        items: [
          { type: 'command', id: 'save', command: 'save', visible: false },
          {
            type: 'action',
            id: 'publish',
            actionId: 'host.publish',
            label: 'Published',
            enabled: false,
          },
        ],
      })
    })
    await fileButton.click()
    await expect(page.getByRole('menuitem', { name: 'Published' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: /^Save/ })).toHaveCount(0)
    expect(
      await page.evaluate(() => {
        const { editor } = window as unknown as FixtureWindow
        return { snapshot: editor.inspection.snapshot(), state: editor.documents.state() }
      }),
    ).toEqual(beforeMenu)
    expect(await body.evaluate((element, original) => element === original, bodyInstance)).toBe(
      true,
    )
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as FixtureWindow).editor.documents.state()?.dirty),
      )
      .toBe(false)
    expect(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.saveKinds),
    ).toContain(true)
    await body.click()
    await page.keyboard.insertText(' ')
    await page.keyboard.press('Control+s')
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as FixtureWindow).editor.documents.state()?.dirty),
      )
      .toBe(false)
    await page.evaluate(() => (window as unknown as FixtureWindow).editor.ui.fileMenu.reset())
    const results = await page.evaluate(async () => {
      const editor = (window as unknown as FixtureWindow).editor
      const found = editor.inspection.find('(same)', { mode: 'regex' })
      editor.inspection.locate(found.matches[1])
      editor.annotations.setRules('display', [
        { id: 'all', pattern: 'same', style: { background: 'yellow' } },
      ])
      await editor.annotations.refresh()
      const diagnostics = editor.annotations.diagnostics()
      const count = editor.inspection.replace(found, '$1!')
      await editor.documents.save()
      return {
        count,
        diagnostics,
        text: editor.inspection.snapshot().text,
        state: editor.documents.state(),
        bytes: (window as unknown as FixtureWindow).fixture.saved,
        fallback: (window as unknown as FixtureWindow).fixture.fallback,
      }
    })
    expect(results.count).toBe(3)
    expect(results.diagnostics).toHaveLength(1)
    expect(results.text).toContain('same! same! same!')
    expect(results.state.path).toBeNull()
    expect(results.fallback).toEqual([])
    const archive = await JSZip.loadAsync(Uint8Array.from(results.bytes))
    expect(await archive.file('word/document.xml')!.async('string')).not.toContain(
      'sdk-range-decoration',
    )
    await page.evaluate(async () => {
      const target = window as unknown as FixtureWindow
      target.fixture.readonly = true
      await target.editor.documents.open()
    })
    expect(
      await page.evaluate((token) => {
        const { editor } = window as unknown as FixtureWindow
        try {
          editor.ui.fileMenu.set({ documentToken: token, items: [] })
          return false
        } catch {
          return true
        }
      }, beforeMenu.state.documentToken),
    ).toBe(true)
    await expect(body).toHaveAttribute('contenteditable', 'false')
    expect(
      await page.evaluate(
        () => (window as unknown as FixtureWindow).editor.documents.state()?.dirty,
      ),
    ).toBe(false)
    expect(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.saveKinds.at(-1)),
    ).toBe(false)
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).editor.annotations.setRules('readonly', [
        { id: 'read', pattern: 'same', style: { underline: true } },
      ]),
    )
    await expect(page.locator('.sdk-range-decoration').first()).toBeVisible()
    await page.evaluate(async () => {
      const target = window as unknown as FixtureWindow
      target.editor.documents.subscribe((state) =>
        target.fixture.documentStates.push(!!state?.readOnly),
      )
      target.fixture.readonly = false
      await target.editor.documents.open()
    })
    await expect(body).toHaveAttribute('contenteditable', 'true')
    expect(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.documentStates.at(-1)),
    ).toBe(false)
    expect(
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.documentStates.slice(1),
      ),
    ).not.toContain(true)
    expect(errors).toEqual([])
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { remountSdk(): Promise<{ refused: boolean; calls: number }> }
        ).remountSdk(),
      ),
    ).toEqual({ refused: true, calls: 0, oldOpenResult: false })
  } finally {
    await browser?.close()
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    )
  }
})
