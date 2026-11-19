import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export type NativeImeOwner = {
  targetProcessId: number
  windowHandle: string
  processStartTime: string
}

export type NativeImeProfile = {
  keyboardLayout: string
  imeDescription: string
  languageId: number
  imeFile: string
  open?: boolean | null
  nativeMode?: boolean | null
}

type RequestedProfile = Pick<NativeImeProfile, 'keyboardLayout' | 'imeDescription'>

export type NativeImeSnapshot = {
  owner: NativeImeOwner & { threadId: number }
  foreground: NativeImeOwner | null
  focusedWindowHandle: string
  foregroundOwned: boolean
  focusOwned: boolean
  profile: NativeImeProfile
  observedUtc: string
}

export type NativeImeEvidence = {
  action: NativeImeRequest['action']
  channel: string
  before: NativeImeSnapshot
  after?: NativeImeSnapshot
  loadedProfiles?: NativeImeProfile[]
  candidateInspection?: {
    windows: {
      processId: number
      image: string
      windowHandle: string
      windowClass: string
      left: number
      top: number
      right: number
      bottom: number
      names: string[]
      truncated: boolean
    }[]
    errors: string[]
  }
  submission?: {
    requestedEvents: number
    insertedEvents: number
    utcBefore: string
    utcAfter: string
    qpcBefore: string
    qpcAfter: string
    qpcFrequency: string
    win32Error: number
    keyUpRecovery?: { requestedEvents: number; insertedEvents: number; win32Error: number }
  }
  foregroundRestored?: boolean
  error?: string
}

export type NativeImeRequest =
  | { action: 'inspect'; targetProcessId: number; includeCandidates?: boolean }
  | ({ action: 'focus' } & NativeImeOwner)
  | ({ action: 'select-language' } & NativeImeOwner & RequestedProfile)
  | ({ action: 'type'; text: string } & NativeImeOwner & RequestedProfile)
  | ({ action: 'commit' | 'cancel' } & NativeImeOwner & RequestedProfile)
  | ({
      action: 'restore'
      keyboardLayout: string
      previousForeground: NativeImeOwner | null
    } & NativeImeOwner)

