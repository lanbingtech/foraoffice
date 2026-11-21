import { _electron as electron, chromium, type Browser, type Page } from '@playwright/test'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createPortReservation } from 'node:net'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { PDFDocument } from 'pdf-lib'
import {
  openWindowsNativeFocusInspector,
  type NativeImeEvidence,
  type NativeImeOwner,
} from './windows-native-ime'

export type PerformanceHost = 'qt' | 'electron' | 'browser'

export interface HostOptions {
  kind: PerformanceHost
  workspace: string
  document: string
  initialDocument?: string
  sdk: string
  electronApp: string
  qtExecutable: string
}

export interface PerformanceSession {
  page: Page
  nativeProcessId?: number
  activateForeground?(owner: NativeImeOwner): Promise<unknown>
  inspectNativeFocus?(processId: number): Promise<NativeImeEvidence>
  evidence: Record<string, unknown>
  open(): Promise<boolean | null>
  save(): Promise<void>
  exportPdf(timeoutMs?: number): Promise<string>
  close(): Promise<void>
}

const environment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>

export async function exportWithNativePicker(
  exportDocument: () => Promise<boolean>,
  choosePath: (signal: AbortSignal) => Promise<unknown>,
) {
  const controller = new AbortController()
  try {
    await Promise.all([
      exportDocument().then((exported) => {
        if (!exported) throw new Error('Qt product PDF export returned false')
      }),
      choosePath(controller.signal),
    ])
  } finally {
    controller.abort()
  }
}

async function reservePort(): Promise<number> {
  const reservation = createPortReservation()
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No debugger port')
  await new Promise<void>((done) => reservation.close(() => done()))
  return address.port
}

async function waitForDebugger(
  port: number,
  child: ChildProcess,
  spawnFailure: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const failure = spawnFailure()
    if (failure) throw failure
    if (child.exitCode !== null) throw new Error(`Qt exited: ${child.exitCode}`)
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return
    } catch {
      // The native process has not opened its debugger socket yet.
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('Qt debugger did not start')
}

async function nativeSaveDialog(
  pid: number,
  file: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-File',
      resolve(__dirname, 'native-file-dialog.ps1'),
      '-TargetProcessId',
      String(pid),
      '-SaveFile',
      '-TargetFilePath',
      file,
      '-TimeoutMs',
      String(timeoutMs),
    ],
    { timeout: timeoutMs + 10_000, windowsHide: true, signal },
  )
}

async function triggerPdf(page: Page, useVisiblePointer = false): Promise<void> {
  if (await page.locator('.pagination-preview').count()) {
    const button = page
      .locator('.pv-toolbar')
      .getByRole('button', { name: 'Export PDF', exact: true })
    if (useVisiblePointer) {
      // The browser preview toolbar is already onscreen. Avoid the driver's
      // automatic scroll through the complete print DOM after media restoration.
      const point = await button.evaluate(
        (element) => {
          const rect = element.getBoundingClientRect()
          const x = Math.floor(rect.x + rect.width / 2)
          const y = Math.floor(rect.y + rect.height / 2)
          if (
            !matchMedia('screen').matches ||
            rect.width <= 0 ||
            rect.height <= 0 ||
            element.matches(':disabled') ||
            !element.contains(document.elementFromPoint(x, y))
          )
            throw new Error('Browser preview export button does not own its pointer target')
          return { x, y }
        },
        undefined,
        { timeout: 75_000 },
      )
      await page.mouse.click(point.x, point.y)
    } else await button.click({ timeout: 30_000 })
    return
  }
  await page.getByRole('button', { name: 'File', exact: true }).click({ timeout: 30_000 })
  await page.getByRole('menuitem', { name: /PDF/ }).first().click({ timeout: 30_000 })
}

