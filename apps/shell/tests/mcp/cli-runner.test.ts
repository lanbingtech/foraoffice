import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn) }
})
import {
  cliErrorMessage,
  createCliRunner,
  MAX_CLI_OUTPUT_BYTES,
} from '../../src/main/mcp/cli-runner'

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-cli-runner-'))
  const file = join(dir, 'child.js')
  writeFileSync(file, body)
  return file
}

describe('createCliRunner output cap', () => {
  it('does not release a timed-out operation until the child has actually closed', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    })
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>)
    try {
      let settled = false
      const result = createCliRunner({ executable: process.execPath, entry: 'child.js' })
        .run([], { timeoutMs: 1000 })
        .then((outcome) => {
          settled = true
          return outcome
        })
      await vi.advanceTimersByTimeAsync(1000)
      expect(child.kill).toHaveBeenCalledOnce()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(2000)
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
      expect(settled).toBe(false)
      child.emit('close', null)
      expect(await result).toMatchObject({
        ok: false,
        code: -1,
        stderr: expect.stringContaining('timed out'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills a flooding child and bounds the buffered output', async () => {
    const runner = createCliRunner({
      executable: process.execPath,
      entry: script(
        `process.stdout.write('x'.repeat(${MAX_CLI_OUTPUT_BYTES + 1024 * 1024})); setInterval(() => {}, 1000)`,
      ),
    })
    const start = Date.now()
    const outcome = await runner.run(['ignored-arg'], { timeoutMs: 60_000 })
    expect(Date.now() - start).toBeLessThan(60_000)
    expect(outcome.ok).toBe(false)
    expect(outcome.stdout.length + outcome.stderr.length).toBeLessThanOrEqual(
      MAX_CLI_OUTPUT_BYTES + 2000,
    )
    expect(outcome.stderr).toContain('truncated')
    expect(cliErrorMessage(outcome)).toContain('genoffice failed')
  }, 60_000)

  it('passes normal runs through uncapped', async () => {
    const runner = createCliRunner({
      executable: process.execPath,
      entry: script(`console.log(JSON.stringify({ status: 'ok', command: 'x', summary: 'fine' }))`),
    })
    const outcome = await runner.run(['ignored-arg'])
    expect(outcome.ok).toBe(true)
    expect(outcome.json).toMatchObject({ status: 'ok' })
  }, 30_000)
})
