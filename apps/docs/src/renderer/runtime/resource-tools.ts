import {
  composeSkills,
  createAttachmentsSkill,
  createKnowledgeBaseSkill,
  type AttachmentsSkillDeps,
  type KnowledgeBaseDeps,
} from '@genoffice/agent-core/resource-tools'
import type { UserCliRun } from '../../shared/ipc'
import { createOfficeCliTools } from './cli-resource-tools'

export interface DocsResourceOptions {
  attachments?: AttachmentsSkillDeps
  knowledge?: KnowledgeBaseDeps
  /** The host executes only its bundled, bounded Office CLI under its file grants. */
  runCli?(args: string[], signal?: AbortSignal): Promise<UserCliRun>
}

/** The same attachment/knowledge executors as native mode, with host-owned resource grants. */
export function createDocsResourceTools(options: DocsResourceOptions) {
  return composeSkills('docs-resources', '', [
    ...(options.attachments ? [createAttachmentsSkill(options.attachments)] : []),
    ...(options.knowledge ? [createKnowledgeBaseSkill(options.knowledge)] : []),
    ...(options.runCli
      ? [{ id: 'office-cli', systemPrompt: '', ...createOfficeCliTools(options.runCli) }]
      : []),
  ])
}
