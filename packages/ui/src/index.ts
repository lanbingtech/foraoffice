// Modified for ForaOffice from GenOffice v0.12.852.
export * from './editor'
export { AiPanelSideButton } from './AiPanelSideButton'
export { AiComposer } from './AiComposer'
export { AiQueueStrip } from './AiQueueStrip'
export { useChatRunQueue, type ChatRunQueue, type QueuedChatMessage } from './chat-run-queue'
export { AI_QUEUE_LABELS, type AiQueueStripLabels } from './strings-ai-queue'
export { AI_SKILLS_LABELS, type AiSkillsLabels } from './strings-ai-skills'
export { AiSkillsMenu, AiSkillChips, type AiSkillsMenuEntry } from './AiSkillsMenu'
export { AiUsageChip, addTokenUsage, formatTokenCount, type AiTokenUsageView } from './AiUsageChip'
export { AI_USAGE_LABELS, type AiUsageLabels } from './strings-ai-usage'
export { AiScopeQuote, type AiScopeQuoteData } from './AiScopeQuote'
export {
  AI_CUSTOM_FONT_MAX_PX,
  AI_CUSTOM_FONT_MIN_PX,
  AI_FONT_BASE_PX,
  AI_FONT_SIZES,
  DEFAULT_AI_PANEL_PREFS,
  aiPanelFontPx,
  clampAiCustomFontSize,
  isAiFontSize,
  normalizeAiPanelPrefs,
  type AiFontSize,
  type AiPanelPrefs,
  type AiPanelSide,
} from './ai-panel-prefs'
export {
  SentAttachments,
  truncateCardName,
  formatAttachmentSize,
  AttachmentCardIcon,
  ATTACHMENT_IMAGE_EXTS,
  fileImageIcon,
  fileGeneralIcon,
  fileDocumentIcon,
  type AiAttachmentLike,
} from './ai-attachments'
export {
  AI_PANEL_WIDTH_DEFAULT,
  AI_PANEL_WIDTH_MIN,
  AI_PANEL_WIDTH_MAX,
  maxAiPanelWidth,
  clampAiPanelWidth,
  loadAiPanelWidth,
  saveAiPanelWidth,
} from './ai-panel-width'
export {
  FindPanel,
  type FindFocusRequest,
  type FindPanelStrings,
  type FindTarget,
} from './find-panel'
export { findInText, foldCase, isWordChar, type FindOptions } from './find-text'
export { AiTypingIndicator } from './AiTypingIndicator'
export { IconSend, IconStop, type IconProps } from './icons'
export { Markdown, type MarkdownNav } from './Markdown'
export { FILE_NAV_SCHEME, createFileNav, fileNavHref, parseFileNavHref } from './file-nav'
export { suggestFileName, type SuggestFileNameOptions } from './ai-naming-client'
export {
  BUILTIN_FONT_FAMILIES,
  fontFamiliesFor,
  partitionFontFamilies,
  systemFamiliesBesidesCandidates,
} from './font-list'
export {
  CropDialog,
  CutoutDialog,
  cropEdgeArrowDelta,
  cropEdgeValue,
  cropImagePng,
  DEFAULT_CUTOUT_TOLERANCE,
  nudgeCropEdge,
  CROP_EDGES,
  CROP_EDGE_STEP,
  CROP_EDGE_STEP_COARSE,
  type CropEdge,
  type CropFractions,
  type ImageDialogLabels,
} from './image-dialogs'
export { CROP_EDGE_LABELS } from './strings-crop-edges'
export { trapTab, useModalKeys } from './modal-keys'
export {
  removeBackground,
  sampleBackgroundColors,
  type CutoutResult,
  type PixelImage,
  type RGB,
} from './cutout'
export { AiModelPicker, type AiModelPickerBridge } from './AiModelPicker'
export {
  aiModelPickerGroups,
  aiModelPickerSelection,
  withAiModelSelection,
  type AiModelPickerGroup,
  type AiModelPickerSelection,
} from './ai-model-picker-options'
export { ProviderLogo } from './provider-logos'
export type { RedactLabelField } from './use-redact-label'
