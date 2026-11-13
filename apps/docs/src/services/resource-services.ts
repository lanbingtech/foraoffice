import { stat } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import {
  KB_READ_CHUNK_CHARS,
  KB_READ_MAX_BYTES,
  readKnowledgeFileText,
  type KbFile,
  type KbReadPage,
  type KbSearchHit,
} from '../../../shell/src/main/knowledge-base'
import { inPlaceTarget, validateHomeCliArgs } from '../../../shell/src/main/home-cli'
import { createCliRunner, type CliRunnerPaths } from '../../../shell/src/main/mcp/cli-runner'
import { DOCS_FILE_COMMANDS } from '../shared/resource-tools'
import type { AttachmentMeta, AttachmentReadResult, UserCliRun } from '../shared/ipc'
import {
  createDocsFileAccess,
  type DocsFileAccess,
  type DocsFileAccessOptions,
} from './file-access'
import { DocsFileError } from './file-errors'

export interface DocsResourceServicesOptions extends DocsFileAccessOptions {
  cli?: CliRunnerPaths
  cwd?: string
  /** The host's live editor paths, additional to the CLI's existing GUI registry guard. */
  openFiles?(): readonly string[]
}

const MAX_FILES = 200
const MAX_CORPUS_BYTES = 100 * 1024 * 1024
const MAX_TEXT_CHARS = 2_000_000
const MAX_STD_CHARS = 32_000
const clip = (text: string) =>
  text.length > MAX_STD_CHARS ? `${text.slice(0, MAX_STD_CHARS)}\n[output truncated]` : text
const startOffset = (offset: number) =>
  Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0

class DocsResourceServices {
  private attachments: AttachmentMeta[] = []
  private knowledge: KbFile[] = []
  private attachmentRevision = 0
  private knowledgeRevision = 0
  private readonly running = new Set<AbortController>()
  private readonly cli

  constructor(
    private readonly options: DocsResourceServicesOptions,
    private readonly access: DocsFileAccess,
  ) {
    this.cli = options.cli ? createCliRunner(options.cli) : undefined
  }

  async grantFile(path: string, permissions: { read?: boolean; write?: boolean }): Promise<void> {
    await this.access.grantFile(path, permissions)
  }

  async revokeFile(path: string): Promise<void> {
    this.attachmentRevision++
    this.knowledgeRevision++
    const resolved = await this.access.revokeFile(path)
    this.attachments = this.attachments.filter((file) => file.path !== resolved)
    this.knowledge = this.knowledge.filter((file) => file.path !== resolved)
  }

