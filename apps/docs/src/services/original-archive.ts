import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export async function archiveOriginal(
  stateDirectory: string,
  filePath: string,
  hash: string,
  size: number,
): Promise<void> {
  // a copy larger than the whole cap would only evict every other original
  if (size > ORIGINALS_MAX_BYTES) return
  const dir = join(stateDirectory, 'originals')
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${hash}.docx`)
  if (!existsSync(target)) await copyFile(filePath, target)
  void pruneOriginals(dir)
}

const ORIGINALS_MAX_BYTES = 500 * 1024 * 1024
const originalsPruneRunning = new Set<string>()

/** cap the archive's total size; oldest by mtime go first (never blocks the open path) */
async function pruneOriginals(dir: string): Promise<void> {
  if (originalsPruneRunning.has(dir)) return
  originalsPruneRunning.add(dir)
  try {
    const files: Array<{ path: string; size: number; mtimeMs: number }> = []
    for (const name of await readdir(dir)) {
      try {
        const s = await stat(join(dir, name))
        if (s.isFile()) files.push({ path: join(dir, name), size: s.size, mtimeMs: s.mtimeMs })
      } catch {
        /* removed concurrently */
      }
    }
    let total = files.reduce((sum, f) => sum + f.size, 0)
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const f of files) {
      if (total <= ORIGINALS_MAX_BYTES) break
      try {
        await unlink(f.path)
        total -= f.size
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* directory unreadable: retry on the next archive */
  } finally {
    originalsPruneRunning.delete(dir)
  }
}
