import type { AgentToolDef } from '@genoffice/agent-core'

export const STYLE_TYPES = ['paragraph', 'character', 'table'] as const

export const ALIGNS = ['left', 'center', 'right', 'justify'] as const

export const HIGHLIGHTS = [
  'yellow',
  'green',
  'cyan',
  'magenta',
  'blue',
  'red',
  'darkBlue',
  'darkCyan',
  'darkGreen',
  'darkMagenta',
  'darkRed',
  'darkYellow',
  'darkGray',
  'lightGray',
  'black',
  'white',
]

export const LENGTH_DESC =
  'a length like "0.5in", "1.27cm", "12pt" (bare numbers are points), or null to clear'

export const DEFINE_STYLE_TOOL: AgentToolDef = {
  name: 'define_style',
  description:
    'Create a style or change the definition of an existing one (paragraph, character or table style in styles.xml). Only the fields given change; everything else the style already defines is kept. ' +
    'Paragraphs using the style pick the change up automatically. Use apply_style (or the applyStyle op) to put a style on paragraphs. Existing style ids are listed by list_styles / in the tool output.',
  inputSchema: {
    type: 'object',
    properties: {
      styleId: {
        type: 'string',
        description: 'style id (letters, digits, - and _; e.g. "Heading1", "Quote", "MyCallout")',
      },
      name: { type: 'string', description: 'display name (defaults to the id when creating)' },
      type: {
        type: 'string',
        enum: [...STYLE_TYPES],
        description: 'when creating (default paragraph); an existing style keeps its type',
      },
      basedOn: {
        type: ['string', 'null'],
        description: 'parent style id to inherit from; null removes the inheritance',
      },
      next: {
        type: ['string', 'null'],
        description:
          'style of the paragraph created by Enter at the end of a paragraph in this style',
      },
      quickFormat: { type: 'boolean', description: 'show in the quick style gallery' },
      paragraph: {
        type: 'object',
        description: 'paragraph formatting (paragraph and table styles)',
        properties: {
          align: { type: ['string', 'null'], enum: [...ALIGNS, null] },
          spaceBefore: {
            type: ['number', 'string', 'null'],
            description: `space before, ${LENGTH_DESC}`,
          },
          spaceAfter: {
            type: ['number', 'string', 'null'],
            description: `space after, ${LENGTH_DESC}`,
          },
          lineSpacing: {
            type: ['number', 'null'],
            description: 'line spacing as a multiple of single (1, 1.15, 1.5, 2)',
          },
          indentLeft: { type: ['number', 'string', 'null'], description: LENGTH_DESC },
          indentRight: { type: ['number', 'string', 'null'], description: LENGTH_DESC },
          firstLineIndent: {
            type: ['number', 'string', 'null'],
            description: `first-line indent, negative = hanging indent, ${LENGTH_DESC}`,
          },
          keepNext: { type: 'boolean', description: 'keep with next paragraph' },
          keepLines: { type: 'boolean', description: 'keep lines together' },
          pageBreakBefore: { type: 'boolean' },
          outlineLevel: {
            type: ['integer', 'null'],
            description:
              '1-9: the style becomes a heading of that level in the navigation pane / TOC',
          },
          tabs: {
            type: ['array', 'null'],
            description:
              'tab stops of the style (replaces its w:tabs; [] or null removes them): [{ pos: twips or "6.5in", align?: left|center|right|decimal|bar, leader?: none|dot|hyphen|underscore|middleDot, clear?: true }]',
            items: { type: 'object' },
          },
        },
      },
      run: {
        type: 'object',
        description: 'text formatting (all style types)',
        properties: {
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          underline: { type: 'boolean' },
          strike: { type: 'boolean' },
          caps: { type: 'boolean' },
          smallCaps: { type: 'boolean' },
          color: { type: ['string', 'null'], description: '"#RRGGBB" or null to clear' },
          highlight: {
            type: ['string', 'null'],
            description: `highlight color name (${HIGHLIGHTS.slice(0, 6).join(', ')}, ...) or null`,
          },
          fontSize: { type: ['number', 'null'], description: 'points' },
          fontFamily: { type: ['string', 'null'], description: 'Latin font face' },
          eastAsiaFontFamily: { type: ['string', 'null'], description: 'CJK font face' },
        },
      },
    },
    required: ['styleId'],
  },
}

export const LIST_STYLES_TOOL: AgentToolDef = {
  name: 'list_styles',
  description:
    'List the styles defined in the document (id, name, type, parent, heading level) for define_style / applyStyle.',
  inputSchema: { type: 'object', properties: {}, required: [] },
}
