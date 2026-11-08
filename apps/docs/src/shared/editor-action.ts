/** An editor action handed to an external Harness; it is not a model inference API. */
export interface DocsEditorAction {
  id: string
  bindingId: string
  documentId: string
  kind: 'ask' | 'edit' | 'name_document'
  /** Preserve the user's instruction or configured action prompt verbatim. */
  instruction: string
  /** The editor's projected context; AI-withheld content is excluded. */
  context: string
}

export interface DocsHarnessAdapter {
  /** Focus the external conversation for ask, or submit an action through supported Harness facilities. */
  submit(action: DocsEditorAction): Promise<void>
}
