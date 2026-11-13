/** Verify the distributable SDK from an installed consumer outside the monorepo. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = resolve(process.env.DOCS_SDK_PACKAGE_ROOT ?? join(repository, 'apps/docs/out/sdk'))
const metadata = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'))
assert.equal(metadata.name, '@foraoffice/docs-sdk')
assert.equal(metadata.repository?.url, 'git+https://github.com/lanbingtech/foraoffice.git')
assert.equal(metadata.bugs?.url, 'https://github.com/lanbingtech/foraoffice/issues')
assert.equal(metadata.private, true, 'The development SDK must remain locally installable')
assert.equal(metadata.license, 'Apache-2.0')
const npm = process.env.npm_execpath
assert.ok(npm, 'Run this check with npm run check:sdk-package')
const require = createRequire(import.meta.url)
const consumer = await mkdtemp(join(tmpdir(), 'foraoffice-sdk-consumer-'))
const run = (file, args, options = {}) =>
  execFileSync(process.execPath, [file, ...args], {
    cwd: consumer,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  })

try {
  const packed = JSON.parse(
    run(npm, ['pack', sdk, '--json', '--ignore-scripts', '--pack-destination', consumer], {
      stdio: 'pipe',
    }),
  )[0]
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'foraoffice-sdk-consumer-check',
      private: true,
      type: 'module',
      devDependencies: { '@types/node': require('@types/node/package.json').version },
    }),
  )
  run(npm, [
    'install',
    join(consumer, packed.filename),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
  ])
  const installed = join(consumer, 'node_modules/@foraoffice/docs-sdk')
  assert.equal(await realpath(installed), installed, 'The consumer must install a real package')
  const files = [
    'README.md',
    'LICENSE',
    'NOTICE',
    'LICENSE-UNICODE.txt',
    'THIRD-PARTY-NOTICES.txt',
    'licenses/fonts-OFL.txt',
    'licenses/fonts-README.md',
    'build-info.json',
    'embedded/editor.js',
    'embedded/editor.css',
    'editor.d.ts',
    'services/services.cjs',
    'services/index.d.ts',
    'services/mcp-stdio.cjs',
    'services/node-host.cjs',
    'wasm/pdfium.wasm',
    'cli/genoffice.cjs',
    'hosts/qt/CMakeLists.txt',
    'qt/native-strings.json',
    'examples/browser.ts',
    'examples/files.mjs',
  ]
  for (const file of files) assert.ok((await readFile(join(installed, file))).length, file)
  const provenance = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  assert.match(provenance.source, /^[a-f0-9]{40}$/)
  assert.equal(provenance.baseline, '4b55db9ed1994575a695160ffc6cfd0bfc866211')
  for (const file of ['editor.d.ts', 'services/index.d.ts'])
    assert.doesNotMatch(await readFile(join(installed, file), 'utf8'), /from ['"]@genoffice\//)
  await writeFile(
    join(consumer, 'consumer.mts'),
    `import { mountDocsEditor, createExternalDocsHost, type DocsEditorServices } from '@foraoffice/docs-sdk'
import { createDocsFileSession, createDocsMcpServer } from '@foraoffice/docs-sdk/services'
import '@foraoffice/docs-sdk/editor.css'
const host = (services: DocsEditorServices) => createExternalDocsHost('browser', services)
export { mountDocsEditor, host, createDocsFileSession, createDocsMcpServer }
`,
  )
  run(require.resolve('typescript/bin/tsc'), [
    '--noEmit',
    '--strict',
    '--target',
    'es2022',
    '--module',
    'nodenext',
    '--moduleResolution',
    'nodenext',
    'consumer.mts',
  ])
  const documents = join(consumer, 'documents')
  await mkdir(documents)
  await cp(join(repository, 'fixtures/generated/simple.docx'), join(documents, 'source.docx'))
  run(join(installed, 'examples/files.mjs'), [documents, 'source.docx', 'saved.docx'])
  assert.deepEqual(
    await readFile(join(documents, 'saved.docx')),
    await readFile(join(documents, 'source.docx')),
    'The packaged file service must preserve an untouched document',
  )
  await writeFile(
    join(consumer, 'resources.mjs'),
    `import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createDocsResourceServices } from '@foraoffice/docs-sdk/services'
const [sdk, documents] = process.argv.slice(2)
const resources = await createDocsResourceServices({
  stateDirectory: join(documents, '.resource-state'),
  readRoots: [documents],
  writeRoots: [documents],
  cwd: documents,
  cli: { executable: process.execPath, entry: join(sdk, 'cli/genoffice.cjs') },
})
try {
  const read = await resources.runCli(['docs', 'read', join(documents, 'source.docx')])
  assert.equal(read.ok, true, read.stdout + read.stderr)
  assert.ok(JSON.parse(read.stdout).detail.items.length > 0)
} finally {
  resources.dispose()
}
`,
  )
  run(join(consumer, 'resources.mjs'), [installed, documents])
  console.log(
    `Docs SDK package: ${metadata.version}; Node ${process.versions.node}; source ${provenance.source}; dirty ${provenance.dirty}`,
  )
  console.log(
    'Independent package installation, exports, types, notices, bounded CLI and file round trip: passed',
  )
} catch (error) {
  console.error(`Failed consumer retained at ${consumer}`)
  throw error
}
// This directory is the exact mkdtemp-created consumer, never a caller-supplied path.
assert.equal(dirname(consumer), tmpdir())
await rm(consumer, { recursive: true, force: true })
