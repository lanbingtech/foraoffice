import { BrowserWindow, type MessagePortMain, type WebContents } from 'electron'
import { isAbsolute } from 'node:path'

const STARTUP_TIMEOUT_MS = 30_000
const LAYOUT_PORT_CHANNEL = 'docs:layout-port'

export interface LayoutRendererOptions {
  /** Trusted entry and dedicated preload selected by the Docs main process. */
  rendererUrl: string
  preloadPath: string
  /** Initial native content size in device-independent pixels. Use layout state
   * to establish exact CSS dimensions inside the offscreen renderer. */
  width: number
  height: number
  deviceScaleFactor: number
}

const workers = new WeakMap<WebContents, (reason: Error) => void>()

/** Also call when a foreground tab is detached but its WebContents is retained. */
export function disposeLayoutRenderer(owner: WebContents): void {
  workers.get(owner)?.(new Error('Docs background layout canceled'))
}

function trustedLayoutUrl(owner: WebContents, value: string): string {
  const entry = new URL(value)
  const foreground = new URL(owner.getURL())
  const packaged =
    entry.protocol === 'genoffice-app:' &&
    entry.host === 'docs' &&
    foreground.protocol === entry.protocol &&
    foreground.host === entry.host
  const development =
    (entry.protocol === 'http:' || entry.protocol === 'https:') &&
    entry.origin === foreground.origin
  if ((!packaged && !development) || entry.username || entry.password)
    throw new Error('Untrusted Docs background layout entry')
  return entry.href
}

/** Transfers one end of an internal layout channel. A successful worker is owned
 * by the foreground tab until disposal or navigation. Failure closes the endpoint.
 */
export async function openLayoutRenderer(
  owner: WebContents,
  port: MessagePortMain,
  { rendererUrl, preloadPath, width, height, deviceScaleFactor }: LayoutRendererOptions,
): Promise<void> {
  disposeLayoutRenderer(owner)
  let entry: string
  let worker: BrowserWindow
  try {
    if (owner.isDestroyed()) throw new Error('Docs foreground renderer is closed')
    entry = trustedLayoutUrl(owner, rendererUrl)
    if (!isAbsolute(preloadPath)) throw new Error('Docs layout preload path must be absolute')
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
      throw new Error('Invalid Docs background layout viewport')
    worker = new BrowserWindow({
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      useContentSize: true,
      width,
      height,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        // Blink rounds layout metrics using the backing scale. Device
        // emulation alone changes the reported ratio without matching those metrics.
        offscreen: { deviceScaleFactor },
      },
    })
  } catch (error) {
    port.close()
    throw error
  }

  const contents = worker.webContents
  let transferred = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectStartup!: (reason: Error) => void
  const aborted = new Promise<never>((_, reject) => {
    rejectStartup = reject
  })
  // Event registration and loadURL can fail before the startup race is entered.
  void aborted.catch(() => {})
  const dispose = (reason: Error): void => {
    if (workers.get(owner) !== dispose) return
    workers.delete(owner)
    clearTimeout(timer)
    owner.off('did-start-navigation', onOwnerNavigation)
    owner.off('destroyed', onOwnerEnded)
    owner.off('render-process-gone', onOwnerEnded)
    if (!transferred) port.close()
    rejectStartup(reason)
    if (!worker.isDestroyed()) worker.destroy()
  }
  const onOwnerEnded = () => dispose(new Error('Docs foreground renderer stopped'))
  const onOwnerNavigation = (event: { isMainFrame: boolean }) => {
    if (event.isMainFrame) onOwnerEnded()
  }
  const onWorkerEnded = () => dispose(new Error('Docs background layout renderer stopped'))

  workers.set(owner, dispose)
  try {
    owner.on('did-start-navigation', onOwnerNavigation)
    owner.once('destroyed', onOwnerEnded)
    owner.once('render-process-gone', onOwnerEnded)
    worker.once('closed', onWorkerEnded)
    contents.once('render-process-gone', onWorkerEnded)
    contents.once('preload-error', (_event, _path, error) => dispose(error))
    contents.ipc.on('docs:layout-disposed', (event) => {
      if (event.senderFrame === contents.mainFrame) onWorkerEnded()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-frame-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && (transferred || event.url !== entry)) onWorkerEnded()
    })
    contents.startPainting()
    timer = setTimeout(
      () => dispose(new Error('Docs background layout renderer startup timed out')),
      STARTUP_TIMEOUT_MS,
    )
    await Promise.race([aborted, contents.loadURL(entry)])
    if (workers.get(owner) !== dispose || contents.isDestroyed() || owner.isDestroyed())
      throw new Error('Docs background layout canceled during startup')
    if (contents.mainFrame.url !== entry)
      throw new Error('Docs background layout navigated away from its entry')
    const workerPid = contents.getOSProcessId()
    const foregroundPid = owner.getOSProcessId()
    if (workerPid <= 0 || foregroundPid <= 0 || workerPid === foregroundPid)
      throw new Error('Docs background layout requires a separate renderer process')
    contents.mainFrame.postMessage(LAYOUT_PORT_CHANNEL, null, [port])
    transferred = true
  } catch (error) {
    dispose(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    clearTimeout(timer)
  }
}
