import { expect, it, vi } from 'vitest'
import { capturePrintSourceSnapshot } from '../../../e2e/docs-performance-print-snapshot'

it('captures exact cell identity through real clip styles and ignores empty prune spacers', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.stubGlobal('devicePixelRatio', 1)
  document.body.innerHTML =
    '<div class="pagination-preview" style="zoom:1" data-rect="0,0,800,1000">' +
    '<div class="pv-page" style="width:800px;height:1000px" data-rect="0,0,800,998">' +
    '<div class="pv-clip" style="overflow:hidden" data-rect="0,100,800,800">' +
    '<div class="pv-content" data-pv-body data-rect="0,-500,800,2000">' +
    '<div class="pv-prune-spacer" data-rect="0,-500,800,600"></div>' +
    '<table class="doc-table" data-idx="1" data-rect="0,80,800,400"><tbody>' +
    '<tr data-rect="0,80,800,400"><td data-rect="0,80,800,400">' +
    '<p style="clip-path:inset(40px 0px 0px)" data-rect="10,80,200,400">Public source cell</p>' +
    '</td></tr></tbody></table></div></div></div></div>'
  for (const element of document.querySelectorAll<HTMLElement>('[data-rect]')) {
    const [x, y, width, height] = element.dataset.rect!.split(',').map(Number)
    element.getBoundingClientRect = () => new DOMRect(x, y, width, height)
  }
  const identity = { table: 'T', row: 0, cell: 1 }
  const source = {
    version: 1,
    disposed: false,
    modelCurrent: true,
    blocks: [],
    rowSplits: [],
    tables: [
      {
        docxIndex: 1,
        sourceTable: 'T',
        rows: [{ cells: [{ sourceCell: identity as typeof identity | null }] }],
      },
    ],
  }
  const win = window as unknown as Record<string, unknown>
  win.__previewDebug = { sourceCells: () => source }
  win.__pageDebug = { sourceStories: () => ({ version: 1, disposed: false, blocks: [] }) }
  try {
    const captured = capturePrintSourceSnapshot()
    expect(captured.snapshot.pages).toEqual([{ width: 600, height: 750 }])
    expect(captured.snapshot.regions.filter((region) => region.owner !== 'body')).toEqual([
      { page: 0, owner: 'T:0:1', role: 'body', rect: { x: 7.5, y: 90, width: 150, height: 270 } },
    ])
    source.version = 2
    expect(capturePrintSourceSnapshot).toThrow('Current print source diagnostics')
    source.version = 1
    const paragraph = document.querySelector('p')!
    paragraph.style.visibility = 'hidden'
    expect(
      capturePrintSourceSnapshot().snapshot.regions.filter((region) => region.owner !== 'body'),
    ).toEqual([])
    paragraph.style.visibility = 'visible'
    source.tables[0].rows[0].cells[0].sourceCell = null
    expect(capturePrintSourceSnapshot).toThrow('Printed cell source identity is unknown')
    source.tables[0].rows[0].cells[0].sourceCell = identity
    paragraph.style.clipPath = 'polygon(0 0,100% 0,0 100%)'
    expect(capturePrintSourceSnapshot).toThrow('Unsupported visible print clip-path')
  } finally {
    delete win.__previewDebug
    delete win.__pageDebug
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})
