import { expect, it, vi } from 'vitest'
import { readLayoutProbe } from '../../../e2e/docs-performance-layout-probe'

it('excludes pagination header widgets and repeated rows from the source body story without hiding ordinary inline text', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  document.body.innerHTML =
    '<div class="ProseMirror"><p>Source prefix' +
    '<span class="page-gap"><span>Header/footer decoration</span></span>source suffix</p>' +
    '<table><tbody><tr><td>Authored header</td></tr>' +
    '<tr class="page-repeat-header"><td>Repeated header decoration</td></tr></tbody></table>' +
    '<div class="doc-textbox">Separate textbox story</div><p>End</p></div>'
  try {
    const input = { end: 'End', textRuns: ['Sourceprefixsourcesuffix', 'Authoredheader', 'End'] }
    expect(readLayoutProbe(input).oracle.orderedTextPresent).toBe(true)
    expect(document.body.textContent).toContain('Header/footer decoration')
    document.querySelector('.page-gap')!.className = 'ordinary-inline-content'
    expect(readLayoutProbe(input).oracle.orderedTextPresent).toBe(false)
  } finally {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})
