import { javaLanguage } from '@codemirror/lang-java'
import { delimitedIndent, foldInside, foldNodeProp, indentNodeProp } from '@codemirror/language'
import { styleTags, tags } from '@lezer/highlight'

export const workbenchJavaLanguage = javaLanguage.configure({
  props: [
    styleTags({
      'record permits': tags.definitionKeyword,
      'sealed Modifiers/non': tags.modifier,
      'Annotation/Identifier Annotation/ScopedIdentifier! MarkerAnnotation!': tags.annotation,
      'ClassDeclaration/Definition InterfaceDeclaration/Definition EnumDeclaration/Definition RecordDeclaration/Definition AnnotationTypeDeclaration/Identifier':
        tags.definition(tags.className),
      'MethodDeclaration/Definition ConstructorDeclaration/Definition CompactConstructorDeclaration/Definition AnnotationTypeElementDeclaration/Identifier':
        tags.definition(tags.function(tags.variableName)),
      'FieldDeclaration/VariableDeclarator/Definition ConstantDeclaration/VariableDeclarator/Definition EnumConstant/Definition RecordComponent/Definition':
        tags.definition(tags.propertyName),
      'TypeParameter/Definition': tags.definition(tags.typeName),
      'PackageDeclaration/ScopedIdentifier! PackageDeclaration/Identifier': tags.namespace,
      'ElementValuePair/Identifier': tags.propertyName,
    }),
    indentNodeProp.add({ 'RecordBody AnnotationTypeBody': delimitedIndent({ closing: '}' }) }),
    foldNodeProp.add({ 'RecordBody AnnotationTypeBody': foldInside }),
  ],
})