  private async collection(paths: readonly string[]): Promise<KbFile[]> {
    this.access.assertLive()
    if (paths.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} resource files are allowed`)
    const files: KbFile[] = []
    const seen = new Set<string>()
    let bytes = 0
    for (const path of paths) {
      const resolved = await this.access.authorize(path, 'read')
      if (seen.has(resolved)) continue
      seen.add(resolved)
      const info = await stat(resolved)
      await this.access.authorize(resolved, 'read')
      if (!info.isFile()) throw new Error('A resource must be a regular file')
      if (info.size > KB_READ_MAX_BYTES) throw new Error('Resource file exceeds the 50 MB limit')
      bytes += info.size
      if (bytes > MAX_CORPUS_BYTES) throw new Error('Resource collection exceeds the 100 MB limit')
      files.push({
        path: resolved,
        name: basename(resolved),
        ext: extname(resolved).slice(1).toLowerCase(),
        sizeBytes: info.size,
        folder: basename(dirname(resolved)),
        folderPath: dirname(resolved),
      })
    }
    this.access.assertLive()
    return files
  }

  async setAttachments(paths: readonly string[]): Promise<AttachmentMeta[]> {
    const revision = ++this.attachmentRevision
    const files = await this.collection(paths)
    if (revision !== this.attachmentRevision)
      throw new Error('Attachment source update was superseded')
    this.attachments = files
    return this.listAttachments()
  }

  async setKnowledgeFiles(paths: readonly string[]): Promise<KbFile[]> {
    const revision = ++this.knowledgeRevision
    const files = await this.collection(paths)
    if (revision !== this.knowledgeRevision)
      throw new Error('Knowledge source update was superseded')
    this.knowledge = files
    return this.kbList()
  }

  listAttachments(): AttachmentMeta[] {
    this.access.assertLive()
    return this.attachments.map((file) => ({ ...file }))
  }
  kbList(): KbFile[] {
    this.access.assertLive()
    return this.knowledge.map((file) => ({ ...file }))
  }

  private async text(path: string, kind: 'attachment' | 'knowledge'): Promise<string> {
    const current = () => (kind === 'attachment' ? this.attachments : this.knowledge)
    this.access.assertLive()
    if (!current().some((file) => file.path === path))
      throw new DocsFileError(`The file is not an authorized ${kind} source`, 'permission_denied')
    const resolved = await this.access.authorize(path, 'read')
    const text = await readKnowledgeFileText(resolved)
    await this.access.authorize(path, 'read')
    if (!current().some((file) => file.path === path))
      throw new DocsFileError(`The ${kind} source was revoked during the read`, 'permission_denied')
    if (text.length > MAX_TEXT_CHARS)
      throw new Error('Parsed resource text exceeds the 2 million character limit')
    return text
  }

  async readAttachment(
    path: string,
    offset: number,
    maxChars: number,
  ): Promise<AttachmentReadResult> {
    const text = await this.text(path, 'attachment')
    const start = startOffset(offset)
    const limit = Number.isFinite(maxChars)
      ? Math.min(KB_READ_CHUNK_CHARS, Math.max(0, Math.floor(maxChars)))
      : KB_READ_CHUNK_CHARS
    return {
      ok: true,
      name: basename(path),
      text: text.slice(start, start + limit),
      totalChars: text.length,
      offset: start,
    }
  }

  async kbRead(path: string, offset: number): Promise<KbReadPage> {
    const text = await this.text(path, 'knowledge')
    const start = startOffset(offset)
    return {
      text: text.slice(start, start + KB_READ_CHUNK_CHARS),
      totalChars: text.length,
      offset: start,
    }
  }

  /** Small host-granted corpora need no separate index or search service. */
  async kbSearch(query: { q: string; limit?: number }): Promise<KbSearchHit[]> {
    this.access.assertLive()
    const q = query.q.trim().slice(0, 200).toLowerCase()
    if (!q) return []
    const limit = Number.isFinite(query.limit)
      ? Math.min(20, Math.max(1, Math.floor(query.limit!)))
      : 8
    const result: KbSearchHit[] = []
    for (const file of [...this.knowledge]) {
      const text = await this.text(file.path, 'knowledge')
      const found = text.toLowerCase().indexOf(q)
      if (found < 0) continue
      result.push({
        path: file.path,
        name: file.name,
        ext: file.ext,
        folder: file.folder,
        snippet: text.slice(Math.max(0, found - 100), found + q.length + 200),
      })
      if (result.length >= limit) break
    }
    return result.filter((hit) => this.knowledge.some((file) => file.path === hit.path))
  }

  async runCli(raw: string[], signal?: AbortSignal): Promise<UserCliRun> {
    let started = false
    const controller = new AbortController()
    const abort = () => controller.abort()
    try {
      this.access.assertLive()
      const args = validateHomeCliArgs(raw, 'use a granted ops file for large edits')
      if (!DOCS_FILE_COMMANDS.has(args[0]))
        throw new Error('Only file commands are available to the document host')
      if (inPlaceTarget(args)) throw new Error('Edits must write a new file: add --out <path>')
      if (args.some((arg) => arg.includes('\0')))
        throw new Error('CLI arguments cannot contain NUL characters')
      if (!this.cli) throw new Error('The host has no bundled Office CLI')
      if (signal?.aborted) throw new Error('The CLI operation was canceled before starting')
      const cwd = this.options.cwd ? resolve(this.options.cwd) : undefined
      const env = {
        ...this.access.cliEnvironment(this.options.openFiles?.()),
        GENOFFICE_APP_DISCOVERY: 'off',
        GENOFFICE_APP_BIN: this.options.cli?.env?.GENOFFICE_APP_BIN ?? '',
        GENOFFICE_AUDIT_LOG: 'off',
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.running.add(controller)
      started = true
      const out = await this.cli.run(args, {
        cwd,
        env,
        signal: controller.signal,
        timeoutMs: 120_000,
      })
      // Keep parser/engine detail objects in the child, not in host IPC results.
      const json: UserCliRun['json'] =
        out.json?.status === 'ok'
          ? {
              status: 'ok',
              command: out.json.command,
              summary: clip(out.json.summary),
              ...(out.json.output_path ? { output_path: out.json.output_path } : {}),
            }
          : out.json?.status === 'error'
            ? {
                status: 'error',
                command: out.json.command,
                code: out.json.code,
                message: clip(out.json.message),
              }
            : undefined
      return {
        ok: out.ok,
        code: out.code,
        ...(json ? { json } : {}),
        stdout: clip(out.stdout),
        stderr: clip(out.stderr),
        committed: out.ok
          ? typeof (out.json?.status === 'ok' ? out.json.output_path : undefined) === 'string'
          : null,
        ...(cwd ? { cwd } : {}),
      }
    } catch (error) {
      return {
        ok: false,
        code: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        committed: started ? null : false,
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.running.delete(controller)
    }
  }

  dispose(): void {
    this.access.dispose()
    this.attachments = []
    this.knowledge = []
    for (const controller of this.running) controller.abort()
    this.running.clear()
  }
}

export type { DocsResourceServices }

export async function createDocsResourceServices(
  options: DocsResourceServicesOptions,
): Promise<DocsResourceServices> {
  return new DocsResourceServices(options, await createDocsFileAccess(options))
}
