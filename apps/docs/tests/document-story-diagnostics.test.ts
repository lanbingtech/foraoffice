import { expect, it } from 'vitest'
import { DOMSerializer } from '@tiptap/pm/model'
import { parseDocx, type Block } from '@genoffice/docx-engine'
import { buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'
import { renderTextboxSpec } from '../src/renderer/editor/protected-render'
import {
  createDocumentStoryDiagnostic,
  disposeOwnedDiagnostic,
} from '../src/renderer/document-story-diagnostic'

const shape = (id: string, body: string) =>
  '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  `<wps:cNvPr id="${id}"/><wps:cNvSpPr/><wps:spPr>` +
  '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1800000" cy="1080000"/></a:xfrm>' +
  '<a:prstGeom prst="rect"/></wps:spPr>' +
  `<wps:txbx><w:txbxContent>${body}</w:txbxContent></wps:txbx></wps:wsp>`
const drawing = (xml: string) =>
  '<w:drawing><wp:inline><wp:extent cx="1800000" cy="1080000"/>' +
  '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
  xml +
  '</a:graphicData></a:graphic></wp:inline></w:drawing>'
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`

it('retains source identities for complex read-only boxes while leaving an unaddressable nested box unknown', async () => {
  const nested = drawing(shape('30', paragraph('Nested story')))
  const originalXml =
    '<w:p><w:r>' +
    drawing(shape('31', paragraph('Outer story') + `<w:p><w:r>${nested}</w:r></w:p>`)) +
    drawing(shape('32', paragraph('Last story'))) +
    '</w:r></w:p>'
  const parsed = await parseDocx(await buildDocx({ bodyXml: originalXml }))
  const boxes = parsed.blocks[0].textboxes!
  expect(boxes).toHaveLength(3)
  expect(boxes[0]).toMatchObject({ txbxIndex: 0, readOnly: true })
  expect(boxes[1]).toMatchObject({ readOnly: true })
  expect(boxes[1].txbxIndex).toBeUndefined()
  expect(boxes[1].shapeId).toBeUndefined()
  expect(boxes[2]).toMatchObject({ txbxIndex: 1, shapeId: '32' })
  const rendered = boxes.map(
    (box) => DOMSerializer.renderSpec(document, renderTextboxSpec(box) as never).dom as HTMLElement,
  )
  expect(rendered[0].dataset.sourceTxbxIndex).toBe('0')
  expect(rendered[0].dataset.sourceShapeId).toBe('31')
  expect(rendered[1].hasAttribute('data-source-txbx-index')).toBe(false)
  expect(rendered[1].hasAttribute('data-source-shape-id')).toBe(false)
  // Display position 2 addresses source segment 1, rather than inventing ordinal 2.
  expect(rendered[2].dataset.sourceTxbxIndex).toBe('1')
  expect(rendered[2].dataset.sourceShapeId).toBe('32')
  expect(rendered[2].textContent).toBe('Last story')
})

it('reads only on request and binds the current document and layout generation without retaining old XML or image bytes', () => {
  const blocks: Block[] = [
    {
      id: 'original',
      type: 'passthrough',
      docxIndex: 7,
      originalXml: '<w:p>first</w:p>',
      textboxes: [
        {
          txbxIndex: 3,
          readOnly: true,
          paras: [],
          picture: true,
          fillImageDataUrl: 'data:image/png;base64,PRIVATE',
        },
      ],
    },
  ]
  let reads = 0
  let current = {
    documentGeneration: 2,
    layoutGeneration: 10,
    document: { hash: 'original-hash', blocks } as { hash: string; blocks: Block[] } | null,
  }
  const diagnostic = createDocumentStoryDiagnostic(() => {
    reads++
    return current
  })
  expect(JSON.stringify({ sourceStories: diagnostic.snapshot })).toBe('{}')
  expect(reads).toBe(0)
  const first = diagnostic.snapshot()
  expect(first).toMatchObject({
    version: 1,
    documentGeneration: 2,
    layoutGeneration: 10,
    documentHash: 'original-hash',
    blocks: [
      {
        docxIndex: 7,
        originalXml: '<w:p>first</w:p>',
        textboxes: [{ txbxIndex: 3, readOnly: true }],
      },
    ],
  })
  expect(JSON.stringify(first)).not.toContain('PRIVATE')
  current = {
    documentGeneration: 3,
    layoutGeneration: 12,
    document: {
      hash: 'replacement-hash',
      blocks: [
        {
          ...blocks[0],
          docxIndex: 1,
          originalXml: '<w:p>replacement</w:p>',
          textboxes: [{ paras: [] }],
        },
      ],
    },
  }
  const second = diagnostic.snapshot()
  expect(reads).toBe(2)
  expect(second).toMatchObject({
    documentGeneration: 3,
    layoutGeneration: 12,
    documentHash: 'replacement-hash',
    blocks: [{ docxIndex: 1, originalXml: '<w:p>replacement</w:p>', textboxes: [{}] }],
  })
  expect(second.blocks[0].textboxes[0]).not.toHaveProperty('txbxIndex')
  expect(second.blocks[0].textboxes[0]).not.toHaveProperty('shapeId')
  expect(first.blocks[0].originalXml).toBe('<w:p>first</w:p>')
  current = { ...current, documentGeneration: 4, document: null }
  expect(diagnostic.snapshot()).toMatchObject({
    documentGeneration: 4,
    documentHash: null,
    blocks: [],
  })
  current = { ...current, document: { hash: 'still-live-private-source', blocks } }
  diagnostic.dispose()
  const readsBeforeRetiredCall = reads
  expect(diagnostic.snapshot()).toMatchObject({ disposed: true, documentHash: null, blocks: [] })
  expect(reads).toBe(readsBeforeRetiredCall)
})

it('retires only the owning global diagnostic method when another instance has replaced it', () => {
  const current = () => ({ documentGeneration: 1, layoutGeneration: 1, document: null })
  const old = createDocumentStoryDiagnostic(current)
  const newer = createDocumentStoryDiagnostic(current)
  const target: Record<string, unknown> = { sourceStories: newer.snapshot }
  disposeOwnedDiagnostic(target, 'sourceStories', old.snapshot, old.dispose)
  expect(target.sourceStories).toBe(newer.snapshot)
  expect(old.snapshot()).toMatchObject({ disposed: true, blocks: [] })
  disposeOwnedDiagnostic(target, 'sourceStories', newer.snapshot, newer.dispose)
  expect(target).not.toHaveProperty('sourceStories')
})

it('serializes untrusted shape identity as attribute data without creating markup', () => {
  const shapeId = '"><img src=x onerror=alert(1)>'
  const dom = DOMSerializer.renderSpec(document, renderTextboxSpec({ shapeId, paras: [] }) as never)
    .dom as HTMLElement
  expect(dom.dataset.sourceShapeId).toBe(shapeId)
  expect(dom.querySelector('img')).toBeNull()
  expect(dom.hasAttribute('onerror')).toBe(false)
})
