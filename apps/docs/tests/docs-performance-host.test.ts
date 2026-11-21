// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launches = vi.hoisted(() => ({ browser: vi.fn(), electron: vi.fn() }))
const inspectNative = vi.hoisted(() => ({ open: vi.fn(), inspect: vi.fn(), close: vi.fn() }))
vi.mock('@playwright/test', () => ({
  chromium: { launch: launches.browser },
  _electron: { launch: launches.electron },
}))
vi.mock('../../../e2e/windows-native-ime', () => ({
  openWindowsNativeFocusInspector: inspectNative.open,
}))
import { launchPerformanceHost, exportWithNativePicker } from '../../../e2e/docs-performance-host'

it('rejects a false product export immediately and aborts a picker that never appears', async () => {
  let signal: AbortSignal | undefined
  const pending = exportWithNativePicker(
    async () => false,
    (active) => {
      signal = active
      return new Promise(() => {})
    },
  )
  await expect(pending).rejects.toThrow('Qt product PDF export returned false')
  expect(signal?.aborted).toBe(true)
}, 200)

it.each(['win32', 'darwin', 'linux'] as const)(
  'launches Electron on %s with a primer and uses native inspection only on Windows',
  async (platform) => {
    const workspace = await mkdtemp(join(tmpdir(), 'docs-perf-host-'))
    const actualPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform })
    inspectNative.open.mockReset().mockReturnValue(inspectNative)
    inspectNative.close.mockReset()
    try {
      await mkdir(join(workspace, 'node_modules/electron'), { recursive: true })
      await writeFile(join(workspace, 'package.json'), '{}')
      await writeFile(
        join(workspace, 'node_modules/electron/index.js'),
        'module.exports=process.execPath',
      )
      const press = vi.fn().mockResolvedValue(undefined)
      const evaluate = vi
        .fn()
        .mockResolvedValue(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ pid: 34, versions: { electron: '43.8.3' } })
      launches.electron.mockResolvedValue({
        firstWindow: async () => ({ keyboard: { press } }),
        evaluate,
        process: () => ({ pid: 12, exitCode: 0, signalCode: null }),
        close: async () => {},
      })
      const session = await launchPerformanceHost({
        kind: 'electron',
        workspace,
        document: 'sample.docx',
        initialDocument: 'primer.docx',
        sdk: '',
        electronApp: workspace,
        qtExecutable: '',
      })
      expect(launches.electron.mock.lastCall![0].args).toEqual([workspace, 'primer.docx'])
      expect(session.nativeProcessId).toBe(34)
      expect(evaluate.mock.calls[0][1]).toMatchObject({ document: 'sample.docx' })
      const windows = platform === 'win32'
      expect(session.inspectNativeFocus).toBe(windows ? inspectNative.inspect : undefined)
      expect(typeof session.activateForeground).toBe(windows ? 'function' : 'undefined')
      expect(inspectNative.open).toHaveBeenCalledTimes(windows ? 1 : 0)
      await session.open()
      await session.save()
      expect(press.mock.calls).toEqual([['ControlOrMeta+o'], ['ControlOrMeta+s']])
      await session.close()
      expect(inspectNative.close).toHaveBeenCalledTimes(windows ? 1 : 0)
    } finally {
      Object.defineProperty(process, 'platform', actualPlatform)
      await rm(workspace, { recursive: true, force: true })
    }
  },
)

it('closes the browser when creating its first page fails before returning a session', async () => {
  const close = vi.fn().mockResolvedValue(undefined)
  launches.browser.mockResolvedValue({
    newPage: vi.fn().mockRejectedValue(new Error('newPage failed')),
    close,
  })
  const workspace = await mkdtemp(join(tmpdir(), 'docs-perf-host-'))
  try {
    await expect(
      launchPerformanceHost({
        kind: 'browser',
        workspace,
        document: '',
        sdk: '',
        electronApp: '',
        qtExecutable: '',
      }),
    ).rejects.toThrow('newPage failed')
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it('kills its live Electron process when close rejects and preserves the startup failure', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'docs-perf-host-'))
  try {
    await mkdir(join(workspace, 'node_modules/electron'), { recursive: true })
    await writeFile(join(workspace, 'package.json'), '{}')
    await writeFile(
      join(workspace, 'node_modules/electron/index.js'),
      'module.exports=process.execPath',
    )
    const kill = vi.fn()
    launches.electron.mockResolvedValue({
      firstWindow: vi.fn().mockRejectedValue(new Error('startup failed')),
      close: vi.fn().mockRejectedValue(new Error('cleanup failed')),
      process: () => ({ exitCode: null, signalCode: null, kill }),
    })
    await expect(
      launchPerformanceHost({
        kind: 'electron',
        workspace,
        document: '',
        sdk: '',
        electronApp: workspace,
        qtExecutable: '',
      }),
    ).rejects.toThrow('startup failed')
    expect(kill).toHaveBeenCalledTimes(1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it('closes Electron when window acquisition or bootstrap fails after launching it', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'docs-perf-host-'))
  try {
    await mkdir(join(workspace, 'node_modules/electron'), { recursive: true })
    await writeFile(join(workspace, 'package.json'), '{}')
    await writeFile(
      join(workspace, 'node_modules/electron/index.js'),
      'module.exports=process.execPath',
    )
    for (const failure of ['window', 'bootstrap']) {
      const close = vi.fn().mockResolvedValue(undefined)
      launches.electron.mockResolvedValue({
        firstWindow:
          failure === 'window'
            ? vi.fn().mockRejectedValue(new Error(failure))
            : vi.fn().mockResolvedValue({}),
        evaluate: vi.fn().mockRejectedValue(new Error(failure)),
        close,
        process: () => ({ kill: vi.fn() }),
      })
      await expect(
        launchPerformanceHost({
          kind: 'electron',
          workspace,
          document: '',
          sdk: '',
          electronApp: workspace,
          qtExecutable: '',
        }),
      ).rejects.toThrow(failure)
      expect(close).toHaveBeenCalledTimes(1)
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

it('starts the Electron close watchdog before an unresponsive main-process prompt callback', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'docs-perf-host-'))
  vi.useFakeTimers()
  try {
    await mkdir(join(workspace, 'node_modules/electron'), { recursive: true })
    await writeFile(join(workspace, 'package.json'), '{}')
    await writeFile(
      join(workspace, 'node_modules/electron/index.js'),
      'module.exports=process.execPath',
    )
    let release!: (reason: Error) => void
    const child = {
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(() => {
        child.exitCode = 1
        release(new Error('owned process terminated'))
      }),
    }
    launches.electron.mockResolvedValue({
      firstWindow: async () => ({}),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ chrome: 'test' })
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              release = reject
            }),
        ),
      process: () => child,
      close: vi.fn().mockResolvedValue(undefined),
    })
    const session = await launchPerformanceHost({
      kind: 'electron',
      workspace,
      document: '',
      sdk: '',
      electronApp: workspace,
      qtExecutable: '',
    })
    const closing = session.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(child.kill).toHaveBeenCalledOnce()
    await closing
  } finally {
    vi.useRealTimers()
    await rm(workspace, { recursive: true, force: true })
  }
})
