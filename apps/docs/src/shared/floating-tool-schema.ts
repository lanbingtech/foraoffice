import type { AgentToolDef } from '@genoffice/agent-core'

export const LENGTH_DESC = '"2.54cm", "1in", "72pt", "96px" or a bare number of points'

export const SET_WATERMARK_TOOL: AgentToolDef = {
  name: 'set_watermark',
  description:
    'Set, restyle or remove the page watermark: a gray text like DRAFT or CONFIDENTIAL, or a washed-out picture (a logo), drawn behind the body on every page (written into the page header, where Word shows it in Design > Watermark). Give text or image, not both; text null or image null removes whichever watermark the document has.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: ['string', 'null'], description: 'watermark text; null removes the watermark' },
      fontFamily: { type: 'string', description: 'font face (default the document theme face)' },
      color: { type: 'string', description: '"#RRGGBB" (default silver)' },
      opacity: { type: 'number', description: '0-1 (default 0.5)' },
      diagonal: { type: 'boolean', description: 'diagonal (default) or horizontal layout' },
      bold: { type: 'boolean' },
      italic: { type: 'boolean' },
      image: {
        type: ['string', 'null'],
        description:
          'picture watermark: http(s) or data: URL of a png/jpg/gif, centered behind the body; null removes the watermark',
      },
      scale: {
        type: 'number',
        description:
          'picture size as a percent of its natural size (default: fit the page inside the margins)',
      },
      washout: {
        type: 'boolean',
        description: "fade the picture like Word's washout (default true)",
      },
    },
  },
}

export const ANCHORS = ['paragraph', 'page', 'margin'] as const

export const WRAPS = ['square', 'tight', 'topAndBottom', 'behind', 'inFront'] as const

export const FLOAT_SCHEMA = {
  type: 'object',
  description:
    'omit for an inline picture in its own paragraph; give it to float the picture at a position',
  properties: {
    anchor: {
      type: 'string',
      enum: [...ANCHORS],
      description:
        'what x/y measure from: the anchor paragraph (x from the text column, y from the paragraph top), the page corner, or the margin box corner',
    },
    x: { type: ['number', 'string'], description: `horizontal offset, ${LENGTH_DESC}` },
    y: { type: ['number', 'string'], description: `vertical offset, ${LENGTH_DESC}` },
    wrap: {
      type: 'string',
      enum: [...WRAPS],
      description: 'how body text flows around it (default square)',
    },
  },
  required: ['x', 'y'],
}

export const INSERT_PICTURE_TOOL: AgentToolDef = {
  name: 'insert_picture',
  description:
    'Insert a picture from a direct image link at a block position, at a given size, inline or floating (positioned on the page, with text wrapping around/behind/in front). insert_image is the simpler cursor-position variant.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'direct http(s) image link or PNG/JPEG/GIF base64 data URL (25 MB maximum)',
      },
      afterBlockIndex: {
        type: 'integer',
        description: 'insert after this block (-1 = start of document); default: end of document',
      },
      width: {
        type: ['number', 'string'],
        description: `display width, ${LENGTH_DESC}; default natural size capped at 480px`,
      },
      height: {
        type: ['number', 'string'],
        description: 'display height; omit to keep the aspect ratio',
      },
      float: FLOAT_SCHEMA,
      altText: { type: 'string', description: 'alternative text (accessibility)' },
    },
    required: ['url'],
  },
}

export const INSERT_TEXT_BOX_TOOL: AgentToolDef = {
  name: 'insert_text_box',
  description:
    'Insert a floating text box (a positioned rectangle holding text, like a callout or sidebar) anchored to a block. Body text either flows above/below it or ignores it.',
  inputSchema: {
    type: 'object',
    properties: {
      afterBlockIndex: {
        type: 'integer',
        description: 'anchor after this block (-1 = start of document); default: end of document',
      },
      text: { type: 'string', description: 'box text; \\n separates paragraphs' },
      width: { type: ['number', 'string'], description: `box width, ${LENGTH_DESC}` },
      height: { type: ['number', 'string'], description: `box height, ${LENGTH_DESC}` },
      x: { type: ['number', 'string'], description: `horizontal offset, ${LENGTH_DESC}` },
      y: { type: ['number', 'string'], description: `vertical offset, ${LENGTH_DESC}` },
      anchor: {
        type: 'string',
        enum: ['paragraph', 'page'],
        description: 'offsets measure from the anchor paragraph (default) or the page corner',
      },
      wrap: {
        type: 'string',
        enum: ['topAndBottom', 'none'],
        description:
          'body text resumes below the box (default for paragraph anchors) or ignores it (default for page anchors)',
      },
      fill: {
        type: ['string', 'null'],
        description: '"#RRGGBB" background (default white); null = transparent',
      },
      borderColor: {
        type: ['string', 'null'],
        description: '"#RRGGBB" outline (default black); null = no outline',
      },
      fontSize: {
        type: ['number', 'string'],
        description: 'text size in points (a bare number, or a length like "12pt")',
      },
      align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
      bold: { type: 'boolean' },
      color: { type: 'string', description: '"#RRGGBB" text color' },
    },
    required: ['text', 'width', 'height', 'x', 'y'],
  },
}
