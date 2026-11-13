/** Render the original ForaOffice vector mark into desktop icon containers. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'apps/shell/src/renderer/src/assets/foraoffice-icon.svg'))
const browser = await chromium.launch({
  channel:
    process.env.FORAOFFICE_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'chrome' : undefined),
})
const images = new Map()
try {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    })
    await page.setContent(
      `<body style="margin:0"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${source.toString('base64')}"></body>`,
    )
    images.set(size, await page.screenshot({ omitBackground: true }))
    await page.close()
  }
} finally {
  await browser.close()
}
const sizes = [16, 24, 32, 48, 64, 128, 256]
const header = Buffer.alloc(6)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
const entries = Buffer.alloc(16 * sizes.length)
let offset = header.length + entries.length
sizes.forEach((size, index) => {
  const png = images.get(size)
  const entry = index * 16
  entries.writeUInt8(size === 256 ? 0 : size, entry)
  entries.writeUInt8(size === 256 ? 0 : size, entry + 1)
  entries.writeUInt16LE(1, entry + 4)
  entries.writeUInt16LE(32, entry + 6)
  entries.writeUInt32LE(png.length, entry + 8)
  entries.writeUInt32LE(offset, entry + 12)
  offset += png.length
})
const ico = Buffer.concat([header, entries, ...sizes.map((size) => images.get(size))])
const icnsChunks = [
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
].map(([size, type]) => {
  const png = images.get(size)
  const chunk = Buffer.alloc(8)
  chunk.write(type)
  chunk.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([chunk, png])
})
const icnsHeader = Buffer.alloc(8)
icnsHeader.write('icns')
icnsHeader.writeUInt32BE(8 + icnsChunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
for (const app of ['docs', 'shell']) {
  const directory = join(root, 'apps', app, 'build')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'icon.png'), images.get(1024))
  await writeFile(join(directory, 'icon-mac.png'), images.get(1024))
  await writeFile(join(directory, 'icon.ico'), ico)
  await writeFile(join(directory, 'icon.icns'), Buffer.concat([icnsHeader, ...icnsChunks]))
  const renderer = app === 'shell' ? 'src/renderer/src/assets' : 'src/renderer/assets'
  await cp(join(directory, 'icon.png'), join(root, 'apps', app, renderer, 'app-icon.png'))
}
const linux = join(root, 'apps/shell/build/icons')
await mkdir(linux, { recursive: true })
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024])
  await writeFile(join(linux, `${size}x${size}.png`), images.get(size))
console.log('ForaOffice application icons generated from the original vector mark')