export async function launchPerformanceHost(options: HostOptions): Promise<PerformanceSession> {
  await mkdir(options.workspace, { recursive: true })
  const pdf = join(options.workspace, 'printed.pdf')
  if (options.kind === 'qt') {
    if (process.platform !== 'win32') throw new Error('Normal Qt baseline requires Windows')
    if (process.env.QT_QPA_PLATFORM && process.env.QT_QPA_PLATFORM !== 'windows')
      throw new Error('Qt performance baseline requires the normal Windows platform')
    const port = await reservePort()
    const child = spawn(
      options.qtExecutable,
      [
        '--package',
        options.sdk,
        '--node',
        process.execPath,
        '--workspace',
        options.workspace,
        '--state',
        join(options.workspace, 'profile'),
        '--open',
        options.initialDocument ?? options.document,
        '--language',
        'en',
      ],
      {
        windowsHide: true,
        env: {
          ...environment(),
          QTWEBENGINE_REMOTE_DEBUGGING: `127.0.0.1:${port}`,
          FORAOFFICE_DOCS_DIAGNOSTICS: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    let stderr = ''
    let spawnFailure: Error | undefined
    child.on('error', (error) => {
      spawnFailure = error
    })
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    let browser: Browser | undefined
    try {
      await waitForDebugger(port, child, () => spawnFailure)
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
      const context = browser.contexts()[0]
      const deadline = Date.now() + 30_000
      let page: Page | undefined
      while (!page && Date.now() < deadline) {
        page = context.pages().find((item) => item.url().startsWith('foraoffice-docs://editor/'))
        if (!page) await new Promise((done) => setTimeout(done, 100))
      }
      if (!page) throw new Error('Qt editor page did not load')
      const editorPage = page
      const debuggerVersion = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      delete debuggerVersion.webSocketDebuggerUrl
      return {
        page,
        nativeProcessId: child.pid,
        evidence: {
          kind: 'qt',
          rendering: 'normal-window',
          debuggerVersion,
          exportMethod: 'existing-product-exportPdf-callback-with-native-save-picker',
        },
        open: () =>
          editorPage.evaluate(async (path) => {
            const editor = (
              window as unknown as {
                docsEditor?: { documents: { open(id: string): Promise<boolean> } }
              }
            ).docsEditor
            if (!editor) throw new Error('Qt public editor endpoint is not ready')
            return editor.documents.open(path)
          }, options.document),
        async save() {
          await editorPage.keyboard.press('Control+s')
          await editorPage.waitForFunction(
            () =>
              (
                window as unknown as {
                  docsEditor?: { documents: { state(): { dirty: boolean } | null } }
                }
              ).docsEditor?.documents.state()?.dirty === false,
            undefined,
            { timeout: 180_000 },
          )
        },
        async exportPdf(timeoutMs = 180_000) {
          await exportWithNativePicker(
            () =>
              editorPage.evaluate(async () => {
                const exportPdf = (window as unknown as { __exportPdf?: () => Promise<boolean> })
                  .__exportPdf
                if (!exportPdf) throw new Error('Qt product PDF export callback is missing')
                return await exportPdf()
              }),
            (signal) => nativeSaveDialog(child.pid!, pdf, signal, timeoutMs),
          )
          return pdf
        },
        async close() {
          await writeFile(join(options.workspace, 'qt-stderr.log'), stderr)
          const timer = setTimeout(() => child.kill(), 5_000)
          try {
            await browser?.close()
          } finally {
            clearTimeout(timer)
            if (child.exitCode === null) child.kill()
          }
        },
      }
    } catch (error) {
      await writeFile(join(options.workspace, 'qt-stderr.log'), stderr)
      if (child.exitCode === null) child.kill()
      await browser?.close().catch(() => {})
      throw error
    }
  }
  if (options.kind === 'electron') {
    const require = createRequire(join(options.electronApp, 'package.json'))
    const app = await electron.launch({
      executablePath: require('electron') as string,
      args: [options.electronApp, options.initialDocument ?? options.document],
      env: {
        ...environment(),
        AI_OFFICE_USER_DATA: join(options.workspace, 'profile'),
        GENOFFICE_LANG: 'en',
      },
    })
    const child = app.process()
    try {
      const page = await app.firstWindow()
      await app.evaluate(
        ({ dialog, shell }, targets) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [targets.document],
          })) as typeof dialog.showOpenDialog
          dialog.showSaveDialog = (async () => ({
            canceled: false,
            filePath: targets.pdf,
          })) as typeof dialog.showSaveDialog
          shell.openPath = async () => ''
        },
        { document: options.document, pdf },
      )
      // The executable launcher can be a distinct process with no native window.
      const main = await app.evaluate(() => ({ pid: process.pid, versions: process.versions }))
      const focusInspector =
        process.platform === 'win32' ? openWindowsNativeFocusInspector() : undefined
      async function activateForeground(owner: NativeImeOwner) {
        const window = await app.browserWindow(page)
        try {
          const initial = await window.evaluate((w) => {
            const handle = w.getNativeWindowHandle()
            return {
              pid: process.pid,
              handle: (handle.length === 4
                ? handle.readUInt32LE()
                : handle.readBigUInt64LE()
              ).toString(),
              alwaysOnTop: w.isAlwaysOnTop(),
            }
          })
          if (initial.pid !== owner.targetProcessId || initial.handle !== owner.windowHandle)
            throw new Error('Electron BrowserWindow does not match the native measurement owner')
          try {
            // Expose the owned native caption before the guarded Windows mouse click.
            await window.evaluate((w) => {
              w.setAlwaysOnTop(true)
              w.moveTop()
            })
            const { stdout } = await promisify(execFile)(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                resolve(__dirname, 'native-owned-caption.ps1'),
                '-ProcessId',
                String(owner.targetProcessId),
                '-Handle',
                owner.windowHandle,
                '-StartUtc',
                owner.processStartTime,
              ],
              { windowsHide: true, timeout: 12_000, encoding: 'utf8' },
            )
            return JSON.parse(stdout)
          } finally {
            await window.evaluate((w, alwaysOnTop) => {
              w.setAlwaysOnTop(alwaysOnTop)
              if (w.isAlwaysOnTop() !== alwaysOnTop)
                throw new Error('Failed to restore the original Electron window layer')
            }, initial.alwaysOnTop)
          }
        } finally {
          await window.dispose()
        }
      }
      return {
        page,
        nativeProcessId: main.pid,
        inspectNativeFocus: focusInspector?.inspect,
        activateForeground: focusInspector ? activateForeground : undefined,
        evidence: {
          kind: 'electron',
          rendering: 'standalone-product',
          nativeFocusProbe: focusInspector
            ? 'persistent-win32-inspection'
            : 'not-applicable-non-windows-electron',
          versions: main.versions,
        },
        async open() {
          await page.keyboard.press('ControlOrMeta+o')
          return null
        },
        async save() {
          await page.keyboard.press('ControlOrMeta+s')
        },
        async exportPdf() {
          await triggerPdf(page)
          return pdf
        },
        async close() {
          const timer = setTimeout(() => child.kill(), 10_000)
          try {
            await app
              .evaluate(({ dialog }) => {
                dialog.showMessageBox = (async () => ({
                  response: 1,
                  checkboxChecked: false,
                })) as typeof dialog.showMessageBox
              })
              .catch(() => {})
            await app.close()
          } finally {
            clearTimeout(timer)
            if (child.exitCode === null && child.signalCode === null) child.kill()
            await focusInspector?.close()
          }
        },
      }
    } catch (error) {
      const timer = setTimeout(() => child.kill(), 10_000)
      try {
        await app.close()
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          `Electron startup failed: ${String(error)}; cleanup failed: ${String(cleanup)}`,
          { cause: cleanup },
        )
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
      throw error
    }
  }
  const browser = await chromium.launch({
    headless: true,
    channel:
      process.env.FORAOFFICE_BROWSER_CHANNEL ??
      (process.platform === 'win32' ? 'chrome' : undefined),
  })
  let page: Page
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  } catch (error) {
    await browser.close()
    throw error
  }
  const print = async (width: number, height: number, scale = 1) =>
    page.pdf({
      width: `${width / 1440}in`,
      height: `${height / 1440}in`,
      scale,
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/sdk/editor.css"></head><body style="margin:0"><div id="root"></div><script type="module">
  import {mountDocsEditor,createExternalDocsHost} from '/sdk/editor.js';
  const defaults={getLanguage:'en',getSystemLocale:'en-US',getTheme:'light',getDocumentTheme:'follow',getAuthorName:'Performance fixture',getAutoSaveDefault:{on:false,updatedAt:0},getAiPanelPrefs:{side:'left',fontSize:'default',spellcheck:false,openInNewDocs:false,showAiSidebar:false},spellLanguages:{active:[],available:[]},docPasswordIntentRevision:0,getRecentFiles:[]};
  const services=new Proxy({}, {get(_,name){if(name==='then')return undefined;if(name.startsWith('on'))return ()=>()=>{};if(name==='confirmDocumentReplace')return async()=>true;
  if(['printPdfBuffer','exportPdf','saveMergedPdf'].includes(name))return async(...args)=>(await fetch('/service/'+name,{method:'POST',body:JSON.stringify(args)})).json();return async()=>defaults[name];}});
  const host=createExternalDocsHost('browser',services);const doc=async(path='/document.docx')=>({id:'performance:document',name:'Benchmark.docx',data:await(await fetch(path)).arrayBuffer()});
  host.documents={autoSave:{enabled:false,onBlur:false,allowToggle:false},initialDocument:()=>doc('/initial.docx'),openDocument:()=>doc(),saveDocument:async r=>{await fetch('/saved.docx',{method:'POST',body:r.data});return{ok:true,committed:true,pending:false,document:{id:'performance:document',name:'Benchmark.docx'}}}};
  window.performanceEditor=await mountDocsEditor(document.getElementById('root'),{host});await window.performanceEditor.ready;window.performanceReady=true;
  </script></body></html>`
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (path === '/') {
        response.setHeader('content-type', 'text/html')
        response.end(html)
        return
      }
      if (path === '/document.docx' || path === '/initial.docx') {
        response.end(
          await readFile(
            path === '/initial.docx'
              ? (options.initialDocument ?? options.document)
              : options.document,
          ),
        )
        return
      }
      if (request.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const data = Buffer.concat(chunks)
        if (path === '/saved.docx') {
          await writeFile(options.document, data)
          response.end('{}')
          return
        }
        const args = JSON.parse(data.toString()) as unknown[]
        let result: object
        if (path === '/service/printPdfBuffer')
          result = {
            ok: true,
            base64: (await print(args[0] as number, args[1] as number, args[2] as number)).toString(
              'base64',
            ),
          }
        else if (path === '/service/exportPdf') {
          await writeFile(pdf, await print(args[1] as number, args[2] as number, args[4] as number))
          result = { ok: true, path: pdf }
        } else if (path === '/service/saveMergedPdf') {
          const merged = await PDFDocument.create()
          for (const part of args[1] as string[]) {
            const parsed = await PDFDocument.load(Buffer.from(part, 'base64'))
            for (const imported of await merged.copyPages(parsed, parsed.getPageIndices()))
              merged.addPage(imported)
          }
          await writeFile(pdf, await merged.save())
          result = { ok: true, path: pdf }
        } else throw new Error('Unsupported browser fixture service')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(result))
        return
      }
      if (!path.startsWith('/sdk/')) {
        response.writeHead(404).end()
        return
      }
      const root = join(options.sdk, 'embedded')
      const file = resolve(root, decodeURIComponent(path.slice(5)))
      if (!file.startsWith(root + sep)) {
        response.writeHead(403).end()
        return
      }
      response.setHeader(
        'content-type',
        (
          {
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
          } as Record<string, string>
        )[extname(file)] ?? 'application/octet-stream',
      )
      response.end(await readFile(file))
    } catch (error) {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: String(error) }))
    }
  })
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', done)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No browser fixture address')
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' })
  } catch (error) {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
    throw error
  }
  return {
    page,
    evidence: { kind: 'browser', rendering: 'headless-production-sdk', version: browser.version() },
    open: () =>
      page.evaluate(() =>
        (
          window as unknown as { performanceEditor: { documents: { open(): Promise<boolean> } } }
        ).performanceEditor.documents.open(),
      ),
    async save() {
      const saved = await page.evaluate(() =>
        (
          window as unknown as { performanceEditor: { documents: { save(): Promise<boolean> } } }
        ).performanceEditor.documents.save(),
      )
      if (!saved) throw new Error('Browser public save returned false')
    },
    async exportPdf() {
      await triggerPdf(page, true)
      return pdf
    },
    async close() {
      await browser.close()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
