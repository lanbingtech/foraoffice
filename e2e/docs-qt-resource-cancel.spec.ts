import { test, expect, chromium } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

test('Qt cancels an in-flight resource without calling a destroyed request job', async () => {
  test.skip(process.platform !== 'win32', 'Actual installed Windows Qt regression target')
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-qt-cancel-'))
  const bundle = join(root, 'package')
  await mkdir(join(bundle, 'qt'), { recursive: true })
  await mkdir(join(bundle, 'services'))
  await copyFile(
    resolve(__dirname, 'fixtures/docs-slow-backend.cjs'),
    join(bundle, 'services/node-host.cjs'),
  )
  await copyFile(
    resolve(__dirname, '../apps/docs/out/qt/native-strings.json'),
    join(bundle, 'qt/native-strings.json'),
  )
  await writeFile(
    join(bundle, 'qt/index.html'),
    '<!doctype html><title>Qt resource cancellation</title><script src="/bootstrap.js"></script>',
  )
  await writeFile(
    join(bundle, 'qt/bootstrap.js'),
    `
    window.resourceStatus = 'ready';
    window.startResource = index => {
      window.resourceStatus = 'pending';
      window.resourceController = new AbortController();
      fetch('genoffice-docx-media://fixture/pending-' + index, {signal: window.resourceController.signal})
        .then(response => response.arrayBuffer()).then(() => { window.resourceStatus = 'unexpected completion'; },
          error => { window.resourceStatus = error.name; });
    };
    window.cancelResource = () => window.resourceController.abort();
  `,
  )
  const reservation = createServer()
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No debugger port')
  const port = address.port
  await new Promise<void>((done) => reservation.close(() => done()))
  const child = spawn(
    process.env.FORAOFFICE_QT_HOST ?? 'D:/temp/foraoffice-qt-build/docs-qt-host.exe',
    [
      '--package',
      bundle,
      '--node',
      process.execPath,
      '--workspace',
      root,
      '--state',
      join(root, '.state'),
      '--language',
      'zh',
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        QTWEBENGINE_REMOTE_DEBUGGING: `127.0.0.1:${port}`,
        FORAOFFICE_DOCS_DIAGNOSTICS: '1',
        QT_FORCE_STDERR_LOGGING: '1',
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  )
  let diagnostic = ''
  child.stderr.on('data', (data) => {
    diagnostic += data
  })
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await expect
      .poll(async () => {
        if (child.exitCode !== null) throw new Error(`Qt exited ${child.exitCode}: ${diagnostic}`)
        try {
          return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
        } catch {
          return false
        }
      })
      .toBe(true)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
    const page = browser.contexts()[0].pages()[0]
    await page.waitForFunction(() => 'startResource' in window)
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
        '-ExpectedFileMenuLabel',
        '文件',
      ],
      { timeout: 6000 },
    )
    for (let index = 0; index < 3; index++) {
      await page.evaluate(
        (index) =>
          (window as unknown as { startResource(index: number): void }).startResource(index),
        index,
      )
      await expect
        .poll(() => (diagnostic.match(/Docs asset: headers status=200/g) ?? []).length)
        .toBe(index + 1)
      await page.evaluate(() => (window as unknown as { cancelResource(): void }).cancelResource())
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { resourceStatus: string }).resourceStatus),
        )
        .toBe('AbortError')
    }
    expect(await page.title()).toBe('Qt resource cancellation')
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.pid)
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
    try {
      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          closeTimer = setTimeout(
            () => reject(new Error('The resource fixture host did not close')),
            10_000,
          )
        }),
      ])
      await writeFile(join(root, 'qt-stderr.log'), diagnostic)
      expect(code, diagnostic).toBe(0)
    } finally {
      clearTimeout(closeTimer)
    }
  }
})
