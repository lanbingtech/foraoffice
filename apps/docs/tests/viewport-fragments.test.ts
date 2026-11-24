import { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import {
  intersectsViewport,
  measurePictureFragments,
} from '../src/renderer/editor/viewport-fragments'

const schema = new Schema({
  nodes: {
    doc: { content: 'docParagraph+' },
    docParagraph: { content: 'inline*' },
    docInlineImage: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { wrap: { default: null } },
    },
    text: { group: 'inline' },
  },
})

const picture = (left: number, top: number) => {
  const element = document.createElement('span')
  element.className = 'doc-inline-pic'
  element.getBoundingClientRect = () => new DOMRect(left, top, 100, 200)
  return element
}

describe('published picture fragment geometry', () => {
  it('uses the original model positions and converts zoomed boxes to canvas coordinates', () => {
    const image = schema.nodes.docInlineImage.create()
    const paragraph = schema.nodes.docParagraph.create(null, [image, image, image])
    const nodes = new Map([
      [2001, picture(50, 90)],
      [2002, picture(50, 490)],
      [2003, picture(50, 890)],
    ])
    const view = { nodeDOM: (pos: number) => nodes.get(pos) ?? null }
    const fragments = measurePictureFragments(view, paragraph, 2000, new DOMRect(10, 90), 2)!
    expect(
      fragments.filter((item) => intersectsViewport(item.box, { top: 100, bottom: 400 })),
    ).toEqual([{ from: 2002, to: 2003, box: { left: 20, top: 200, width: 50, height: 100 } }])
  })

  it('leaves mixed content and anchored pictures in the normal paragraph layout', () => {
    const canvas = new DOMRect(0, 0, 100, 100)
    const view = { nodeDOM: () => picture(0, 0) }
    const ordinary = schema.nodes.docInlineImage.create()
    const floating = schema.nodes.docInlineImage.create({ wrap: 'square-left' })
    for (const content of [
      [ordinary, schema.text('caption')],
      [ordinary, floating],
    ]) {
      const paragraph = schema.nodes.docParagraph.create(null, content)
      expect(measurePictureFragments(view, paragraph, 0, canvas, 1)).toBeUndefined()
    }
  })
})
