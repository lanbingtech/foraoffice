import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The owning host provides an authorized document grant through the child environment.
const require = createRequire(import.meta.url)
const client = new Client({ name: 'docs-tools-example', version: '1' })
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [require.resolve('@foraoffice/docs-sdk/mcp')],
      env: { ...process.env },
    }),
  )
  console.log(JSON.stringify(await client.listTools(), null, 2))
  const result = await client.callTool({ name: 'read_document', arguments: {} })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  console.log(JSON.stringify(result.content, null, 2))
} finally {
  await client.close()
}
