// Controlled native-host network fixture, not a Docs/MCP acceptance substitute.
const { createServer } = require('node:http')
const { createInterface } = require('node:readline')
const token = 'owned-resource-cancellation-fixture'
let closing = false
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 2 })
  response.write('x')
  // Leave one byte pending so cancellation always occurs during the native transfer.
})
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const input = createInterface({ input: process.stdin })
input.on('line', async (line) => {
  const message = JSON.parse(line)
  if (message.method !== 'initialize') return
  await ready
  if (!closing)
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          assets: { url: `http://127.0.0.1:${server.address().port}/asset`, token },
        },
      }) + '\n',
    )
})
input.on('close', () => {
  closing = true
  server.close()
  server.closeAllConnections()
})
