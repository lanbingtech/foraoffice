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

export default defineConfig({
  testDir: '.',
  testMatch: 'docs-performance.spec.ts',
  outputDir: join(artifacts, 'playwright'),
  timeout: 30 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line'], ['json', { outputFile: join(artifacts, 'playwright-results.json') }]],
  use: { viewport: { width: 1440, height: 1000 }, trace: 'off', screenshot: 'off' },
})