function requireEvidence(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`Invalid native IME evidence: ${field}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isPointer(value: unknown, allowZero = false): value is string {
  if (typeof value !== 'string' || !/^-?\d{1,19}$/.test(value)) return false
  const pointer = BigInt(value)
  return (
    (allowZero || pointer !== 0n) &&
    pointer >= -0x8000_0000_0000_0000n &&
    pointer <= 0x7fff_ffff_ffff_ffffn
  )
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function requireOwner(value: unknown): asserts value is NativeImeOwner {
  requireEvidence(isRecord(value), 'owner')
  requireEvidence(isInteger(value.targetProcessId) && value.targetProcessId > 0, 'owner PID')
  requireEvidence(isPointer(value.windowHandle), 'owner window')
  requireEvidence(isTimestamp(value.processStartTime), 'owner start time')
}

function requireProfile(value: unknown, withMode = false): asserts value is NativeImeProfile {
  requireEvidence(isRecord(value), 'profile')
  requireEvidence(isPointer(value.keyboardLayout), 'input locale')
  requireEvidence(typeof value.imeDescription === 'string', 'IME description')
  requireEvidence(typeof value.imeFile === 'string', 'IME file')
  requireEvidence(
    isInteger(value.languageId) && value.languageId >= 0 && value.languageId <= 0xffff,
    'input language',
  )
  if (withMode) {
    requireEvidence(value.open === null || typeof value.open === 'boolean', 'IME open state')
    requireEvidence(
      value.nativeMode === null || typeof value.nativeMode === 'boolean',
      'IME conversion mode',
    )
  }
}

function requireSnapshot(
  value: unknown,
  request: NativeImeRequest,
): asserts value is NativeImeSnapshot {
  requireEvidence(isRecord(value), 'snapshot')
  requireOwner(value.owner)
  requireEvidence(value.owner.targetProcessId === request.targetProcessId, 'owned PID mismatch')
  if (request.action !== 'inspect') {
    requireEvidence(value.owner.windowHandle === request.windowHandle, 'owned window mismatch')
    requireEvidence(
      value.owner.processStartTime === request.processStartTime,
      'owned process start mismatch',
    )
  }
  requireEvidence(
    'threadId' in value.owner && isInteger(value.owner.threadId) && value.owner.threadId > 0,
    'owned GUI thread',
  )
  if (value.foreground !== null) requireOwner(value.foreground)
  requireEvidence(isPointer(value.focusedWindowHandle, true), 'focused window')
  requireEvidence(typeof value.foregroundOwned === 'boolean', 'foreground ownership')
  requireEvidence(typeof value.focusOwned === 'boolean', 'focus ownership')
  requireEvidence(isTimestamp(value.observedUtc), 'observation timestamp')
  requireProfile(value.profile, true)
}

export function parseWindowsNativeImeEvidence(
  request: NativeImeRequest,
  stdout: string,
): NativeImeEvidence {
  const value: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
  requireEvidence(isRecord(value), 'result')
  requireEvidence(value.action === request.action && !('error' in value), 'action or error')
  const channels = {
    inspect: 'win32-window-inspection',
    focus: 'win32-window-state',
    'select-language': 'win32-input-language-request',
    restore: 'win32-window-state',
    type: 'win32-sendinput-scancode',
    commit: 'win32-sendinput-scancode',
    cancel: 'win32-sendinput-scancode',
  }
  requireEvidence(value.channel === channels[request.action], 'native action channel')
  requireSnapshot(value.before, request)
  let after: NativeImeSnapshot | undefined
  if (request.action !== 'inspect') {
    requireSnapshot(value.after, request)
    after = value.after
    requireEvidence(after.owner.threadId === value.before.owner.threadId, 'owned thread changed')
  }
  if (request.action === 'inspect') {
    requireEvidence(
      Array.isArray(value.loadedProfiles) && value.loadedProfiles.length,
      'loaded profiles',
    )
    for (const profile of value.loadedProfiles) requireProfile(profile)
  }
  if (request.action === 'focus' || request.action === 'select-language') {
    requireEvidence(after?.foregroundOwned && after.focusOwned, 'owned foreground focus')
  }
  if (request.action === 'select-language') {
    requireEvidence(
      after?.profile.keyboardLayout === request.keyboardLayout &&
        after.profile.imeDescription === request.imeDescription,
      'selected input profile',
    )
  }
  if (request.action === 'restore') {
    requireEvidence(
      after?.profile.keyboardLayout === request.keyboardLayout &&
        typeof value.foregroundRestored === 'boolean',
      'restoration acknowledgement',
    )
  }
  if (request.action === 'type' || request.action === 'commit' || request.action === 'cancel') {
    requireEvidence(after, 'native input completion snapshot')
    for (const snapshot of [value.before, after]) {
      requireEvidence(snapshot.foregroundOwned && snapshot.focusOwned, 'owned native input focus')
      requireEvidence(
        snapshot.profile.keyboardLayout === request.keyboardLayout &&
          !!request.imeDescription.trim() &&
          snapshot.profile.imeDescription === request.imeDescription &&
          snapshot.profile.languageId === 0x0804 &&
          snapshot.profile.open === true &&
          snapshot.profile.nativeMode === true,
        'confirmed Chinese input profile and mode',
      )
    }
    const expected = request.action === 'type' ? request.text.length * 2 : 2
    requireEvidence(isRecord(value.submission), 'native key submission')
    requireEvidence(
      value.submission.requestedEvents === expected &&
        value.submission.insertedEvents === expected &&
        !('keyUpRecovery' in value.submission),
      'complete native key submission',
    )
    requireEvidence(
      typeof value.submission.utcBefore === 'string' &&
        typeof value.submission.utcAfter === 'string' &&
        Number.isFinite(Date.parse(value.submission.utcBefore)) &&
        Date.parse(value.submission.utcAfter) >= Date.parse(value.submission.utcBefore),
      'native submission UTC interval',
    )
    for (const name of ['qpcBefore', 'qpcAfter', 'qpcFrequency']) {
      const counter = value.submission[name]
      requireEvidence(
        typeof counter === 'string' && /^\d+$/.test(counter) && BigInt(counter) > 0n,
        `native submission ${name}`,
      )
    }
    requireEvidence(
      BigInt(value.submission.qpcAfter as string) >= BigInt(value.submission.qpcBefore as string),
      'native submission QPC interval',
    )
    requireEvidence(isInteger(value.submission.win32Error), 'native submission Win32 result')
  }
  return value as NativeImeEvidence
}

export async function runWindowsNativeIme(request: NativeImeRequest): Promise<NativeImeEvidence> {
  if (!Number.isSafeInteger(request.targetProcessId) || request.targetProcessId <= 0)
    throw new Error('A positive owned process ID is required')
  if (
    request.action !== 'inspect' &&
    (!/^[1-9]\d{0,18}$/.test(request.windowHandle) ||
      BigInt(request.windowHandle) > 0x7fff_ffff_ffff_ffffn)
  )
    throw new Error('An exact owned window handle is required')
  if (
    request.action !== 'inspect' &&
    request.action !== 'focus' &&
    request.action !== 'restore' &&
    !request.imeDescription.trim()
  )
    throw new Error('An observed IME description is required')
  if (request.action === 'type' && !/^[a-z]{1,64}$/.test(request.text))
    throw new Error('Phonetic input must contain 1 to 64 lowercase Latin letters')
  if (process.platform !== 'win32') throw new Error('Native IME input requires Windows')
  const { stdout } = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve(__dirname, 'native-ime.ps1'),
      '-RequestBase64',
      Buffer.from(JSON.stringify(request), 'utf8').toString('base64'),
    ],
    { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
  )
  return parseWindowsNativeImeEvidence(request, stdout)
}
