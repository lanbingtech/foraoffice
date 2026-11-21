import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { DecorationSet } from '@tiptap/pm/view'
import type { HfParagraph, ParsedDocFull, StyleDisplay, StyleInfo } from '@genoffice/docx-engine'
import { docStyleCss } from '../src/renderer/doc-style-css'
import type { PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { paraBorderMergePluginKey } from '../src/renderer/editor/decoration-extensions'
import { revisionDisplayState } from '../src/renderer/editor/marks'
import {
  hfBorderMergeFlags,
  hfParaBorderStyle,
  makeGapHfEl,
  type HfStripGeom,
} from '../src/renderer/editor/hf-dom'
import { sameBorderGroup } from '../src/renderer/editor/para-border-merge'
import { appendStreamedNodes } from '../src/renderer/file-actions'
import { getLang, setModuleLang, t } from '../src/renderer/i18n/locale'

;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }

function paraStyle(attrs: Record<string, unknown>): CSSStyleDeclaration {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null, ...attrs },
          content: [{ type: 'text', text: 'x' }],
        },
      ],
    },
  })
  const style = editor.view.dom.querySelector('p')!.style
  editor.destroy()
  return style
}

function parsedWith(styleId: string, display: StyleDisplay): ParsedDocFull {
  const styles = new Map<string, StyleInfo>()
  styles.set('Normal', {
    styleId: 'Normal',
    name: 'Normal',
    type: 'paragraph',
    isDefault: true,
  } as StyleInfo)
  styles.set(styleId, {
    styleId,
    name: styleId,
    type: 'paragraph',
    basedOn: 'Normal',
    display,
  } as StyleInfo)
  return { styles, docDefaults: {}, blocks: [] } as unknown as ParsedDocFull
}

const PAD = JSON.stringify({ t: 30, b: 30, l: 31, r: 31 })

describe('none-side w:space padding (direct pPr)', () => {
  it('pads top/bottom, widens the shading box left/right, text stays put', () => {
    const style = paraStyle({ borderReset: 'tblr', borderPad: PAD, shadingFill: 'FCFCFC' })
    expect(style.paddingTop).toBe('30pt')
    expect(style.paddingBottom).toBe('30pt')
    expect(style.paddingLeft).toBe('')
    expect(style.getPropertyValue('--pbdr-l')).toBe('31pt')
    expect(style.getPropertyValue('--pbdr-r')).toBe('31pt')
    expect(style.getPropertyValue('--pbdr-fill')).toBe('#FCFCFC')
    expect(style.boxShadow).toContain('calc(-1 * var(--pbdr-l, 0pt)) 0 0 var(--pbdr-fill)')
  })

  it('a reset side without space still zeroes the style padding', () => {
    const style = paraStyle({ borderReset: 'tb', borderPad: JSON.stringify({ t: 12 }) })
    expect(style.paddingTop).toBe('12pt')
    expect(style.paddingBottom).toBe('0px')
    expect(style.boxShadow).toBe('')
  })
})

describe('none-side w:space padding (style level)', () => {
  it('heading with a drawn bottom and inherited none top/sides', () => {
    const css = docStyleCss(
      parsedWith('H2', {
        borderSides: {
          t: { none: true, spacePt: 30 },
          l: { none: true, spacePt: 31 },
          b: { color: 'EEEEEE', szPt: 0.75, spacePt: 3 },
          r: { none: true, spacePt: 31 },
        },
      }),
    )
    expect(css).toContain(
      '[data-style="H2"] { border-bottom:1px solid #EEEEEE;padding-top:30pt;padding-bottom:3pt;--pbdr-l:31pt;--pbdr-r:31pt;box-shadow:',
    )
    expect(css).not.toContain('border-top')
  })

  it('style shading exposes the fill for the widened box', () => {
    const css = docStyleCss(parsedWith('Shd', { shadingFill: 'FCFCFC' }))
    expect(css).toContain('background-color:#FCFCFC;--pbdr-fill:#FCFCFC }')
    expect(css).not.toContain('box-shadow')
  })
})

describe('border groups compare the none-side padding too', () => {
  it('pad-only paragraphs group when identical, split when not', () => {
    expect(sameBorderGroup({ borderPad: PAD }, { borderPad: PAD })).toBe(true)
    expect(
      sameBorderGroup({ borderPad: PAD }, { borderPad: JSON.stringify({ t: 30, b: 30 }) }),
    ).toBe(false)
    expect(sameBorderGroup({ borders: 'b', borderPad: PAD }, { borders: 'b' })).toBe(false)
  })
})

