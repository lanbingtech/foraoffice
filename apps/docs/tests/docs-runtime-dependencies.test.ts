// @vitest-environment node
import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { resolve } from 'node:path'

it.each(['runtime/docs-runtime.ts', 'embedded.tsx'])(
  'keeps %s independent of native Agent inference and panels',
  async (entry) => {
    const bundle = await build({
      entryPoints: [resolve(__dirname, '../src/renderer', entry)],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      logLevel: 'silent',
      outdir: 'runtime-dependency-check',
      loader: { '.png': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    })
    const dependencies = Object.keys(bundle.metafile!.inputs).map((path) =>
      path.replaceAll('\\', '/'),
    )
    expect(
      dependencies.filter(
        (path) =>
          /\/ai\/(?:doc-writer|native-workflows|native-ui|AiPanel|transport)\.(?:ts|tsx)$/.test(
            path,
          ) ||
          path.includes('packages/ai-provider/src/') ||
          /packages\/agent-core\/src\/(?:loop|electron-transport|stream-text)\.ts$/.test(path),
      ),
    ).toEqual([])
  },
)
