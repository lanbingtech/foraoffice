// Modified for ForaOffice: reliable document targeting and portable inspection.
import type { AgentToolDef } from '@genoffice/agent-core'

/** Runtime lifecycle controls, separate from the pinned native AI tool catalog. */
export const DOCS_RUNTIME_TOOLS: AgentToolDef[] = [
  {
    name: 'read_document_media',
    description:
      'Read an authorized standalone, inline or table-cell image as standard MCP image content. Prefer the revision-bound mediaRef from fresh context/read_blocks; alternatively use blockIndex and imageIndex (required for multiple images). Missing resources, stale references and unsupported targets are distinguished. Internal asset addresses are not exposed.',
    inputSchema: {
      type: 'object',
      properties: {
        mediaRef: {
          type: 'string',
          description: 'Revision-bound reference returned by context/read_blocks.',
        },
        blockIndex: { type: 'integer', minimum: 0 },
        imageIndex: {
          type: 'integer',
          minimum: 0,
          description: 'Zero-based image ordinal within the block.',
        },
      },
      anyOf: [{ required: ['mediaRef'] }, { required: ['blockIndex'] }],
    },
  },
  {
    name: 'get_editor_capabilities',
    description:
      'Discover current document tool availability, restricted HTML rules, and apply_ops operation signatures. In external mode all inference workflows execute in the Harness.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'document_history',
    description:
      'Undo or redo one live-document edit. Refused if this caller has not read the latest document.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['undo', 'redo'] } },
      required: ['action'],
    },
  },
  {
    name: 'start_document_draft',
    description:
      'Start a visible, unaccepted draft. The external Harness supplies cumulative HTML updates; the editor performs no inference.',
    inputSchema: {
      type: 'object',
      properties: {
        afterBlockIndex: {
          type: 'integer',
          description: 'Insert after this block; -1 means the beginning.',
        },
        replaceDocument: {
          type: 'boolean',
          description: 'Replace the complete document after explicit finalization.',
        },
      },
    },
  },
  {
    name: 'update_document_draft',
    description:
      'Update a draft with cumulative restricted HTML and an increasing sequence number. Replays must have identical content.',
    inputSchema: {
      type: 'object',
      properties: {
        draftId: { type: 'string' },
        sequence: { type: 'integer', minimum: 1 },
        html: { type: 'string', maxLength: 200_000 },
      },
      required: ['draftId', 'sequence', 'html'],
    },
  },
  {
    name: 'inspect_document_draft',
    description: 'Read the state and update sequence of a draft owned by this caller.',
    inputSchema: {
      type: 'object',
      properties: { draftId: { type: 'string' } },
      required: ['draftId'],
    },
  },
  {
    name: 'stop_document_draft',
    description:
      'Stop accepting updates and wait for the Harness to finalize, retain partial content, or discard. The draft remains unaccepted.',
    inputSchema: {
      type: 'object',
      properties: { draftId: { type: 'string' } },
      required: ['draftId'],
    },
  },
  {
    name: 'finish_document_draft',
    description:
      'Finalize, retain incomplete content, or discard a stopped or streaming draft. Committed content uses normal tracking and undo.',
    inputSchema: {
      type: 'object',
      properties: {
        draftId: { type: 'string' },
        decision: { type: 'string', enum: ['finalize', 'retain_partial', 'discard'] },
      },
      required: ['draftId', 'decision'],
    },
  },
]

export const DOCS_DRAFT_CONTROLS = new Set([
  'update_document_draft',
  'inspect_document_draft',
  'stop_document_draft',
  'finish_document_draft',
])
