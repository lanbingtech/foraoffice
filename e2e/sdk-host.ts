import { _electron as electron, chromium, test, type Page } from '@playwright/test'
import type { BrowserWindow } from 'electron'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const sdkHostIsElectron = process.env.FORAOFFICE_SDK_TEST_HOST === 'electron'

interface Viewport {
  width: number
  height: number
}

/** The SDK assertions are shared; only the actual browser/window launcher differs. */
export interface SdkTestHost {
  newPage(options?: { viewport?: Viewport }): Promise<Page>
  printToPDF?(page: Page): Promise<Buffer>
  close(): Promise<void>
}

export async function launchSdkTestHost(): Promise<SdkTestHost> {
  if (!sdkHostIsElectron) {
    const browser = await chromium.launch({
      headless: true,
      channel:
        process.env.FORAOFFICE_BROWSER_CHANNEL ??
        (process.platform === 'win32' ? 'chrome' : undefined),
    })
    const evidence = {
      host: 'browser',
      platform: process.platform,
      version: browser.version(),
      channel:
        process.env.FORAOFFICE_BROWSER_CHANNEL ??
        (process.platform === 'win32' ? 'chrome' : 'chromium'),
    }
    await writeFile(
      test.info().outputPath('sdk-host-engine.json'),
      JSON.stringify(evidence, null, 2),
    )
    await test.info().attach('SDK host engine', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
    return browser
  }

  const artifacts = join(tmpdir(), 'foraoffice-host-tests', 'electron-parity')
  await mkdir(artifacts, { recursive: true })
  const workspace = await mkdtemp(join(artifacts, 'sdk-electron-'))
  const main = join(workspace, 'main.cjs')
  await writeFile(
    main,
    `
    const {app} = require('electron');
    app.setPath('userData', ${JSON.stringify(join(workspace, 'profile'))});
    app.disableHardwareAcceleration();
    app.on('window-all-closed', () => {});
    app.whenReady();
  `,
  )
  const require = createRequire(resolve(__dirname, '../apps/shell/package.json'))
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env))
    if (name !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) environment[name] = value
  const app = await electron.launch({
    executablePath: require('electron') as string,
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []), main],
    env: environment,
  })
  try {
    const engine = await app.evaluate(async ({ app }) => {
      await app.whenReady()
      return { platform: process.platform, versions: process.versions }
    })
    const evidence = {
      host: 'electron',
      rendering: 'offscreen',
      ...engine,
      isolatedUserData: join(workspace, 'profile'),
    }
    await writeFile(
      test.info().outputPath('sdk-host-engine.json'),
      JSON.stringify(evidence, null, 2),
    )
    await test.info().attach('SDK host engine', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
    return {
      async newPage(options) {
        const viewport = options?.viewport ?? { width: 1280, height: 720 }
        const created = app.waitForEvent('window')
        await app.evaluate(({ BrowserWindow }, size) => {
          const window = new BrowserWindow({
            width: size.width,
            height: size.height,
            show: false,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              backgroundThrottling: false,
              offscreen: true,
            },
          })
          void window.loadURL('about:blank')
        }, viewport)
        const page = await created
        await page.setViewportSize(viewport)
        return page
      },
      async printToPDF(page) {
        const window = await app.browserWindow(page)
        try {
          return Buffer.from(
            await window.evaluate(async (window: BrowserWindow) =>
              Array.from(await window.webContents.printToPDF({ printBackground: true })),
            ),
          )
        } finally {
          await window.dispose()
        }
      },
      close: () => app.close(),
    }
  } catch (error) {
    await app.close()
    throw error
  }
}
