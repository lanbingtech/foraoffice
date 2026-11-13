import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createDocsMcpServer } from './docs-mcp'
import { connectDocsHostBridge } from './host-bridge'

async function main(): Promise<void> {
  const url = process.env.FORAOFFICE_DOCS_ENDPOINT
  const token = process.env.FORAOFFICE_DOCS_TOKEN
  if (!url || !token)
    throw new Error('The host must supply FORAOFFICE_DOCS_ENDPOINT and FORAOFFICE_DOCS_TOKEN')
  const endpoint = connectDocsHostBridge({ url, token })
  const server = createDocsMcpServer({ version: '0.1.0', endpoint })
  await server.connect(new StdioServerTransport())
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Docs MCP startup failed'}\n`)
  process.exitCode = 1
})
