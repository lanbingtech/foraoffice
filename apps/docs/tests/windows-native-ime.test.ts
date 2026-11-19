// @vitest-environment node
import { expect, it } from 'vitest'
import { parseWindowsNativeImeEvidence, runWindowsNativeIme } from '../../../e2e/windows-native-ime'

const ownedWindow = {
  targetProcessId: 41,
  windowHandle: '90',
  processStartTime: '2026-11-19T00:00:00.0000000Z',
}
const phoneticRequest = {
  ...ownedWindow,
  action: 'type' as const,
  keyboardLayout: '134481924',
  imeDescription: 'Microsoft Pinyin',
  text: 'ceshi',
}

const trayRequest = {
  ...ownedWindow,
  action: 'type' as const,
  keyboardLayout: '134481924',
  observationSource: 'os-tray-uia' as const,
  text: 'ceshi',
}

function completedInput() {
  const snapshot = {
    owner: { ...ownedWindow, threadId: 13 },
    foreground: ownedWindow,
    focusedWindowHandle: '91',
    foregroundOwned: true,
    focusOwned: true,
    profile: {
      keyboardLayout: '134481924',
      imeDescription: 'Microsoft Pinyin',
      imeFile: 'fixture.ime',
      languageId: 2052,
      open: true,
      nativeMode: true,
    },
    observedUtc: '2026-11-19T01:00:00.0000000Z',
  }
  return {
    action: 'type',
    channel: 'win32-sendinput-scancode',
    before: snapshot,
    after: structuredClone(snapshot),
    submission: {
      requestedEvents: 10,
      insertedEvents: 10,
      utcBefore: '2026-11-19T01:00:00.0010000Z',
      utcAfter: '2026-11-19T01:00:00.0020000Z',
      qpcBefore: '1000',
      qpcAfter: '1001',
      qpcFrequency: '1000',
      win32Error: 0,
    },
  }
}

// Mock helper output uses literal labels from the owned Qt focus-only receipt.
// Process/clock values below are synthetic, not native typing measurements.
function completedTrayInput() {
  const legacy = completedInput()
  const foreground = { ...ownedWindow, threadId: 13 }
  const element = {
    processId: 10168,
    processStartTime: '2026-11-15T23:24:00.6909262Z',
    image: 'C:\\WINDOWS\\Explorer.EXE',
    company: 'Microsoft Corporation',
    className: 'SystemTray.NormalButton',
    automationId: 'SystemTrayIcon',
    controlType: 'ControlType.Button',
    offscreen: false,
    enabled: true,
  }
  const observation = {
    source: 'os-tray-uia',
    owner: foreground,
    foregroundBefore: foreground,
    foregroundAfter: foreground,
    taskbarClass: 'Shell_TrayWnd',
    startedUtc: '2026-11-19T01:00:00.0001000Z',
    completedUtc: '2026-11-19T01:00:00.0009000Z',
    provider: {
      ...element,
      name: '托盘输入指示器 中文(简体，中国)\r\n微软拼音\r\n\r\n要切换输入法，按 Windows 键+空格。',
    },
    mode: { ...element, name: '托盘输入指示器 中文模式\n\n单击右键以查看更多选项' },
  }
  return {
    ...legacy,
    before: {
      ...legacy.before,
      profile: {
        ...legacy.before.profile,
        imeDescription: '',
        imeFile: '',
        open: null,
        nativeMode: null,
      },
    },
    after: {
      ...legacy.after,
      profile: {
        ...legacy.after.profile,
        imeDescription: '',
        imeFile: '',
        open: null,
        nativeMode: null,
      },
      observedUtc: '2026-11-19T01:00:00.0030000Z',
    },
    inputObservation: {
      before: observation,
      after: {
        ...structuredClone(observation),
        startedUtc: '2026-11-19T01:00:00.0021000Z',
        completedUtc: '2026-11-19T01:00:00.0029000Z',
      },
    },
  }
}

it('rejects an unowned process before attempting native keyboard input', async () => {
  await expect(runWindowsNativeIme({ action: 'inspect', targetProcessId: 0 })).rejects.toThrow(
    'A positive owned process ID is required',
  )
})

it.skipIf(process.platform !== 'win32')(
  'refuses a process without an owned editor window',
  async () => {
    await expect(
      runWindowsNativeIme({ action: 'inspect', targetProcessId: process.pid }),
    ).rejects.toThrow('The owned process has no visible main window')
  },
)

it('refuses typing without an exact owned window identity', async () => {
  await expect(
    runWindowsNativeIme({
      action: 'type',
      targetProcessId: process.pid,
      windowHandle: '0',
      processStartTime: '2026-11-19T00:00:00.0000000Z',
      keyboardLayout: '67699721',
      imeDescription: 'Microsoft Pinyin',
      text: 'ceshi',
    }),
  ).rejects.toThrow('An exact owned window handle is required')
})

