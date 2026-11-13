import { createDocsFileSession } from '@foraoffice/docs-sdk/services'
import { join, resolve } from 'node:path'

const [directory, sourceName, outputName] = process.argv.slice(2)
if (!directory || !sourceName || !outputName)
  throw new Error('Usage: node examples/files.mjs DOCUMENT_DIRECTORY SOURCE.docx OUTPUT.docx')
const root = resolve(directory)
const files = await createDocsFileSession({
  stateDirectory: join(root, '.docs-state'),
  readRoots: [root],
  writeRoots: [root],
})
try {
  const source = join(root, sourceName)
  const opened = await files.open(source)
  if (!opened || 'needsPassword' in opened)
    throw new Error('An unencrypted Word document is required')
  const asset = await files.readAsset(opened.dataUrl)
  if (!asset) throw new Error('Document bytes are unavailable')
  await files.save(join(root, outputName), asset.body, { sourcePath: source, overwrite: false })
} finally {
  files.dispose()
}
