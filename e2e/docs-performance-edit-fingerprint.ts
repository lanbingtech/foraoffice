/** Runs in the host page on its main editor root. */
export function readEditFingerprint(root: Element): { text: string; paragraphs: number } {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT

        const element = node as Element
        // Pagination can recreate these subtrees or refresh TOC pages after undo.
        if (element.matches('.page-gap, .page-repeat-header, .doc-toc-line .doc-toc-page')) {
          return NodeFilter.FILTER_REJECT
        }
        return element.parentElement === root && element.localName === 'p'
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP
      },
    },
  )

  const text: string[] = []
  let paragraphs = 0
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.nodeType === Node.TEXT_NODE) text.push(node.textContent ?? '')
    else paragraphs += 1
  }
  return { text: text.join(''), paragraphs }
}
