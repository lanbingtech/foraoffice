import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { isDocsOperationResult } from './operation-result'
import { DOCS_HARNESS_WORKFLOWS } from './harness-workflows'

/** Standard MCP image content keeps binary media out of textual/structured diagnostics. */
export function formatDocsMcpResult(result: unknown, toolName?: string): CallToolResult {
  if (isDocsOperationResult(result)) {
    const { media, display, ...operation } = result
    const metadata =
      toolName === 'get_editor_capabilities' && !result.isError
        ? {
            ...operation,
            output: JSON.stringify({
              ...JSON.parse(operation.output),
              harnessWorkflows: DOCS_HARNESS_WORKFLOWS,
            }),
          }
        : operation
    return {
      content: [
        { type: 'text', text: JSON.stringify(metadata) },
        ...(media ? [{ type: 'image' as const, data: media.data, mimeType: media.mimeType }] : []),
      ],
      structuredContent: metadata,
      ...(display ? { _meta: { 'io.foraoffice/display': display } } : {}),
      ...(result.isError ? { isError: true } : {}),
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    ...(result !== null && typeof result === 'object' && !Array.isArray(result)
      ? { structuredContent: result as Record<string, unknown> }
      : {}),
  }
}
