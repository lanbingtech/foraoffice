import { expect, it, vi } from 'vitest'
import { capturePrintSourceSnapshot } from '../../../e2e/docs-performance-print-snapshot'

it('captures exact cell identity through real clip styles and ignores empty prune spacers', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.stubGlobal('devicePixelRatio', 1)
  document.body.innerHTML =
    '<div class="pagination-preview" style="zoom:1" data-rect="0,0,800,1000">' +
    '<div class="pv-page" data-pv-section="0" style="width:800px;height:1000px" data-rect="0,0,800,998">' +
    '<div class="pv-clip" style="overflow-x:hidden;overflow-y:hidden" data-rect="0,100,800,800">' +
    '<div class="pv-content" data-pv-body data-rect="50,105,700,780">' +
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
    expect(captured.snapshot.regions[0]).toEqual({
      page: 0,
      owner: 'body',
      role: 'body',
      rect: { x: 0, y: 78.75, width: 600, height: 585 },
    })
    expect(captured.snapshot.regions.filter((region) => region.owner !== 'body')).toEqual([
      { page: 0, owner: 'T:0:1', role: 'body', rect: { x: 7.5, y: 90, width: 150, height: 270 } },
    ])
    const content = document.querySelector<HTMLElement>('.pv-content')!
    content.style.clipPath = 'inset(0px 30px)'
    expect(capturePrintSourceSnapshot().snapshot.regions[0].rect).toEqual({
      x: 60,
      y: 78.75,
      width: 480,
      height: 585,
    })
    content.style.clipPath = 'none'
    const paper = document.querySelector<HTMLElement>('.pv-page')!
    paper.getBoundingClientRect = () => new DOMRect(0, 0, 799.98575, 998)
    expect(capturePrintSourceSnapshot().snapshot.pages[0].width).toBe(600)
    paper.getBoundingClientRect = () => new DOMRect(0, 0, 810, 998)
    expect(capturePrintSourceSnapshot).toThrow('Authored print paper geometry is missing or scaled')
    paper.getBoundingClientRect = () => new DOMRect(0, 0, 800, 998)
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

it('captures section identity and positioned HF paragraphs without assigning them to the body', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.stubGlobal('devicePixelRatio', 1)
  document.body.innerHTML =
    '<div class="pagination-preview" style="zoom:1"><div class="pv-page" data-pv-section="2" style="width:800px;height:1000px" data-rect="0,0,800,998">' +
    '<div class="page-hf page-hf-header" data-rect="50,20,700,20"><div class="page-hf-para" data-rect="50,15,700,25">Header source</div></div></div></div>'
  for (const element of document.querySelectorAll<HTMLElement>('[data-rect]')) {
    const [x, y, width, height] = element.dataset.rect!.split(',').map(Number)
    element.getBoundingClientRect = () => new DOMRect(x, y, width, height)
  }
  const win = window as unknown as Record<string, unknown>
  win.__previewDebug = {
    sourceCells: () => ({ version: 1, disposed: false, modelCurrent: true, tables: [] }),
  }
  win.__pageDebug = { sourceStories: () => ({ version: 1, disposed: false, blocks: [] }) }
  try {
    const captured = capturePrintSourceSnapshot()
    expect(captured.pageSections).toEqual([2])
    expect(captured.snapshot.regions).toContainEqual({
      page: 0,
      owner: 'hf:0:header',
      role: 'body',
      rect: { x: 37.5, y: 11.25, width: 525, height: 18.75 },
    })
    document.querySelector<HTMLElement>('.pv-page')!.removeAttribute('data-pv-section')
    expect(capturePrintSourceSnapshot).toThrow('Print section identity is missing')
  } finally {
    delete win.__previewDebug
    delete win.__pageDebug
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})