function editorWith(paras: Array<Record<string, unknown>>, styles?: Map<string, StyleInfo>) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: paras.map((attrs) => ({
        type: 'docParagraph',
        attrs: { docxIndex: null, ...attrs },
        content: [{ type: 'text', text: 'x' }],
      })),
    },
  })
  if (styles) {
    editor.storage.listNumbering.styles = styles
    editor.view.dispatch(editor.state.tr)
  }
  return editor
}
const classesOf = (editor: Editor) =>
  Array.from(editor.view.dom.querySelectorAll('p')).map((p) =>
    Array.from(p.classList)
      .filter((c) => c.startsWith('pbdr-'))
      .join(' '),
  )

describe('body border groups in the editor', () => {
  it('revisits the append boundary and keeps earlier border decorations', () => {
    const parsed = parsedNormal({ borderSides: NORMAL_SIDES })
    const prefix = [{}, {}, {}, { styleId: 'Other' }, {}]
    const suffix = [{}, {}, { styleId: 'Other' }, {}, {}]
    const live = editorWith(prefix, parsed.styles)
    const full = editorWith([...prefix, ...suffix], parsed.styles)
    try {
      const initial = paraBorderMergePluginKey.getState(live.state)!.set
      const add = vi.spyOn(initial, 'add')
      const nodes = full.state.doc.toJSON().content.slice(prefix.length)
      appendStreamedNodes(live, nodes.slice(0, 1))
      expect(add).toHaveBeenCalledOnce()
      expect(classesOf(live).slice(-2)).toEqual(['pbdr-suppress-bottom', 'pbdr-suppress-top'])
      const remove = vi.spyOn(paraBorderMergePluginKey.getState(live.state)!.set, 'remove')
      const end = live.state.doc.content.size
      const boundary = end - live.state.doc.lastChild!.nodeSize
      appendStreamedNodes(live, nodes.slice(1))

      const next = paraBorderMergePluginKey.getState(live.state)!.set.find()
      expect(classesOf(live)).toEqual(classesOf(full))
      expect(next).toEqual(paraBorderMergePluginKey.getState(full.state)!.set.find())
      expect(remove).toHaveBeenCalledWith([expect.objectContaining({ from: boundary, to: end })])
      expect(classesOf(live)[prefix.length]).toBe('pbdr-suppress-top pbdr-suppress-bottom')

      const beforeTail = paraBorderMergePluginKey.getState(live.state)!.set
      appendStreamedNodes(live, [
        { type: 'docParagraph', attrs: { styleId: 'Other' } },
        { type: 'docParagraph', attrs: { styleId: 'Other' } },
      ])
      expect(paraBorderMergePluginKey.getState(live.state)!.set).toBe(beforeTail)
    } finally {
      live.destroy()
      full.destroy()
    }
  })

  it('a local edit that only adds borderPad joins the group', () => {
    const editor = editorWith([{ borderPad: PAD }, {}])
    expect(classesOf(editor)).toEqual(['', ''])
    const second = editor.state.doc.child(1)
    const pos = editor.state.doc.child(0).nodeSize
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { ...second.attrs, borderPad: PAD }),
    )
    expect(classesOf(editor)).toEqual(['pbdr-suppress-bottom', 'pbdr-suppress-top'])
    editor.destroy()
  })

  it('same-style paragraphs whose borders come from the style merge', () => {
    const parsed = parsedWith('H2', {
      borderSides: { t: { none: true, spacePt: 30 }, b: { szPt: 0.75, spacePt: 3 } },
    } as StyleDisplay)
    const editor = editorWith(
      [{ styleId: 'H2' }, { styleId: 'H2' }, { styleId: 'Normal' }],
      parsed.styles,
    )
    expect(classesOf(editor)).toEqual(['pbdr-suppress-bottom', 'pbdr-suppress-top', ''])
    editor.destroy()
  })
})

