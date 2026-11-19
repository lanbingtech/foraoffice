import { defineConfig } from '@playwright/test'
import { dirname, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { assertExternalArtifacts } from './docs-performance-result'

const supplied = process.env.FORAOFFICE_PERF_ARTIFACTS
if (!supplied)
  throw new Error('Set FORAOFFICE_PERF_ARTIFACTS to an existing directory outside the repository')
const artifacts = realpathSync(supplied)
const repository = resolve(__dirname, '..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: repository,
  encoding: 'utf8',
}).trim()
assertExternalArtifacts(realpathSync(repository), artifacts)
assertExternalArtifacts(dirname(realpathSync(common)), artifacts)
if (!['qt', 'electron', 'browser'].includes(process.env.FORAOFFICE_PERF_HOST ?? ''))
  throw new Error('Set FORAOFFICE_PERF_HOST to qt, electron or browser')
if (!process.env.FORAOFFICE_PERF_LABEL)
  throw new Error('Set FORAOFFICE_PERF_LABEL to identify this baseline/candidate run')
const timeout = Number(
  process.env.FORAOFFICE_PERF_TIMEOUT_MS ??
    (process.env.FORAOFFICE_PERF_SMOKE === '1' ? 30 : 60) * 60_000,
)
if (!Number.isSafeInteger(timeout) || timeout <= 0)
  throw new Error('FORAOFFICE_PERF_TIMEOUT_MS must be a positive whole-run limit')

export default defineConfig({
  testDir: '.',
  testMatch: 'docs-performance.spec.ts',
  outputDir: join(artifacts, 'playwright'),
  timeout,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line'], ['json', { outputFile: join(artifacts, 'playwright-results.json') }]],
  use: { viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'off' },
})
