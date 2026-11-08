import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { DocsHostBridge } from '../apps/docs/src/services/host-bridge'

interface SdkTransport {
  start(): void
  close(): void
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>
  onNotification(handler: (method: string, params: unknown) => void): void
}

/** Uses the installed Harness's own SDK protocol and model routing, with an isolated profile. */
export async function runRealDshDocs(options: {
  node: string
  packages: string
  credentials: string
  cwd: string
  bridge: Pick<DocsHostBridge, 'url' | 'token'>
  prompt: string
}): Promise<void> {
  const home = join(options.cwd, 'home')
  await mkdir(home)
  const patch = join(options.cwd, 'docs.patch.yml')
  const disabled = [
    'tool-bash',
    'tool-pwsh',
    'tool-jobs',
    'tool-fs',
    'tool-fs-search',
    'tool-skill',
    'tool-working-directory',
    'tool-subagent',
    'tool-subagent-fork',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-workflow',
  ]
  await writeFile(
    patch,
    [
      ...disabled.map((id) => `- id: ${id}\n  disabled: true`),
      `- id: credentials\n  config:\n    path: ${JSON.stringify(options.credentials)}\n    watch: false`,
      '- id: approval\n  config:\n    policy: never',
      '- insert:',
      '    - id: foraoffice-docs',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        transport: stdio',
      '        serverName: foraoffice',
      `        command: ${JSON.stringify(process.execPath)}`,
      `        args: ${JSON.stringify([resolve(__dirname, '../apps/docs/out/services/mcp-stdio.cjs')])}`,
      '        failOnStartupError: true',
      '        env:',
      '          FORAOFFICE_DOCS_ENDPOINT: !!js "process.env.FORAOFFICE_DOCS_ENDPOINT"',
      '          FORAOFFICE_DOCS_TOKEN: !!js "process.env.FORAOFFICE_DOCS_TOKEN"',
    ].join('\n') + '\n',
  )
  const child = spawn(
    options.node,
    [join(options.packages, 'dsh/lib/bin.js'), '--profile', 'sdk', '--patch', patch],
    {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PRIMARY_RUNTIME: '',
        DSH_BUNDLED_OFFICE_CLI: '',
        FORAOFFICE_DOCS_ENDPOINT: options.bridge.url,
        FORAOFFICE_DOCS_TOKEN: options.bridge.token,
      },
    },
  )
  const { JsonRpcLineTransport } = createRequire(__filename)(
    join(options.packages, 'dsh-sdk-protocol/lib/index.js'),
  ) as {
    JsonRpcLineTransport: new (input: Readable, output: Writable) => SdkTransport
  }
  const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
  let stderr = ''
  const events: Array<{ method: string; params: unknown }> = []
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-200_000)
  })
  transport.onNotification((method, params) => {
    events.push({ method, params })
  })
  const completion = new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('close', done)
  })
  // Observe startup failures even while waiting for a protocol response.
  void completion.catch(() => {})
  transport.start()
  const signal = AbortSignal.timeout(120_000)
  try {
    await transport.request(
      'initialize',
      { cwd: options.cwd, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096 },
      signal,
    )
    const sessionId = randomUUID()
    await transport.request(
      'session/prompt',
      { sessionId, contentBlocks: [{ type: 'text', text: options.prompt }] },
      signal,
    )
    // prompt returns an enqueue receipt; only wait establishes actual turn completion.
    await transport.request('session/wait', { sessionId }, signal)
    await transport.request('shutdown', {}, signal)
  } finally {
    transport.close()
    child.stdin.end()
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
    }, 5_000)
    try {
      await completion
    } finally {
      clearTimeout(timeout)
    }
    const redact = (text: string) => text.replaceAll(options.bridge.token, '[REDACTED]')
    await Promise.all([
      writeFile(
        join(options.cwd, 'dsh-events.jsonl'),
        events.map((event) => redact(JSON.stringify(event))).join('\n') + '\n',
      ),
      writeFile(join(options.cwd, 'dsh-stderr.log'), redact(stderr)),
    ])
  }
}
