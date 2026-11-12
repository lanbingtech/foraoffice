/** Stable built-in editor operations; identifiers never depend on UI language. */
export type DocsAiOperationId =
  | 'proofread_document'
  | 'proofread_selection'
  | 'translate_document'
  | 'translate_selection'
  | 'suggest_synonyms'
  | 'resolve_comments'
  | 'summarize_revisions'
  | 'name_document'
  | 'summarize_document'
  | 'polish_document'
  | 'polish_selection'
  | 'format_document'
  | 'create_mind_map'

export type DocsAiOperation =
  | {
      readonly operationId: 'translate_document' | 'translate_selection'
      readonly parameters: Readonly<{ targetLanguage: string }>
    }
  | {
      readonly operationId: Exclude<DocsAiOperationId, 'translate_document' | 'translate_selection'>
      readonly parameters: Readonly<Record<string, never>>
    }

interface DocsActionBinding {
  id: string
  bindingId: string
  documentId: string
  /** The editor's projected context; AI-withheld content is excluded. */
  context: string
}

/** An editor action handed to an external Harness; it is not a model inference API. */
export type DocsEditorAction = DocsActionBinding & {
  kind: 'ask' | 'edit' | 'name_document'
  /** Preserve the user's instruction or configured action prompt verbatim. */
  instruction: string
} & (DocsAiOperation | { operationId?: undefined; parameters?: undefined })

/** Captured before resolution. Free instructions never enter this callback. */
export type DocsAiInstructionRequest = Readonly<
  DocsActionBinding &
    DocsAiOperation & {
      defaultInstruction: string
    }
>

export interface DocsHarnessAdapter {
  /** Null/undefined/blank use the editor default. Errors refuse submission. */
  resolveInstruction?(
    request: DocsAiInstructionRequest,
    signal: AbortSignal,
  ): string | null | undefined | Promise<string | null | undefined>
  /** Focus the external conversation for ask, or submit an action through supported Harness facilities. */
  submit(action: DocsEditorAction): Promise<void>
}
