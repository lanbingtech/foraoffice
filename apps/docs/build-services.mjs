import { build } from 'esbuild'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const output = resolve(root, 'out/services')
await mkdir(output, { recursive: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    services: 'src/services/index.ts',
    'mcp-stdio': 'src/services/mcp-stdio.ts',
    'node-host': 'src/services/node-host.ts',
  },
  outdir: output,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  define: { 'import.meta.url': '__docsServiceImportMetaUrl' },
  banner: {
    js: "const __docsServiceImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  bundle: true,
  external: ['@rhwp/core'],
  metafile: true,
  legalComments: 'linked',
  logLevel: 'info',
})
if (Object.keys(result.metafile.inputs).some((path) => /(?:^|\/)electron(?:\/|$)/.test(path)))
  throw new Error('The independent Docs service must not include Electron')
if (
  Object.keys(result.metafile.inputs).some(
    (path) =>
      path.includes('packages/ai-provider/src/') ||
      /packages\/agent-core\/src\/(?:loop|electron-transport|stream-text)\.ts$/.test(path),
  )
)
  throw new Error('The independent Docs service must not include model or Agent execution')
await writeFile(resolve(output, 'metafile.json'), JSON.stringify(result.metafile, null, 2))
await cp(resolve(root, 'hosts/qt/web'), resolve(root, 'out/qt'), { recursive: true })
// Native hosts consume the same locale data as Electron, without importing its shell.
const localeBundle = await build({
  absWorkingDir: root,
  entryPoints: ['src/shared/native-i18n/index.ts'],
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
  write: false,
})
const { docsNativeDictionaries } = await import(
  `data:text/javascript;base64,${Buffer.from(localeBundle.outputFiles[0].contents).toString('base64')}`
)
await writeFile(resolve(root, 'out/qt/native-strings.json'), JSON.stringify(docsNativeDictionaries))
