import { DOCS_OFFICE_CLI_TOOL } from '../../shared/cli-tool-schema'
import type { UserCliRun } from '../../shared/ipc'
import type { DocsResourceTools } from '../../shared/resource-tools'
import { t } from '../i18n/locale'

export function createOfficeCliTools(
  runCli: (args: string[], signal?: AbortSignal) => Promise<UserCliRun>,
): DocsResourceTools {
  return {
    tools: [DOCS_OFFICE_CLI_TOOL],
    executeTool: async (call, signal) => {
      try {
        if (call.name === 'run_cli') {
          const args = call.input.args
          if (
            !Array.isArray(args) ||
            args.length === 0 ||
            args.some((a) => typeof a !== 'string')
          ) {
            return {
              output: 'args must be a non-empty array of strings',
              isError: true,
              committed: false,
              summary: t('aiSumRunCli', { args: '?' }),
            }
          }
          if (signal?.aborted)
            return {
              output: 'The CLI operation was canceled before starting',
              isError: true,
              committed: false,
              summary: call.name,
            }
          const out: UserCliRun = await runCli(args as string[], signal)
          const json = (out.json ?? {}) as { summary?: string; output_path?: string }
          const committed =
            out.committed === undefined
              ? out.ok
                ? typeof json.output_path === 'string'
                : null
              : out.committed
          const summary = typeof json.summary === 'string' ? `\nsummary: ${json.summary}` : ''
          const where = [
            out.cwd ? `cwd: ${out.cwd}` : '',
            out.allowedRoots?.length ? `allowed folders: ${out.allowedRoots.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n')
          return {
            output: `exit ${out.code}${summary}\n${out.stdout}${
              out.stderr ? `\n[stderr]\n${out.stderr}` : ''
            }${where ? `\n${where}` : ''}`,
            isError: !out.ok,
            // a CLI run that wrote a file changed the world, not this editor's
            // document: count it as a mutation so the loop does not treat the
            // repeat as a redundant read, and so the final answer reports it
            mutated: committed === true,
            committed,
            summary: t('aiSumRunCli', { args: (args as string[]).join(' ') }),
          }
        }
        return { output: `unknown tool: ${call.name}`, isError: true, summary: call.name }
      } catch (err) {
        // in a standalone docs window (not the full app) the main process has
        // no handler for these channels — say that instead of leaking a raw
        // IPC error into the transcript
        return {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
          committed: null,
          summary: call.name,
        }
      }
    },
  }
}
