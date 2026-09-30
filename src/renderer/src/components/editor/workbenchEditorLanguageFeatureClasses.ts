import type { WorkbenchEditorLanguageFeatureClasses } from '@renderer/models/editor/workbenchCodeMirrorLanguageFeatures'

import styles from '../../styles/workbenchPageStyles'

/** Desktop CSS Module 到 Workbench 编辑器语言浮层样式合同的显式适配。 */
export const workbenchEditorLanguageFeatureClasses: WorkbenchEditorLanguageFeatureClasses = {
  editorSignatureTooltip: styles.editorSignatureTooltip,
  editorSignatureTooltipHost: styles.editorSignatureTooltipHost,
  editorSignatureTooltipParameter: styles.editorSignatureTooltipParameter,
  editorSignatureTooltipSignature: styles.editorSignatureTooltipSignature,
  editorSymbolTooltip: styles.editorSymbolTooltip,
  editorSymbolTooltipAction: styles.editorSymbolTooltipAction,
  editorSymbolTooltipActions: styles.editorSymbolTooltipActions,
  editorSymbolTooltipCode: styles.editorSymbolTooltipCode,
  editorSymbolTooltipDiagnostic: styles.editorSymbolTooltipDiagnostic,
  editorSymbolTooltipDiagnostics: styles.editorSymbolTooltipDiagnostics,
  editorSymbolTooltipDivider: styles.editorSymbolTooltipDivider,
  editorSymbolTooltipDocs: styles.editorSymbolTooltipDocs,
  editorSymbolTooltipDocsParagraph: styles.editorSymbolTooltipDocsParagraph,
  editorSymbolTooltipInlineCode: styles.editorSymbolTooltipInlineCode,
  editorSymbolTooltipLocation: styles.editorSymbolTooltipLocation,
  editorSymbolTooltipLocationLabel: styles.editorSymbolTooltipLocationLabel,
  editorSymbolTooltipSectionLabel: styles.editorSymbolTooltipSectionLabel,
  editorSymbolTooltipPartBuiltinType: styles.editorSymbolTooltipPartBuiltinType,
  editorSymbolTooltipPartFunction: styles.editorSymbolTooltipPartFunction,
  editorSymbolTooltipPartKeyword: styles.editorSymbolTooltipPartKeyword,
  editorSymbolTooltipPartLink: styles.editorSymbolTooltipPartLink,
  editorSymbolTooltipPartLocation: styles.editorSymbolTooltipPartLocation,
  editorSymbolTooltipPartName: styles.editorSymbolTooltipPartName,
  editorSymbolTooltipPartNumber: styles.editorSymbolTooltipPartNumber,
  editorSymbolTooltipPartOperator: styles.editorSymbolTooltipPartOperator,
  editorSymbolTooltipPartPlain: styles.editorSymbolTooltipPartPlain,
  editorSymbolTooltipPartPunctuation: styles.editorSymbolTooltipPartPunctuation,
  editorSymbolTooltipPartString: styles.editorSymbolTooltipPartString,
  editorSymbolTooltipPartType: styles.editorSymbolTooltipPartType,
  editorSymbolTooltipTitle: styles.editorSymbolTooltipTitle,
}
