/** Reusable resource operations without the Agent loop or model transports. */
export { composeSkills } from './skill'
export { ResourceAccessError } from './resource-access'
export { createAttachmentsSkill, READ_ATTACHMENT_TOOL_DEF } from './attachments-skill'
export type { AttachmentsSkillDeps } from './attachments-skill'
export {
  createKnowledgeBaseSkill,
  READ_KNOWLEDGE_FILE_TOOL,
  SEARCH_KNOWLEDGE_BASE_TOOL,
} from './knowledge-base-skill'
export type { KnowledgeBaseDeps } from './knowledge-base-skill'
