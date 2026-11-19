import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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

type ImmProfile = Pick<NativeImeProfile, 'keyboardLayout' | 'imeDescription'> & {
  observationSource?: 'imm'
}
type RequestedProfile = ImmProfile | { keyboardLayout: string; observationSource: 'os-tray-uia' }

export type NativeTrayObservation = {
  source: 'os-tray-uia'
  owner: NativeImeOwner
  foregroundBefore: NativeImeOwner
  foregroundAfter: NativeImeOwner
  taskbarClass: string
  startedUtc: string
  completedUtc: string
  provider: NativeTrayElement
  mode: NativeTrayElement
}

type NativeTrayElement = {
  processId: number
  processStartTime: string
  image: string
  company: string
  name: string
  className: string
  automationId: string
  controlType: string
  offscreen: boolean
  enabled: boolean
}

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
    evidenceKind: 'uia-metadata-only'
    processes: {
      processId: number
      processName: string
      image: string | null
      status: 'available' | 'unavailable' | 'identity-mismatch'
      error?: string
      win32Error?: number
    }[]
    windows: {
      processId: number
      image: string | null
      windowHandle: string
      windowClass: string
      left: number
      top: number
      right: number
      bottom: number
      names: string[]
      truncated: boolean
      uiaError?: string
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
  focusMethod?: 'UIAutomation.SetFocus'
  inputObservation?: { before: NativeTrayObservation; after: NativeTrayObservation }
  error?: string
}

export type NativeImeRequest =
  | { action: 'inspect'; targetProcessId: number; includeCandidates?: boolean }
  | ({ action: 'focus' } & NativeImeOwner)
  | ({ action: 'select-language' } & NativeImeOwner & ImmProfile)
  | ({ action: 'type'; text: string } & NativeImeOwner & RequestedProfile)
  | ({ action: 'commit' | 'cancel' } & NativeImeOwner & RequestedProfile)
  | ({
      action: 'restore'
      keyboardLayout: string
      previousForeground: NativeImeOwner | null
    } & NativeImeOwner)

export type NativeCandidateProof =
  | { status: 'incomplete'; reason: string }
  | { status: 'pending-visual-review'; imageSha256: string }
  | {
      status: 'confirmed'
      imageSha256: string
      selectedCandidate: string
      preedit: string
      reviewer: string
      reviewedUtc: string
    }

// Metadata and the existence of a PNG cannot establish what candidate pixels depict.
export async function evaluateNativeCandidateCapture(
  owner: NativeImeOwner,
  capture: unknown,
  visualReview?: unknown,
): Promise<NativeCandidateProof> {
  try {
    requireOwner(owner)
    requireEvidence(
      isRecord(capture) &&
        capture.source === 'win32-desktop-copy-from-screen' &&
        capture.coordinateSource === 'uia-physical-screen',
      'native desktop pixel source',
    )
    for (const identity of [capture.owner, capture.foregroundBefore, capture.foregroundAfter]) {
      requireOwner(identity)
      requireEvidence(
        identity.targetProcessId === owner.targetProcessId &&
          identity.windowHandle === owner.windowHandle &&
          identity.processStartTime === owner.processStartTime,
        'candidate capture foreground binding',
      )
    }
    requireEvidence(
      isTimestamp(capture.startedUtc) &&
        isTimestamp(capture.completedUtc) &&
        Date.parse(capture.startedUtc) >= Date.parse(owner.processStartTime) &&
        Date.parse(capture.completedUtc) >= Date.parse(capture.startedUtc),
      'candidate capture UTC interval',
    )
    const window = capture.window
    requireEvidence(
      isRecord(window) &&
        isInteger(window.processId) &&
        window.processId > 0 &&
        isPointer(window.windowHandle) &&
        typeof window.windowClass === 'string' &&
        !!window.windowClass,
      'native candidate window',
    )
    requireEvidence(
      [window.left, window.top, window.right, window.bottom].every(isInteger),
      'candidate physical pixel bounds',
    )
    const width = (window.right as number) - (window.left as number)
    const height = (window.bottom as number) - (window.top as number)
    requireEvidence(
      width > 0 && height > 0 && width < 10000 && height < 10000,
      'candidate capture dimensions',
    )
    requireEvidence(
      typeof capture.imagePath === 'string' &&
        typeof capture.imageSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(capture.imageSha256),
      'candidate image digest',
    )
    const bytes = await readFile(capture.imagePath)
    requireEvidence(
      bytes.length >= 24 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.toString('ascii', 12, 16) === 'IHDR' &&
        bytes.readUInt32BE(16) === width &&
        bytes.readUInt32BE(20) === height,
      'candidate PNG physical dimensions',
    )
    const imageSha256 = createHash('sha256').update(bytes).digest('hex')
    requireEvidence(imageSha256 === capture.imageSha256, 'candidate image SHA256 mismatch')
    if (isRecord(visualReview)) {
      requireEvidence(
        visualReview.source === 'manual-native-pixel-review' &&
          visualReview.imageSha256 === imageSha256,
        'matching separate native pixel review',
      )
      requireOwner(visualReview.owner)
      requireEvidence(
        visualReview.owner.targetProcessId === owner.targetProcessId &&
          visualReview.owner.windowHandle === owner.windowHandle &&
          visualReview.owner.processStartTime === owner.processStartTime,
        'visual review owner',
      )
      requireEvidence(
        isTimestamp(visualReview.reviewedUtc) &&
          Date.parse(visualReview.reviewedUtc) >= Date.parse(capture.completedUtc),
        'visual review UTC',
      )
      requireEvidence(
        typeof visualReview.reviewer === 'string' &&
          !!visualReview.reviewer.trim() &&
          typeof visualReview.preedit === 'string' &&
          !!visualReview.preedit.trim() &&
          typeof visualReview.selectedCandidate === 'string' &&
          !!visualReview.selectedCandidate.trim(),
        'observed native preedit and selected candidate',
      )
      return {
        status: 'confirmed',
        imageSha256,
        selectedCandidate: visualReview.selectedCandidate,
        preedit: visualReview.preedit,
        reviewer: visualReview.reviewer,
        reviewedUtc: visualReview.reviewedUtc,
      }
    }
    requireEvidence(visualReview === undefined, 'separate visual review record')
    return { status: 'pending-visual-review', imageSha256 }
  } catch (error) {
    return {
      status: 'incomplete',
      reason: error instanceof Error ? error.message : 'Native candidate capture unavailable',
    }
  }
}

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

