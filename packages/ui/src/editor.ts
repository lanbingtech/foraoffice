/** Shared editing UI primitives; Agent providers and model clients are separate exports. */
export {
  applyAiPanelPrefs,
  aiPanelInitiallyOpen,
  rememberAiPanelOpen,
  useAiPanelPrefs,
  useAiSidebarEnabled,
  aiPanelWidthAtPointer,
} from './ai-panel-prefs-store'
export {
  ColorPicker,
  THEME_COLORS,
  THEME_COLOR_SHADES,
  STANDARD_COLORS,
  type ColorPickerProps,
  type ColorPickerStrings,
  type ColorSwatch,
} from './color-picker'
export { installScreenTips } from './screentip'
export {
  installPopoverDismiss,
  useDismissablePopover,
  useEscapeToClose,
  type PopoverDismissOptions,
} from './popover-dismiss'
export { Dropdown, type DropdownOption } from './dropdown'
export {
  useRibbonCollapse,
  RibbonCollapseButton,
  RibbonExpandButton,
  isRibbonCompactShortcut,
  isRibbonToggleShortcut,
  readRibbonCollapsed,
  readRibbonDensity,
  RIBBON_COMPACT_SHORTCUT,
  RIBBON_TOGGLE_SHORTCUT,
  type RibbonCollapse,
  type RibbonCollapseLabels,
  type RibbonDensity,
} from './ribbon-collapse'
export { isSymbolFontFamily } from './symbol-fonts'
export {
  WORDART_PRESETS,
  wordArtSolidColor,
  wordArtStrokePx,
  type WordArtPreset,
} from './wordart-presets'
export {
  SHAPE_GALLERY_GROUPS,
  ShapePreview,
  shapeClipCss,
  shapePreviewBox,
  shapePreviewPath,
  type ShapeGalleryGroup,
  type ShapeGalleryShape,
} from './shape-gallery'
export { ImageViewer, type ImageViewerLabels } from './image-viewer'
export {
  encodeAutoSaveOverride,
  isAutoSaveDefault,
  NO_AUTO_SAVE_DEFAULT,
  resolveAutoSave,
  useAutoSavePref,
  type AutoSaveDefault,
  type AutoSaveDefaultApi,
} from './auto-save-pref'
export {
  NOTCH,
  clampZoom,
  createWheelPager,
  createZoomWheelClassifier,
  notchStep,
  type ZoomWheelIntent,
} from './wheel-zoom'
export { useRedactLabelField } from './use-redact-label'
export { useScrollWindow } from './scroll-window'
