import type { ComponentType } from 'react'
import type { AiPanelProps } from './ai/AiPanel'

/** Optional native conversation UI, supplied by the application composition. */
export interface DocsAgentUi {
  Panel: ComponentType<Omit<AiPanelProps, 'settings'>>
  suggestFileName(input: { content: string }): Promise<string>
}