function requireTrayObservation(
  value: unknown,
  owner: NativeImeSnapshot['owner'],
  earliest: number,
  latest: number,
): asserts value is NativeTrayObservation {
  requireEvidence(isRecord(value) && value.source === 'os-tray-uia', 'OS tray source')
  requireEvidence(value.taskbarClass === 'Shell_TrayWnd', 'native system tray scope')
  for (const identity of [value.owner, value.foregroundBefore, value.foregroundAfter]) {
    requireOwner(identity)
    requireEvidence(
      identity.targetProcessId === owner.targetProcessId &&
        identity.windowHandle === owner.windowHandle &&
        identity.processStartTime === owner.processStartTime &&
        'threadId' in identity &&
        identity.threadId === owner.threadId,
      'fresh owned foreground around OS tray observation',
    )
  }
  requireEvidence(isTimestamp(value.startedUtc) && isTimestamp(value.completedUtc), 'OS tray clock')
  requireEvidence(
    Date.parse(value.startedUtc) >= earliest &&
      Date.parse(value.completedUtc) >= Date.parse(value.startedUtc) &&
      Date.parse(value.completedUtc) <= latest,
    'fresh OS tray observation interval',
  )
  for (const element of [value.provider, value.mode]) {
    requireEvidence(isRecord(element), 'native input indicator element')
    requireEvidence(
      element.className === 'SystemTray.NormalButton' &&
        element.automationId === 'SystemTrayIcon' &&
        element.controlType === 'ControlType.Button' &&
        element.offscreen === false &&
        element.enabled === true &&
        isInteger(element.processId) &&
        element.processId > 0 &&
        typeof element.image === 'string' &&
        /\\explorer\.exe$/i.test(element.image) &&
        element.company === 'Microsoft Corporation' &&
        isTimestamp(element.processStartTime) &&
        Date.parse(element.processStartTime) <= Date.parse(value.startedUtc),
      'observed Windows input indicator identity',
    )
  }
  requireEvidence(isRecord(value.provider) && isRecord(value.mode), 'OS tray elements')
  requireEvidence(
    value.provider.processId === value.mode.processId &&
      value.provider.processStartTime === value.mode.processStartTime &&
      value.provider.image === value.mode.image &&
      typeof value.provider.name === 'string' &&
      /(?:^|\r?\n)微软拼音(?:\r?\n|$)/.test(value.provider.name) &&
      typeof value.mode.name === 'string' &&
      /^托盘输入指示器 中文模式(?:\r?\n|$)/.test(value.mode.name),
    'observed Microsoft Pinyin Chinese mode',
  )
}

