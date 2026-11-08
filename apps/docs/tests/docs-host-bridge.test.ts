// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { createDocsHostBridge, type DocsHostBridge } from '../src/services/host-bridge'
import type { McpCommandMessage } from '../src/shared/ipc'

let bridge: DocsHostBridge | undefined
afterEach(async () => {
  await bridge?.close()
})

it('requires the host credential and binds calls to host-owned identities', async () => {
  const accepted: McpCommandMessage[] = []
  bridge = await createDocsHostBridge({
    bindingId: 'authorized-document',
    releaseScope() {},
    endpoint: {
      request: async (message) => {
        accepted.push(message)
        return { text: 'Authorized content' }
      },
      closeCaller() {},
    },
  })
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 'read',
    method: 'docs.request',
    params: { message: { command: 'read_document' } },
  })
  const rejected = await fetch(bridge.url, {
    method: 'POST',
    body,
    headers: { authorization: 'Bearer wrong-credential' },
  })
  expect(rejected.status).toBe(401)
  expect(await rejected.text()).not.toContain(bridge.token)
  expect(accepted).toHaveLength(0)
  const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
  const spoofed = await fetch(bridge.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'spoof',
      method: 'docs.request',
      params: {
        message: {
          command: 'read_document',
          callerId: 'chosen-caller',
          bindingId: 'another-document',
        },
      },
    }),
  })
  expect(await spoofed.json()).toMatchObject({ id: 'spoof', error: { code: -32602 } })
  expect(accepted).toHaveLength(0)
  const result = await fetch(bridge.url, { method: 'POST', headers, body })
  expect(await result.json()).toMatchObject({ id: 'read', result: { text: 'Authorized content' } })
  expect(accepted[0]).toMatchObject({ bindingId: 'authorized-document', command: 'read_document' })
  expect(accepted[0].callerId).not.toBe('chosen-caller')
})

it('uses JSON-RPC error, batch and notification response rules', async () => {
  bridge = await createDocsHostBridge({
    bindingId: 'bound-document',
    releaseScope() {},
    endpoint: {
      request: async () => ({ text: 'Content' }),
      closeCaller() {},
    },
  })
  const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
  const parseError = await fetch(bridge.url, { method: 'POST', headers, body: '{' })
  expect(await parseError.json()).toMatchObject({ id: null, error: { code: -32700 } })
  const notification = {
    jsonrpc: '2.0',
    method: 'docs.request',
    params: { message: { command: 'read_document' } },
  }
  const notified = await fetch(bridge.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(notification),
  })
  expect(notified.status).toBe(204)
  expect(await notified.text()).toBe('')
  const batch = await fetch(bridge.url, {
    method: 'POST',
    headers,
    body: JSON.stringify([
      notification,
      { ...notification, id: 7 },
      { jsonrpc: '2.0', id: 8, method: 'unknown' },
    ]),
  })
  expect(await batch.json()).toEqual([
    { jsonrpc: '2.0', id: 7, result: { text: 'Content' } },
    { jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'Method not found' } },
  ])
})

it('propagates an abandoned request to the editor operation signal', async () => {
  let started!: () => void
  let stopped!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const canceled = new Promise<void>((resolve) => {
    stopped = resolve
  })
  bridge = await createDocsHostBridge({
    bindingId: 'bound-document',
    releaseScope() {},
    endpoint: {
      request: (_message, signal) =>
        new Promise((_resolve, reject) => {
          started()
          signal.addEventListener(
            'abort',
            () => {
              stopped()
              reject(new Error('Canceled'))
            },
            { once: true },
          )
        }),
      closeCaller() {},
    },
  })
  const controller = new AbortController()
  const pending = fetch(bridge.url, {
    method: 'POST',
    signal: controller.signal,
    headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'run',
      method: 'docs.request',
      params: { message: { command: 'read_document' } },
    }),
  })
  await running
  controller.abort()
  await expect(pending).rejects.toThrow()
  await canceled
})
