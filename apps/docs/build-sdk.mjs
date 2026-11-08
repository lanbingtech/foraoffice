import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { generateDtsBundle } from 'dts-bundle-generator'

const root = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)
const repository = resolve(root, '../..')
const outputRoot = resolve(root, 'out')
const cliRoot = resolve(repository, 'packages/cli')
await mkdir(outputRoot, { recursive: true })
execFileSync(process.execPath, [resolve(cliRoot, 'build.mjs')], { cwd: cliRoot, stdio: 'inherit' })
// collect-deps owns only this package's fixed dist/node_modules directory.
const cliModules = resolve(cliRoot, 'dist/node_modules')
if (dirname(cliModules) !== resolve(cliRoot, 'dist'))
  throw new Error('CLI dependency output escaped its dist directory')
execFileSync(process.execPath, [resolve(cliRoot, 'collect-deps.mjs')], {
  cwd: cliRoot,
  stdio: 'inherit',
})
await build({ root, configFile: resolve(root, 'vite.embedded.config.ts') })
await import('./build-services.mjs')
await import('../../tools/gen-third-party-notices.mjs')

// Resolve workspace packages from their declared exports when emitting types,
// so TypeScript emits their sources instead of treating symlinks as installed declarations.
const paths = {}
const libraries = []
for (const directory of await readdir(resolve(repository, 'packages'), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  const packageRoot = resolve(repository, 'packages', directory.name)
  const packageFile = join(packageRoot, 'package.json')
  let metadata
  try {
    metadata = JSON.parse(await readFile(packageFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') continue
    throw error
  }
  if (!metadata.name?.startsWith('@genoffice/')) continue
  libraries.push(metadata.name)
  for (const [name, target] of Object.entries(metadata.exports ?? {})) {
    if (typeof target === 'string')
      paths[metadata.name + (name === '.' ? '' : name.slice(1))] = [resolve(packageRoot, target)]
  }
}
const config = resolve(outputRoot, 'sdk-types.tsconfig.json')
await writeFile(
  config,
  JSON.stringify({
    extends: resolve(root, 'tsconfig.json'),
    compilerOptions: { paths, types: ['node', 'vite/client'] },
  }),
)
const declarations = generateDtsBundle(
  ['src/sdk.ts', 'src/services/index.ts'].map((entry) => ({
    filePath: resolve(root, entry),
    libraries: { inlinedLibraries: libraries },
    output: { exportReferencedTypes: false },
  })),
  { preferredConfigPath: config },
)
if (declarations.some((text) => /from ['"]@genoffice\//.test(text)))
  throw new Error('The public SDK declarations still depend on private workspace packages')

const stage = await mkdtemp(join(outputRoot, '.sdk-'))
await cp(resolve(root, 'out/embedded'), join(stage, 'embedded'), { recursive: true })
await cp(resolve(root, 'out/services'), join(stage, 'services'), {
  recursive: true,
  filter: (source) => !source.endsWith('metafile.json'),
})
await cp(resolve(root, 'out/qt'), join(stage, 'qt'), { recursive: true })
await mkdir(join(stage, 'cli'))
await cp(resolve(cliRoot, 'dist/genoffice.cjs'), join(stage, 'cli/genoffice.cjs'))
await cp(cliModules, join(stage, 'node_modules'), { recursive: true })
await mkdir(join(stage, 'wasm'))
await cp(require.resolve('@embedpdf/pdfium/pdfium.wasm'), join(stage, 'wasm/pdfium.wasm'))
await cp(resolve(root, 'hosts/qt'), join(stage, 'hosts/qt'), { recursive: true })
await cp(resolve(root, 'sdk/examples'), join(stage, 'examples'), { recursive: true })
await cp(resolve(root, 'sdk/README.md'), join(stage, 'README.md'))
for (const name of ['LICENSE', 'NOTICE', 'LICENSE-UNICODE.txt'])
  await cp(resolve(repository, name), join(stage, name))
await mkdir(join(stage, 'licenses'))
await cp(resolve(root, 'src/renderer/fonts/LICENSE-OFL.txt'), join(stage, 'licenses/fonts-OFL.txt'))
await cp(resolve(root, 'src/renderer/fonts/README.md'), join(stage, 'licenses/fonts-README.md'))
const upstreamNotices = await readFile(
  resolve(repository, 'apps/shell/build/THIRD-PARTY-NOTICES.txt'),
  'utf8',
)
await writeFile(
  join(stage, 'THIRD-PARTY-NOTICES.txt'),
  'Docs SDK distribution\n\nThe following upstream notices cover the full GenOffice distribution.\n' +
    'This SDK archive contains editor assets and Node bundles; Electron, Qt and Chromium runtimes\n' +
    'are supplied by the embedding host and are not included in this archive.\n\n' +
    upstreamNotices,
)
await writeFile(join(stage, 'editor.d.ts'), declarations[0])
await writeFile(join(stage, 'services/index.d.ts'), declarations[1])
const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const cliMetadata = JSON.parse(await readFile(resolve(cliRoot, 'package.json'), 'utf8'))
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: '@foraoffice/docs-sdk',
      version: metadata.version,
      private: true,
      type: 'module',
      license: metadata.license,
      engines: { node: '>=24' },
      exports: {
        '.': { types: './editor.d.ts', default: './embedded/editor.js' },
        './editor.css': './embedded/editor.css',
        './services': { types: './services/index.d.ts', default: './services/services.cjs' },
        './mcp': './services/mcp-stdio.cjs',
        './node-host': './services/node-host.cjs',
      },
      peerDependencies: {
        '@modelcontextprotocol/sdk': metadata.devDependencies['@modelcontextprotocol/sdk'],
      },
      dependencies: Object.fromEntries(
        ['jsdom', '@rhwp/core'].map((name) => [
          name,
          cliMetadata.dependencies?.[name] ?? cliMetadata.devDependencies?.[name],
        ]),
      ),
      bundleDependencies: ['jsdom', '@rhwp/core'],
    },
    null,
    2,
  ),
)
const git = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
await writeFile(
  join(stage, 'build-info.json'),
  JSON.stringify(
    {
      baseline: '4b55db9ed1994575a695160ffc6cfd0bfc866211',
      source: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain']).length > 0,
      node: process.versions.node,
    },
    null,
    2,
  ),
)
const destination = resolve(outputRoot, 'sdk')
if (dirname(destination) !== outputRoot) throw new Error('SDK output escaped the build directory')
await rm(destination, { recursive: true, force: true })
await rename(stage, destination)
console.log(`Docs SDK: ${relative(repository, destination)}`)