export class NativeImeEvidenceError extends Error {
  constructor(
    readonly stdout: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Invalid native IME evidence', { cause })
    this.name = 'NativeImeEvidenceError'
  }
}

export function parseWindowsNativeImeEvidence(
  request: NativeImeRequest,
  stdout: string,
): NativeImeEvidence {
  try {
    return readNativeImeEvidence(request, stdout)
  } catch (error) {
    throw new NativeImeEvidenceError(stdout, error)
  }
}

function readNativeImeEvidence(request: NativeImeRequest, stdout: string): NativeImeEvidence {
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
    if (request.includeCandidates) {
      const inspection = value.candidateInspection
      requireEvidence(
        isRecord(inspection) && inspection.evidenceKind === 'uia-metadata-only',
        'candidate metadata source',
      )
      requireEvidence(
        Array.isArray(inspection.processes) &&
          Array.isArray(inspection.windows) &&
          Array.isArray(inspection.errors) &&
          inspection.errors.every((error: unknown) => typeof error === 'string'),
        'candidate metadata collections',
      )
      const processes = new Map<number, Record<string, unknown>>()
      for (const process of inspection.processes) {
        requireEvidence(
          isRecord(process) &&
            isInteger(process.processId) &&
            process.processId > 0 &&
            !processes.has(process.processId) &&
            typeof process.processName === 'string',
          'candidate process identity',
        )
        requireEvidence(
          ['available', 'unavailable', 'identity-mismatch'].includes(String(process.status)) &&
            (process.image === null || typeof process.image === 'string'),
          'candidate image availability',
        )
        requireEvidence(
          process.status === 'available'
            ? typeof process.image === 'string' && !!process.image
            : typeof process.error === 'string' && !!process.error,
          'candidate process diagnostics',
        )
        if (process.win32Error !== undefined)
          requireEvidence(isInteger(process.win32Error), 'candidate Win32 diagnostic')
        processes.set(process.processId, process)
      }
      for (const window of inspection.windows) {
        requireEvidence(
          isRecord(window) &&
            isInteger(window.processId) &&
            processes.has(window.processId) &&
            window.image === processes.get(window.processId)?.image &&
            isPointer(window.windowHandle) &&
            typeof window.windowClass === 'string',
          'candidate window identity',
        )
        requireEvidence(
          [window.left, window.top, window.right, window.bottom].every(isInteger) &&
            (window.right as number) > (window.left as number) &&
            (window.bottom as number) > (window.top as number),
          'candidate physical bounds',
        )
        requireEvidence(
          Array.isArray(window.names) &&
            window.names.every((name: unknown) => typeof name === 'string') &&
            typeof window.truncated === 'boolean' &&
            (window.uiaError === undefined || typeof window.uiaError === 'string'),
          'candidate UIA metadata',
        )
      }
    }
  }
  if (request.action === 'focus' || request.action === 'select-language') {
    requireEvidence(after?.foregroundOwned && after.focusOwned, 'owned foreground focus')
  }
  if (request.action === 'focus')
    requireEvidence(value.focusMethod === 'UIAutomation.SetFocus', 'owned focus activation method')
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
          snapshot.profile.languageId === 0x0804,
        'native input locale',
      )
      if (request.observationSource !== 'os-tray-uia')
        requireEvidence(
          !!request.imeDescription.trim() &&
            snapshot.profile.imeDescription === request.imeDescription &&
            snapshot.profile.open === true &&
            snapshot.profile.nativeMode === true,
          'confirmed IMM input profile and mode',
        )
      else
        requireEvidence(
          snapshot.profile.open !== false && snapshot.profile.nativeMode !== false,
          'conflicting native IME mode observations',
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
    if (request.observationSource === 'os-tray-uia') {
      requireEvidence(isRecord(value.inputObservation), 'OS tray input observations')
      requireTrayObservation(
        value.inputObservation.before,
        value.before.owner,
        Date.parse(value.before.observedUtc),
        Date.parse(value.submission.utcBefore),
      )
      requireTrayObservation(
        value.inputObservation.after,
        value.before.owner,
        Date.parse(value.submission.utcAfter),
        Date.parse(after.observedUtc),
      )
    }
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
    request.observationSource !== 'os-tray-uia' &&
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
