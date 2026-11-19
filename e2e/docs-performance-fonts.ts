import type { Page } from '@playwright/test'

interface DomNode {
  nodeId: number
  nodeType: number
  nodeValue: string
  attributes?: string[]
  children?: DomNode[]
  shadowRoots?: DomNode[]
}

/** Actual used faces from Chromium; collect after each unchanged-document timing ends. */
export async function collectPlatformFonts(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
    const parents = new Set<number>()
    const visit = (node: DomNode, inside = false) => {
      const attributes = node.attributes ?? []
      const classIndex = attributes.indexOf('class')
      const current =
        inside ||
        (classIndex >= 0 && attributes[classIndex + 1].split(/\s+/).includes('ProseMirror'))
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        if (current && child.nodeType === 3 && child.nodeValue.trim()) parents.add(node.nodeId)
        visit(child, current)
      }
    }
    visit(root)
    const identities = new Map<
      string,
      { familyName: string; postScriptName: string; isCustomFont: boolean }
    >()
    for (const nodeId of parents) {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      for (const font of fonts)
        if (font.glyphCount > 0) {
          const identity = {
            familyName: font.familyName,
            postScriptName: font.postScriptName,
            isCustomFont: font.isCustomFont,
          }
          identities.set(JSON.stringify(identity), identity)
        }
    }
    if (!parents.size || !identities.size)
      throw new Error('Actual rendered document font identities are missing')
    return {
      provenance:
        'CDP CSS.getPlatformFontsForNode; every nonempty document text parent after unchanged-document verification; identities exclude glyph counts',
      queriedParents: parents.size,
      identities: [...identities.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value),
    }
  } finally {
    await cdp.detach()
  }
}
