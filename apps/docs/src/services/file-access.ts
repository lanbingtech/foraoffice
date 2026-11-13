import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DocsFileError } from './file-errors'

export interface DocsFileAccessOptions {
  stateDirectory: string
  readRoots: readonly string[]
  writeRoots: readonly string[]
}

export const inside = (root: string, path: string): boolean => {
  const remainder = relative(root, path)
  return (
    remainder === '' ||
    (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
  )
}

/** Resolve missing outputs through their nearest existing ancestor as well. */
export async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return resolve(await canonical(parent), basename(path))
  }
}

class DocsFileAccess {
  private disposed = false
  private readonly readFiles = new Set<string>()
  private readonly writeFiles = new Set<string>()

  constructor(private readonly policy: DocsFileAccessOptions) {}

  assertLive(): void {
    if (this.disposed) throw new DocsFileError('File access is closed', 'stale_target')
  }

  private async path(path: string): Promise<string> {
    this.assertLive()
    if (!isAbsolute(path))
      throw new DocsFileError('An absolute file path is required', 'invalid_input')
    const resolved = await canonical(path)
    this.assertLive()
    if (inside(this.policy.stateDirectory, resolved))
      throw new DocsFileError(
        'Private document state is outside the authorized roots',
        'permission_denied',
      )
    return resolved
  }

  async authorize(path: string, purpose: 'read' | 'write'): Promise<string> {
    const resolved = await this.path(path)
    const grants = purpose === 'read' ? this.readFiles : this.writeFiles
    const roots = purpose === 'read' ? this.policy.readRoots : this.policy.writeRoots
    if (!grants.has(resolved) && !roots.some((root) => inside(root, resolved)))
      throw new DocsFileError('File path is outside the authorized roots', 'permission_denied')
    return resolved
  }

  /** Trusted host only: a native picker approved this exact file, never its folder. */
  async grantFile(path: string, permissions: { read?: boolean; write?: boolean }): Promise<void> {
    const resolved = await this.path(path)
    const existing = await stat(resolved).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (existing && !existing.isFile())
      throw new DocsFileError('A grant must name a regular file', 'invalid_input')
    this.assertLive()
    if (permissions.read) this.readFiles.add(resolved)
    if (permissions.write) this.writeFiles.add(resolved)
  }

  async revokeFile(path: string): Promise<string> {
    const resolved = await this.path(path)
    this.readFiles.delete(resolved)
    this.writeFiles.delete(resolved)
    return resolved
  }

  /** Validate a native-picked folder without expanding this access object's file grants. */
  async validateSelectedDirectory(path: string): Promise<string> {
    const resolved = await this.path(path)
    if (!(await stat(resolved)).isDirectory())
      throw new DocsFileError('The selected path must be a directory', 'invalid_input')
    this.assertLive()
    return resolved
  }

  /** Internal child configuration; empty grants remain deny-all, even with legacy env roots. */
  cliEnvironment(deniedWriteFiles: readonly string[] = []): NodeJS.ProcessEnv {
    this.assertLive()
    return {
      GENOFFICE_ALLOWED_ROOTS: '',
      GENOFFICE_FILE_POLICY: JSON.stringify({
        readRoots: this.policy.readRoots,
        writeRoots: this.policy.writeRoots,
        readFiles: [...this.readFiles],
        writeFiles: [...this.writeFiles],
        deniedRoots: [this.policy.stateDirectory],
        deniedWriteFiles,
      }),
    }
  }

  dispose(): void {
    this.disposed = true
    this.readFiles.clear()
    this.writeFiles.clear()
  }
}

export type { DocsFileAccess }

export async function createDocsFileAccess(
  options: DocsFileAccessOptions,
): Promise<DocsFileAccess> {
  return new DocsFileAccess({
    stateDirectory: await canonical(resolve(options.stateDirectory)),
    readRoots: await Promise.all(options.readRoots.map((root) => realpath(resolve(root)))),
    writeRoots: await Promise.all(options.writeRoots.map((root) => realpath(resolve(root)))),
  })
}