it('requires an observed input profile before accepting phonetic keys', async () => {
  await expect(
    runWindowsNativeIme({
      action: 'type',
      targetProcessId: process.pid,
      windowHandle: '1',
      processStartTime: '2026-11-19T00:00:00.0000000Z',
      keyboardLayout: '134481924',
      imeDescription: '',
      text: 'ceshi',
    }),
  ).rejects.toThrow('An observed IME description is required')
})

it('refuses shortcut/control text in a phonetic input request', async () => {
  await expect(
    runWindowsNativeIme({
      action: 'type',
      targetProcessId: process.pid,
      windowHandle: '1',
      processStartTime: '2026-11-19T00:00:00.0000000Z',
      keyboardLayout: '134481924',
      imeDescription: 'Microsoft Pinyin',
      text: 'ceshi\u0001',
    }),
  ).rejects.toThrow('Phonetic input must contain 1 to 64 lowercase Latin letters')
})

it('rejects empty helper output rather than accepting native input completion', () => {
  expect(() =>
    parseWindowsNativeImeEvidence({ action: 'inspect', targetProcessId: 41 }, '{}'),
  ).toThrow('Invalid native IME evidence')
})

it('rejects native completion from a different owned process', () => {
  const output = completedInput()
  output.after.owner.targetProcessId = 99
  expect(() => parseWindowsNativeImeEvidence(phoneticRequest, JSON.stringify(output))).toThrow(
    'Invalid native IME evidence',
  )
})

it('rejects a successful helper response that inserted only part of the phonetic input', () => {
  const output = completedInput()
  output.submission.insertedEvents = 9
  expect(() => parseWindowsNativeImeEvidence(phoneticRequest, JSON.stringify(output))).toThrow(
    'Invalid native IME evidence',
  )
})

it('does not infer an active IME from a matching Chinese input locale alone', () => {
  const output = completedInput()
  output.after.profile.imeDescription = ''
  expect(() => parseWindowsNativeImeEvidence(phoneticRequest, JSON.stringify(output))).toThrow(
    'Invalid native IME evidence',
  )
})

it('accepts complete native helper evidence with the submitted keys and observed owner', () => {
  const evidence = parseWindowsNativeImeEvidence(phoneticRequest, JSON.stringify(completedInput()))
  expect(evidence.before.owner.targetProcessId).toBe(41)
  expect(evidence.submission?.insertedEvents).toBe(10)
  expect(evidence.after?.profile.imeDescription).toBe('Microsoft Pinyin')
})

it.each(['missing', 'provider', 'mode', 'foreground', 'self-attestation'] as const)(
  'rejects invalid %s evidence on the OS tray path',
  (fault) => {
    const output = completedTrayInput()
    let payload: unknown = output
    if (fault === 'missing') payload = { ...output, inputObservation: null }
    if (fault === 'provider') output.inputObservation.before.provider.name = '微软五笔'
    if (fault === 'mode') output.inputObservation.after.mode.name = '托盘输入指示器 英文模式'
    if (fault === 'foreground') output.inputObservation.after.foregroundAfter.targetProcessId = 99
    if (fault === 'self-attestation')
      payload = {
        ...output,
        inputObservation: {
          before: { source: 'os-tray-uia', providerConfirmed: true, chineseMode: true },
          after: { source: 'os-tray-uia', providerConfirmed: true, chineseMode: true },
        },
      }
    expect(() => parseWindowsNativeImeEvidence(trayRequest, JSON.stringify(payload))).toThrow(
      'Invalid native IME evidence',
    )
  },
)

it('accepts freshly foreground-bound native tray evidence without fabricating unavailable IMM state', () => {
  const evidence = parseWindowsNativeImeEvidence(trayRequest, JSON.stringify(completedTrayInput()))
  expect(evidence.before.profile.open).toBeNull()
  expect(evidence.inputObservation?.before.source).toBe('os-tray-uia')
})

it('rejects tray observations captured before this input command', () => {
  const output = completedTrayInput()
  output.inputObservation.before.startedUtc = '2026-11-18T01:00:00.0000000Z'
  output.inputObservation.before.completedUtc = '2026-11-18T01:00:00.0010000Z'
  expect(() => parseWindowsNativeImeEvidence(trayRequest, JSON.stringify(output))).toThrow(
    'Invalid native IME evidence',
  )
})

it.each(['action', 'channel', 'error'] as const)(
  'rejects a mismatched %s in helper output',
  (field) => {
    const output: Record<string, unknown> = completedInput()
    output[field] = field === 'action' ? 'commit' : field === 'channel' ? 'chromium-cdp' : 'blocked'
    expect(() => parseWindowsNativeImeEvidence(phoneticRequest, JSON.stringify(output))).toThrow(
      'Invalid native IME evidence',
    )
  },
)
