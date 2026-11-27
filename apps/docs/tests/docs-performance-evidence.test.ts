// @vitest-environment node
import { expect, it, vi } from 'vitest'
import type { Page } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureFailureEvidence } from '../../../e2e/docs-performance-evidence'

it.each(['DOM', 'screenshot', 'both'])(
  'retains the cached probe before %s diagnostics can fail',
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'docs-perf-evidence-'))
    const lastProbe = {
      oracle: { tailPresent: true, orderedTextPresent: false, missingRunIndex: 13 },
      imagesReady: true,
      diagnosticIdle: true,
    }
    const error = Object.assign(new Error('complete gate failed'), { lastProbe })
    const persisted = async () =>
      expect(
        JSON.parse(await readFile(join(root, 'failure-state.json'), 'utf8')).lastProbe,
      ).toEqual(lastProbe)
    const page = {
      evaluate: vi.fn(async () => {
        await persisted()
        if (failure !== 'screenshot') throw new Error('DOM unavailable')
        return { status: 'Page 1 of 45', documentText: 'Public example text' }
      }),
      screenshot: vi.fn(async () => {
        await persisted()
        if (failure !== 'DOM') throw new Error('screenshot unavailable')
        return Buffer.from('example image bytes')
      }),
    } as unknown as Page
    try {
      const diagnostics = await captureFailureEvidence(page, root, 'opening', error)
      const state = JSON.parse(await readFile(join(root, 'failure-state.json'), 'utf8'))
      expect(state).toMatchObject({
        scenario: 'opening',
        measurementError: 'Error: complete gate failed',
        lastProbe,
      })
      expect(diagnostics.length).toBeGreaterThan(0)
      if (failure === 'screenshot')
        expect(await readFile(join(root, 'failure-document-text.txt'), 'utf8')).toBe(
          'Public example text',
        )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('retains the cached probe and finishes when both diagnostics stop responding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'docs-perf-evidence-'))
  const lastProbe = {
    complete: false,
    diagnosticIdle: true,
    incompleteText: 'Cached public body text',
  }
  let entered!: () => void
  const observed = new Promise<void>((resolve) => {
    entered = resolve
  })
  const page = {
    evaluate: () => {
      entered()
      return new Promise(() => {})
    },
    screenshot: () => new Promise(() => {}),
  } as unknown as Page
  vi.useFakeTimers()
  try {
    const pending = captureFailureEvidence(
      page,
      root,
      'opening',
      Object.assign(new Error('gate failed'), { lastProbe }),
    )
    await observed
    expect(JSON.parse(await readFile(join(root, 'failure-state.json'), 'utf8')).lastProbe).toEqual(
      lastProbe,
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toHaveLength(2)
    expect(JSON.parse(await readFile(join(root, 'failure-state.json'), 'utf8')).lastProbe).toEqual(
      lastProbe,
    )
  } finally {
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  }
})
