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
