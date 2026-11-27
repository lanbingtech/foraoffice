import type { Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withDeadline } from './docs-performance-result'

/** A renderer diagnostic failure must never discard an already observed Node-side probe. */
export async function captureFailureEvidence(
  page: Page,
  root: string,
  scenario: string,
  error: unknown,
): Promise<string[]> {
  const cached = {
    scenario,
    measurementError: String(error),
    lastProbe:
      typeof error === 'object' && error !== null && 'lastProbe' in error
        ? error.lastProbe
        : undefined,
  }
  await writeFile(join(root, 'failure-state.json'), JSON.stringify(cached, null, 2))
  const diagnostics: string[] = []
  try {
    const state = await withDeadline(
      page.evaluate(() => ({
        status: document.querySelector('.status-bar')?.textContent,
        previewPages: document.querySelectorAll('.pv-page').length,
        menuItems: [...document.querySelectorAll('[role="menuitem"]')].map((item) => ({
          text: item.textContent,
          disabled: item.getAttribute('aria-disabled'),
        })),
        activity: (
          window as unknown as { __docsLayoutActivity?: { snapshot(): unknown } }
        ).__docsLayoutActivity?.snapshot(),
        documentText: document.querySelector('.ProseMirror')?.textContent,
      })),
      5_000,
      'failure DOM context',
    )
    await writeFile(
      join(root, 'failure-state.json'),
      JSON.stringify({ ...cached, ...state, documentText: undefined }, null, 2),
    )
    if (state.documentText !== undefined)
      await writeFile(join(root, 'failure-document-text.txt'), state.documentText ?? '')
  } catch (diagnostic) {
    diagnostics.push(`Failure DOM context unavailable: ${String(diagnostic)}`)
  }
  try {
    const image = await withDeadline(
      page.screenshot({ type: 'png', timeout: 5_000 }),
      5_000,
      'failure screenshot',
    )
    await writeFile(join(root, 'failure.png'), image)
  } catch (diagnostic) {
    diagnostics.push(`Failure screenshot unavailable: ${String(diagnostic)}`)
  }
  return diagnostics
}
