import type { AgentToolDef } from '@genoffice/agent-core'

export const DOCS_OFFICE_CLI_TOOL: AgentToolDef = {
  name: 'run_cli',
  description:
    "Run the bundled genoffice command line (it always answers --json). Only this app's own CLI, not a general shell: document commands such as convert, create, info, docs, sheet, slides, pdf; no --force, and apply/replace must take --out. Relative paths resolve in the open document's folder; reads and writes stay inside the allowed folders the result names.",
  inputSchema: {
    type: 'object',
    properties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'the command and its arguments, e.g. ["convert","in.docx","--to","pdf"]',
      },
    },
    required: ['args'],
  },
}
