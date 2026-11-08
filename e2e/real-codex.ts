import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import type { DocsHostBridge } from '../apps/docs/src/services/host-bridge'

/** Explicit opt-in real Harness acceptance. Auth stays in Codex; the editor receives no model credentials. */
export async function runRealCodexDocs(options: {
  entry?: string
  cwd: string
  bridge: Pick<DocsHostBridge, 'url' | 'token'>
  prompt: string
  windowsSandbox?: 'elevated' | 'mxc'
  wsl?: { distribution: string; binary: string; home: string }
}): Promise<void> {
  if (!!options.entry === !!options.wsl)
    throw new Error('Choose exactly one native or WSL Codex executable')
  const linuxPath = (path: string) => {
    const match = /^([a-z]):[\\/](.*)$/i.exec(path)
    if (!match) throw new Error('WSL acceptance requires an absolute Windows drive path')
    return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
  }
  const cwd = options.wsl ? linuxPath(options.cwd) : options.cwd
  const filesystem = {
    ':minimal': 'read',
    [cwd]: 'read',
    ...(options.wsl
      ? {
          // Codex re-executes its sandbox helper through a session-owned alias to its packaged binary.
          [`${options.wsl.home}/tmp`]: 'read',
          [posix.resolve(posix.dirname(options.wsl.binary), '..')]: 'read',
        }
      : {}),
  }
  const filesystemToml = `{ ${Object.entries(filesystem)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(', ')} }`
  const config = (key: string, value: string) => ['-c', `${key}=${value}`]
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--json',
    '--skip-git-repo-check',
    '-C',
    cwd,
    '-m',
    'gpt-6.1-sol',
    ...config('approval_policy', '"never"'),
    ...config('model_reasoning_effort', '"low"'),
    ...(options.windowsSandbox
      ? config('windows.sandbox', JSON.stringify(options.windowsSandbox))
      : []),
    ...config('default_permissions', '"foraoffice_acceptance"'),
    ...config('permissions.foraoffice_acceptance.filesystem', filesystemToml),
    ...config(
      'mcp_servers.foraoffice.command',
      JSON.stringify(options.wsl ? linuxPath(process.execPath) : process.execPath),
    ),
    ...config(
      'mcp_servers.foraoffice.args',
      JSON.stringify([resolve(__dirname, '../apps/docs/out/services/mcp-stdio.cjs')]),
    ),
    ...config(
      'mcp_servers.foraoffice.env_vars',
      '["FORAOFFICE_DOCS_ENDPOINT", "FORAOFFICE_DOCS_TOKEN"]',
    ),
    // Only these two writes are preauthorized for the isolated synthetic-document scenario.
    ...config('mcp_servers.foraoffice.tools.replace_selection.approval_mode', '"approve"'),
    ...config('mcp_servers.foraoffice.tools.save_document.approval_mode', '"approve"'),
    '-',
  ]
  const wslVariables = (process.env.WSLENV ?? '')
    .split(':')
    .filter(
      (name) =>
        name &&
        !['CODEX_HOME', 'FORAOFFICE_DOCS_ENDPOINT', 'FORAOFFICE_DOCS_TOKEN'].includes(
          name.split('/')[0],
        ),
    )
  const child = spawn(
    options.wsl ? 'wsl.exe' : process.execPath,
    options.wsl
      ? ['--distribution', options.wsl.distribution, '--exec', options.wsl.binary, ...args]
      : [options.entry!, ...args],
    {
      cwd: options.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        FORAOFFICE_DOCS_ENDPOINT: options.bridge.url,
        FORAOFFICE_DOCS_TOKEN: options.bridge.token,
        ...(options.wsl
          ? {
              CODEX_HOME: options.wsl.home,
              WSLENV: [
                ...wslVariables,
                'CODEX_HOME',
                'FORAOFFICE_DOCS_ENDPOINT',
                'FORAOFFICE_DOCS_TOKEN',
              ].join(':'),
            }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    const text = chunk.toString('utf8')
    if (target === 'stdout') stdout = (stdout + text).slice(-2_000_000)
    else stderr = (stderr + text).slice(-200_000)
  }
  child.stdout.on('data', (chunk) => append('stdout', chunk))
  child.stderr.on('data', (chunk) => append('stderr', chunk))
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, 120_000)
  try {
    const completion = new Promise<number | null>((done, reject) => {
      child.once('error', reject)
      child.once('close', (code) => done(code))
    })
    child.stdin.on('error', () => {
      /* The close/error event reports an early process failure. */
    })
    child.stdin.end(options.prompt)
    const code = await completion
    const redact = (text: string) => text.replaceAll(options.bridge.token, '[REDACTED]')
    await Promise.all([
      writeFile(join(options.cwd, 'codex-events.jsonl'), redact(stdout)),
      writeFile(join(options.cwd, 'codex-stderr.log'), redact(stderr)),
    ])
    if (code !== 0 || timedOut)
      throw new Error(
        `Codex acceptance ${timedOut ? 'timed out' : `exited ${code}`}: ${redact(stderr).slice(-2000)}`,
      )
    const events: unknown[] = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    if (
      !events.some(
        (event) =>
          event && typeof event === 'object' && 'type' in event && event.type === 'turn.completed',
      )
    )
      throw new Error(
        'Codex did not report a completed turn; inspect the isolated acceptance events',
      )
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}
