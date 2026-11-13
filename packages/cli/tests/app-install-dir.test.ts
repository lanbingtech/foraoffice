// Modified for ForaOffice from GenOffice v0.12.852.
import { join } from 'node:path'
import * as fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { appBinaryForResources, appLaunch } from '../src/resources'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

describe('appBinaryForResources', () => {
  it('disables ambient discovery while preserving an explicit host renderer', () => {
    const localAppData = join('local-fixture', 'data')
    const installed =
      process.platform === 'win32'
        ? join(localAppData, 'Programs', 'GenOffice', 'GenOffice.exe')
        : process.platform === 'darwin'
          ? '/Applications/GenOffice.app/Contents/MacOS/GenOffice'
          : '/opt/GenOffice/genoffice'
    const exists = vi.mocked(fs.existsSync).mockImplementation((path) => path === installed)
    try {
      expect(appLaunch({ LOCALAPPDATA: localAppData })).toEqual({ command: installed, args: [] })
      expect(appLaunch({ LOCALAPPDATA: localAppData, GENOFFICE_APP_DISCOVERY: 'off' })).toBeNull()
      expect(
        appLaunch({ GENOFFICE_APP_DISCOVERY: 'off', GENOFFICE_APP_BIN: '/host-owned/renderer' }),
      ).toEqual({ command: '/host-owned/renderer', args: [] })
    } finally {
      exists.mockRestore()
    }
  })

  it('finds the app in a custom Windows install directory', () => {
    expect(appBinaryForResources(join('D:\\Apps\\GenOffice', 'resources'), 'win32')).toBe(
      join('D:\\Apps\\GenOffice', 'GenOffice.exe'),
    )
  })

  it('resolves the same binary for the default Windows install directory', () => {
    const localAppData = 'C:\\Users\\test\\AppData\\Local'
    const resources = join(localAppData, 'Programs', 'GenOffice', 'resources')
    expect(appBinaryForResources(resources, 'win32')).toBe(
      join(localAppData, 'Programs', 'GenOffice', 'GenOffice.exe'),
    )
  })

  it('finds the app in a custom macOS bundle location', () => {
    expect(
      appBinaryForResources(join('/Volumes/Work/GenOffice.app/Contents/Resources'), 'darwin'),
    ).toBe(join('/Volumes/Work/GenOffice.app/Contents/MacOS/GenOffice'))
  })

  it('finds the app in a custom Linux prefix', () => {
    expect(appBinaryForResources(join('/opt/genoffice-custom/resources'), 'linux')).toBe(
      join('/opt/genoffice-custom/genoffice'),
    )
  })
})