it('matches full revision and whitespace decoration across streamed chunks and view changes', () => {
  const mark = { author: 'Alice' }
  const para = (attrs: PmNode['attrs'], content: PmNode[]): PmNode => ({
    type: 'docParagraph',
    attrs,
    content,
  })
  const content = [
    para(
      {
        align: 'right',
        pPrChange: JSON.stringify({ ...mark, old: { align: 'center', lineSpacing: 1 } }),
        moveRevision: 'to',
      },
      [{ type: 'text', text: 'prefix', marks: [{ type: 'ins', attrs: mark }] }],
    ),
    para(
      {
        paraMarkDel: JSON.stringify(mark),
        pPrChange: JSON.stringify({ ...mark, old: { align: 'left' } }),
      },
      [{ type: 'text', text: 'head' }],
    ),
    para({ paraMarkDel: JSON.stringify(mark) }, [
      { type: 'text', text: 'hidden', marks: [{ type: 'del', attrs: mark }] },
    ]),
    para({ moveRevision: 'from' }, [
      { type: 'text', text: 'moved', marks: [{ type: 'del', attrs: { ...mark, move: 'from' } }] },
      { type: 'text', text: ' ', marks: [{ type: 'docTextStyle', attrs: { sizeHalfPoints: 48 } }] },
      { type: 'text', text: 'suffix' },
    ]),
  ]
  const create = (nodes: PmNode[]) =>
    new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: { type: 'doc', content: nodes },
    })
  const revisionAndWhitespace = (editor: Editor) => {
    const states = editor.state.plugins.flatMap((plugin) => {
      const key = Reflect.get(plugin.spec.key ?? {}, 'key')
      if (
        typeof key !== 'string' ||
        !/^(pPrChange|moveRevision|paraMarkDel|wsRunLineHeight)\$/.test(key)
      )
        return []
      const set = plugin.props.decorations?.call(plugin, editor.state)
      expect(set).toBeInstanceOf(DecorationSet)
      return [{ key, decorations: (set as DecorationSet).find() }]
    })
    expect(states).toHaveLength(4)
    return states
  }
  const mode = revisionDisplayState.mode
  const lang = getLang()
  const live = create(content.slice(0, 1))
  const full = create(content)
  try {
    revisionDisplayState.mode = 'original'
    setModuleLang('en')
    appendStreamedNodes(live, content.slice(1, 2))
    full.commands.setContent({ type: 'doc', content: content.slice(0, 2) })
    expect(revisionAndWhitespace(live)).toEqual(revisionAndWhitespace(full))

    setModuleLang('zh')
    appendStreamedNodes(live, content.slice(2, 3))
    expect(
      live.view.dom.querySelector('.has-ppr-change')?.getAttribute('data-ppr-change-label'),
    ).toBe(t('editorFormatRevision'))

    revisionDisplayState.mode = 'none'
    live.view.dispatch(live.state.tr)
    expect(live.view.dom.querySelector('.doc-para-join-head')).toBeNull()
    appendStreamedNodes(live, content.slice(3))
    full.commands.setContent({ type: 'doc', content })
    expect(revisionAndWhitespace(live)).toEqual(revisionAndWhitespace(full))
    expect(live.view.dom.querySelector('p.doc-para-join-head')?.textContent).toBe('head')
    expect(live.view.dom.querySelector('p.doc-para-join-tail')).not.toBeNull()
    expect(live.view.dom.querySelector('p.has-move-to')?.getAttribute('data-rev-author')).toBe(
      'Alice',
    )
    expect(live.view.dom.querySelector('p.has-move-from')).toBeNull()
    expect(live.view.dom.querySelector('.doc-ws-run')?.textContent).toBe(' ')
  } finally {
    live.destroy()
    full.destroy()
    revisionDisplayState.mode = mode
    setModuleLang(lang)
  }
})

const NORMAL_SIDES = {
  t: { none: true, spacePt: 30 },
  b: { none: true, spacePt: 30 },
  l: { none: true, spacePt: 31 },
} satisfies NonNullable<StyleDisplay['borderSides']>

function parsedNormal(display: StyleDisplay): ParsedDocFull {
  const styles = new Map<string, StyleInfo>()
  styles.set('Normal', {
    styleId: 'Normal',
    name: 'Normal',
    type: 'paragraph',
    isDefault: true,
    display,
  } as StyleInfo)
  return { styles, docDefaults: {}, blocks: [] } as unknown as ParsedDocFull
}

