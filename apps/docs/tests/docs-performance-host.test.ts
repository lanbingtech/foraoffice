// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const launches = vi.hoisted(() => ({ browser: vi.fn(), electron: vi.fn() }))
vi.mock('@playwright/test', () => ({
  chromium: { launch: launches.browser },
  _electron: { launch: launches.electron },
}))
import { launchPerformanceHost } from '../../../e2e/docs-performance-host'

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
