// @vitest-environment node
import { expect, it, vi } from 'vitest'
import type { Page } from '@playwright/test'
import { collectPlatformFonts } from '../../../e2e/docs-performance-fonts'

it('records actual Latin and fallback faces from document text parents, excluding chrome and glyph counts', async () => {
  const detach = vi.fn()
  const send = vi.fn(async (method: string, params?: { nodeId: number }) => {
    if (method === 'DOM.getDocument')
      return {
        root: {
          nodeId: 1,
          nodeType: 1,
          nodeValue: '',
          children: [
            {
              nodeId: 2,
              nodeType: 1,
              nodeValue: '',
              attributes: ['class', 'ProseMirror'],
              children: [
                { nodeId: 3, nodeType: 3, nodeValue: 'Latin' },
                {
                  nodeId: 4,
                  nodeType: 1,
                  nodeValue: '',
                  children: [{ nodeId: 5, nodeType: 3, nodeValue: '中文' }],
                },
              ],
            },
            {
              nodeId: 6,
              nodeType: 1,
              nodeValue: '',
              children: [{ nodeId: 7, nodeType: 3, nodeValue: 'File' }],
            },
          ],
        },
      }
    if (method === 'CSS.getPlatformFontsForNode')
      return {
        fonts: [
          {
            familyName: params?.nodeId === 2 ? 'Arial' : 'Microsoft YaHei',
            postScriptName: params?.nodeId === 2 ? 'ArialMT' : 'MicrosoftYaHei',
            isCustomFont: false,
            glyphCount: 5,
          },
        ],
      }
    return {}
  })
  const page = {
    context: () => ({ newCDPSession: async () => ({ send, detach }) }),
  } as unknown as Page
  expect(await collectPlatformFonts(page)).toMatchObject({
    queriedParents: 2,
    identities: [
      { familyName: 'Arial', postScriptName: 'ArialMT', isCustomFont: false },
      { familyName: 'Microsoft YaHei', postScriptName: 'MicrosoftYaHei', isCustomFont: false },
    ],
  })
  expect(
    send.mock.calls
      .filter(([name]) => name === 'CSS.getPlatformFontsForNode')
      .map(([, args]) => args?.nodeId),
  ).toEqual([2, 4])
  expect(detach).toHaveBeenCalledOnce()
})