describe('unstyled paragraphs take the default style borders', () => {
  it('Normal none-side pads reach paragraphs without w:pStyle', () => {
    const css = docStyleCss(parsedNormal({ borderSides: NORMAL_SIDES } as StyleDisplay))
    const rule = css.split('\n').find((r) => r.startsWith('.doc-page p:not([data-style])'))
    expect(rule).toContain('padding-top:30pt')
    expect(rule).toContain('padding-bottom:30pt')
    expect(rule).toContain('--pbdr-l:31pt')
  })

  it('two unstyled paragraphs form one group; a text edit keeps the decorations as they are', () => {
    const parsed = parsedNormal({ borderSides: NORMAL_SIDES } as StyleDisplay)
    const editor = editorWith([{}, {}, { styleId: 'Other' }], parsed.styles)
    expect(classesOf(editor)).toEqual(['pbdr-suppress-bottom', 'pbdr-suppress-top', ''])
    editor.view.dispatch(editor.state.tr.insertText('y', 2))
    expect(paraBorderMergePluginKey.getState(editor.state)!.set.find().length).toBe(2)
    expect(classesOf(editor)).toEqual(['pbdr-suppress-bottom', 'pbdr-suppress-top', ''])
    editor.destroy()
  })
})

describe('a table between two Normal-bordered paragraphs', () => {
  it('splits the group instead of inheriting Normal', () => {
    const parsed = parsedNormal({ borderSides: NORMAL_SIDES } as StyleDisplay)
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docParagraph',
            attrs: { docxIndex: null },
            content: [{ type: 'text', text: 'a' }],
          },
          {
            type: 'docTable',
            content: [
              {
                type: 'docTableRow',
                content: [
                  {
                    type: 'docTableCell',
                    content: [{ type: 'docParagraph', attrs: { docxIndex: null } }],
                  },
                ],
              },
            ],
          },
          {
            type: 'docParagraph',
            attrs: { docxIndex: null },
            content: [{ type: 'text', text: 'b' }],
          },
        ],
      },
    })
    editor.storage.listNumbering.styles = parsed.styles
    editor.view.dispatch(editor.state.tr)
    const tops = Array.from(editor.view.dom.children).map((el) =>
      Array.from(el.classList)
        .filter((c) => c.startsWith('pbdr-'))
        .join(' '),
    )
    expect(tops.filter(Boolean)).toEqual([])
    editor.destroy()
  })
})

describe('direct shading clear', () => {
  it('also empties the widened fill box of a shaded style', () => {
    const style = paraStyle({ shadingClear: true })
    expect(style.backgroundColor).toBe('transparent')
    expect(style.getPropertyValue('--pbdr-fill')).toBe('transparent')
  })
})

const geom: HfStripGeom = {
  pageW: 794,
  pageH: 1123,
  marginLeft: 84,
  marginRight: 84,
  marginTop: 96,
  marginBottom: 96,
  headerStripTop: 47,
  footerDist: 47,
}

describe('header/footer border groups', () => {
  const rule: HfParagraph = {
    borders: 'b',
    borderLines: { b: { color: '00AEEF', szPt: 0.5 } },
    runs: [{ text: 'Brand' }],
  }
  const blank: HfParagraph = { ...rule, runs: [] }

  it('two adjacent paragraphs with the same bottom pBdr draw one rule under the group', () => {
    const flags = hfBorderMergeFlags([rule, blank])
    expect(flags).toEqual([
      { suppressTop: false, suppressBottom: true },
      { suppressTop: true, suppressBottom: false },
    ])
    expect(hfParaBorderStyle(rule, flags[0]).style.borderBottom).toBeUndefined()
    expect(hfParaBorderStyle(blank, flags[1]).style.borderBottom).toBe('1px solid #00AEEF')
    const el = makeGapHfEl({
      kind: 'header',
      value: { text: 'Brand', paras: [rule, blank] },
      pageNo: 1,
      pageTotal: 1,
      geom,
    })
    const ruled = [...el.querySelectorAll<HTMLElement>('.page-hf-para')].filter(
      (p) => p.style.borderBottom !== '',
    )
    expect(ruled).toHaveLength(1)
  })

  it('a table row between them splits the group; pads apply as padding', () => {
    const padded: HfParagraph = {
      ...rule,
      borderPad: { t: 30, l: 31, r: 31 },
      shadingFill: 'EEEEEE',
    }
    const flags = hfBorderMergeFlags([padded, { cells: [], runs: [] } as HfParagraph, padded])
    expect(flags.map((f) => f.suppressBottom)).toEqual([false, false, false])
    const { style } = hfParaBorderStyle(padded, flags[0])
    expect(style.paddingTop).toBe('30pt')
    expect(style['--pbdr-l']).toBe('31pt')
    expect(style['--pbdr-fill']).toBe('#EEEEEE')
    expect(style.boxShadow).toContain('var(--pbdr-fill)')
  })
})
