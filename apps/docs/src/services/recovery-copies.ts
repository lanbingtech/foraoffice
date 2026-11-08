import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '@genoffice/electron-utils/atomic-write'

/** Shared recovery epochs prevent an in-flight tick from resurrecting discarded content. */
export class RecoveryCopies {
  private readonly epochs = new Map<string, number>()
  private readonly writes = new Map<string, Promise<boolean>>()
  constructor(private readonly directory: string) {}

  pathFor(path: string): string {
    return join(
      this.directory,
      `${createHash('sha1').update(path).digest('hex').slice(0, 16)}.docx`,
    )
  }

  clear(path: string): void {
    this.epochs.set(path, (this.epochs.get(path) ?? 0) + 1)
    this.remove(path)
  }

  private remove(path: string): void {
    try {
      unlinkSync(this.pathFor(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async inspect(path: string): Promise<{ diskNewer: boolean } | null> {
    try {
      const [copy, original] = await Promise.all([stat(this.pathFor(path)), stat(path)])
      return { diskNewer: original.mtimeMs >= copy.mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  read(path: string): Promise<Buffer> {
    return readFile(this.pathFor(path))
  }

  write(path: string, prepare: () => Buffer | null, isCurrent: () => boolean): Promise<boolean> {
    const epoch = this.epochs.get(path) ?? 0
    const run = async () => {
      await mkdir(this.directory, { recursive: true })
      if (!isCurrent() || (this.epochs.get(path) ?? 0) !== epoch) return false
      const bytes = prepare()
      if (!bytes) return false
      await atomicWriteFile(this.pathFor(path), bytes)
      if (!isCurrent() || (this.epochs.get(path) ?? 0) !== epoch) {
        this.remove(path)
        return false
      }
      return true
    }
    const previous = this.writes.get(path) ?? Promise.resolve(false)
    const result = previous.catch(() => false).then(run)
    this.writes.set(path, result)
    const settled = () => {
      if (this.writes.get(path) === result) this.writes.delete(path)
    }
    void result.then(settled, settled)
    return result
  }
}
