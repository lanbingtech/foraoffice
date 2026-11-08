export const DOCS_HARNESS_WORKFLOWS = [
  {
    nativeTool: 'web_search',
    editorTools: [],
    description:
      'Search using the Harness, then supply verified results to ordinary document editing tools.',
  },
  {
    nativeTool: 'image_search',
    editorTools: ['insert_image'],
    description:
      'Search using the Harness, then insert the selected direct image URL through insert_image.',
  },
  {
    nativeTool: 'generate_image',
    editorTools: ['insert_image', 'insert_picture'],
    description:
      'Generate in the Harness. Supply the image through a host-authorized image input; use insert_image for direct image URLs or insert_picture for embedded floating pictures.',
  },
  {
    nativeTool: 'analyze_media',
    editorTools: ['read_document_media'],
    description:
      'Obtain an authorized document image using read_document_media and analyze its standard MCP image content in the Harness. User-supplied image/audio/video inputs remain owned by the Harness.',
  },
  {
    nativeTool: 'write_document',
    editorTools: [
      'start_document_draft',
      'update_document_draft',
      'inspect_document_draft',
      'stop_document_draft',
      'finish_document_draft',
    ],
    description:
      'Plan and generate in the Harness. Stream cumulative restricted HTML using increasing update sequences, then explicitly finalize, retain partial content, or discard the draft.',
  },
] as const
