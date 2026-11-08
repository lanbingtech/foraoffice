import type { AgentToolDef } from '@genoffice/agent-core'

export const NATIVE_DOCS_WORKFLOW_TOOLS: AgentToolDef[] = [
  {
    name: 'write_document',
    description:
      '[For long new content: a whole document, a chapter, a full report, article or translation] Hands the writing to the system writer, which streams restricted HTML straight into the document while the user watches; you never write the text yourself. Give a concrete plan (title, section outline with the key points of each, tone, target length) and put every fact, figure, name and quote the text must use into context — the writer sees only the plan and context, not the conversation. Omit afterBlockIndex on a blank document; on a document with content, pass afterBlockIndex to insert after that block, or replaceDocument=true when the user asked to rewrite everything. Short additions (a paragraph or two) use insert_content instead.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'title, section outline with key points per section, tone, target length',
        },
        title: { type: 'string', description: 'document/chapter title, when there is one' },
        context: {
          type: 'string',
          description:
            'reference material: facts, figures, quotes, sources gathered from the conversation, attachments and web_search',
        },
        afterBlockIndex: {
          type: 'integer',
          description:
            'insert after this block index (-1 = document start); omitted = whole document',
        },
        replaceDocument: {
          type: 'boolean',
          description:
            'true replaces all existing content (only when the user asked for a rewrite)',
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for textual information (references/data/facts). Use when you need up-to-date information or are unsure about a fact. Returns titles/links/snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search keywords' },
        maxResults: { type: 'integer', description: 'maximum number of results, default 6' },
      },
      required: ['query'],
    },
  },
  {
    name: 'image_search',
    description:
      'Search for images. Returns a list of image imageUrl entries; after picking one, insert it into the document with insert_image.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'image search keywords (English works better)' },
        maxResults: { type: 'integer', description: 'maximum number of results, default 8' },
      },
      required: ['query'],
    },
  },
  {
    name: 'analyze_media',
    description:
      'Look at a picture that is in the document and answer questions about it, or analyze image/audio/video given by URL or local file path; returns the analysis as text. An image block in the document carries no text of its own — read_blocks cannot tell you what a picture shows, so this is the only way to see it. Pass blockIndex for an image block listed by get_document_context, and/or mediaUrls.',
    inputSchema: {
      type: 'object',
      properties: {
        blockIndex: {
          type: 'integer',
          description:
            'block index of an image block of the document, as listed by get_document_context',
        },
        mediaUrls: {
          type: 'array',
          items: { type: 'string' },
          description:
            'media URLs or local file paths (image/audio/video); optional when blockIndex is given',
        },
        requirements: {
          type: 'string',
          description:
            'analysis requirements (English): what to extract, or the question to answer about the media',
        },
      },
      required: ['requirements'],
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate an illustration with AI from a text prompt and insert it into the document (at the cursor / end of document). For illustration/diagram-style art that image_search cannot find, or when the user asks to generate/draw a picture.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'detailed English description of the image to generate',
        },
        aspectRatio: {
          type: 'string',
          description: 'e.g. "1:1", "16:9", "4:3"; omit for the default',
        },
        maxWidthPx: { type: 'integer', description: 'maximum width (px), default 480' },
      },
      required: ['prompt'],
    },
  },
]
