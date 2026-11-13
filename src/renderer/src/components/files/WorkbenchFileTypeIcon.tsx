import {
  BracketsCurlyIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileCssIcon,
  FileCsvIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileIcon,
  FileImageIcon,
  FileIniIcon,
  FileLockIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileSqlIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  GitDiffIcon,
  type Icon,
  type IconProps,
  ProhibitIcon,
} from '@phosphor-icons/react'
import {
  resolveWorkbenchFilePresentation,
  type WorkbenchBuiltinFilePresentationVariant,
} from '@renderer/models/files/workbenchFilePresentation'
import BashPlain from 'devicons-react/icons/BashPlain'
import COriginal from 'devicons-react/icons/COriginal'
import CplusplusPlain from 'devicons-react/icons/CplusplusPlain'
import CsharpPlain from 'devicons-react/icons/CsharpPlain'
import Css3Plain from 'devicons-react/icons/Css3Plain'
import DartPlain from 'devicons-react/icons/DartPlain'
import GoPlain from 'devicons-react/icons/GoPlain'
import Html5Plain from 'devicons-react/icons/Html5Plain'
import JavaPlain from 'devicons-react/icons/JavaPlain'
import JavascriptPlain from 'devicons-react/icons/JavascriptPlain'
import JsonPlain from 'devicons-react/icons/JsonPlain'
import KotlinPlain from 'devicons-react/icons/KotlinPlain'
import LessPlainWordmark from 'devicons-react/icons/LessPlainWordmark'
import MarkdownOriginal from 'devicons-react/icons/MarkdownOriginal'
import OpenglPlain from 'devicons-react/icons/OpenglPlain'
import PythonPlain from 'devicons-react/icons/PythonPlain'
import ReactOriginal from 'devicons-react/icons/ReactOriginal'
import RustOriginal from 'devicons-react/icons/RustOriginal'
import SassOriginal from 'devicons-react/icons/SassOriginal'
import SwiftPlain from 'devicons-react/icons/SwiftPlain'
import TypescriptPlain from 'devicons-react/icons/TypescriptPlain'
import VuejsPlain from 'devicons-react/icons/VuejsPlain'
import WasmOriginal from 'devicons-react/icons/WasmOriginal'
import type { ReactElement } from 'react'

import type { LooseOptional } from '@velaros-ai/ui/utility-types'

interface WorkbenchFileTypeIconProps extends Omit<IconProps, 'children'> {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}

const BuiltinFileIcons: Partial<Record<WorkbenchBuiltinFilePresentationVariant, Icon>> = {
  archive: FileArchiveIcon,
  audio: FileAudioIcon,
  code: FileCodeIcon,
  config: FileIniIcon,
  css: FileCssIcon,
  csv: FileCsvIcon,
  document: FileDocIcon,
  generic: FileIcon,
  gitignore: ProhibitIcon,
  image: FileImageIcon,
  json: BracketsCurlyIcon,
  less: FileCssIcon,
  lock: FileLockIcon,
  markdown: FileMdIcon,
  patch: GitDiffIcon,
  pdf: FilePdfIcon,
  presentation: FilePptIcon,
  sass: FileCssIcon,
  scss: FileCssIcon,
  spreadsheet: FileXlsIcon,
  text: FileTextIcon,
  video: FileVideoIcon,
  html: FileHtmlIcon,
  sql: FileSqlIcon,
}

/** Devicon language marks, imported individually so unused logos never enter the bundle. */
const BuiltinLanguageIcons: Partial<
  Record<WorkbenchBuiltinFilePresentationVariant, typeof VuejsPlain>
> = {
  c: COriginal,
  cpp: CplusplusPlain,
  csharp: CsharpPlain,
  css: Css3Plain,
  dart: DartPlain,
  glsl: OpenglPlain,
  go: GoPlain,
  html: Html5Plain,
  java: JavaPlain,
  javascript: JavascriptPlain,
  json: JsonPlain,
  jsx: ReactOriginal,
  kotlin: KotlinPlain,
  less: LessPlainWordmark,
  markdown: MarkdownOriginal,
  python: PythonPlain,
  rust: RustOriginal,
  sass: SassOriginal,
  scss: SassOriginal,
  shell: BashPlain,
  swift: SwiftPlain,
  tsx: ReactOriginal,
  typescript: TypescriptPlain,
  vue: VuejsPlain,
  webassembly: WasmOriginal,
}

const BuiltinFileIconColors: Partial<Record<WorkbenchBuiltinFilePresentationVariant, string>> = {
  c: 'var(--workbench-file-c)',
  cpp: 'var(--workbench-file-cpp)',
  csharp: 'var(--workbench-file-csharp)',
  dart: 'var(--workbench-file-dart)',
  glsl: 'var(--workbench-file-glsl)',
  go: 'var(--workbench-file-go)',
  html: 'var(--workbench-file-html)',
  java: 'var(--workbench-file-java)',
  kotlin: 'var(--workbench-file-kotlin)',
  python: 'var(--workbench-file-python)',
  rust: 'var(--workbench-file-rust)',
  shell: 'var(--workbench-file-shell)',
  sql: 'var(--workbench-file-sql)',
  swift: 'var(--workbench-file-swift)',
  vue: 'var(--workbench-file-vue)',
  webassembly: 'var(--workbench-file-webassembly)',
  config: 'var(--workbench-file-config)',
  css: 'var(--workbench-file-css)',
  gitignore: 'var(--workbench-text-muted)',
  javascript: 'var(--workbench-file-javascript)',
  json: 'var(--workbench-file-json)',
  jsx: 'var(--workbench-file-jsx)',
  less: 'var(--workbench-file-less)',
  lock: 'var(--workbench-file-lock)',
  markdown: 'var(--workbench-file-markdown)',
  patch: 'var(--workbench-file-patch)',
  sass: 'var(--workbench-file-scss)',
  scss: 'var(--workbench-file-scss)',
  tsx: 'var(--workbench-file-tsx)',
  typescript: 'var(--workbench-file-typescript)',
  velarscript: 'var(--workbench-file-velarscript)',
  yaml: 'var(--workbench-file-yaml)',
}

/** One resolver supplies standard language marks and generic file icons across the workbench. */
export function WorkbenchFileTypeIcon(props: WorkbenchFileTypeIconProps): ReactElement {
  const {
    fileName,
    mediaType,
    size = 14,
    color,
    mirrored = false,
    weight = 'regular',
    alt,
    style,
    ...iconProps
  } = props
  const presentation = resolveWorkbenchFilePresentation({ fileName, mediaType })
  const builtinVariant = presentation.variant as WorkbenchBuiltinFilePresentationVariant
  const iconColor =
    color ??
    (presentation.icon
      ? presentation.color
      : (BuiltinFileIconColors[builtinVariant] ?? presentation.color))
  const transform = mirrored
    ? [style?.transform, 'scaleX(-1)'].filter(Boolean).join(' ')
    : style?.transform
  const LanguageIcon = BuiltinLanguageIcons[builtinVariant]

  if (LanguageIcon && !presentation.icon)
    return (
      <LanguageIcon
        {...iconProps}
        data-file-icon-kind={presentation.variant}
        data-language-logo="devicon"
        data-monochrome={
          builtinVariant === 'c' ||
          builtinVariant === 'jsx' ||
          builtinVariant === 'tsx' ||
          builtinVariant === 'sass' ||
          builtinVariant === 'scss'
            ? true
            : undefined
        }
        size={size}
        color={iconColor}
        aria-label={iconProps['aria-label'] ?? alt}
        aria-hidden={iconProps['aria-label'] || alt ? undefined : true}
        style={{
          ...style,
          fill: iconColor,
          color: iconColor,
          ...(transform ? { transform, transformOrigin: 'center' } : {}),
        }}
      />
    )

  if (presentation.variant !== 'velarscript' && presentation.variant !== 'yaml') {
    const IconComponent = presentation.icon ?? BuiltinFileIcons[builtinVariant] ?? FileCodeIcon
    return (
      <IconComponent
        {...iconProps}
        data-file-icon-kind={presentation.variant}
        size={size}
        color={iconColor ?? 'currentColor'}
        mirrored={mirrored}
        weight={weight}
        style={style}
      />
    )
  }

  if (presentation.variant === 'yaml')
    return (
      <svg
        {...iconProps}
        xmlns="http://www.w3.org/2000/svg"
        data-yaml-mark="yml"
        data-file-icon-kind="yaml"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill={iconColor ?? 'currentColor'}
        aria-hidden={iconProps['aria-label'] ? undefined : true}
        style={transform ? { ...style, transform, transformOrigin: 'center' } : style}
      >
        {alt && <title>{alt}</title>}
        <path d="M208 88h-56V32Z" opacity="0.2" />
        <path d="M213.66 82.34l-56-56A8 8 0 0 0 152 24H56a16 16 0 0 0-16 16v72a8 8 0 0 0 16 0V40h88v48a8 8 0 0 0 8 8h48v120h-16a8 8 0 0 0 0 16h16a16 16 0 0 0 16-16V88a8 8 0 0 0-2.34-5.66ZM160 51.31 188.69 80H160Z" />
        <path
          d="m28 152 22 28 22-28M50 180v28M90 208v-56l24 32 24-32v56m24-56v56h38"
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: iconColor ?? 'currentColor' }}
        />
      </svg>
    )

  return (
    <svg
      {...iconProps}
      xmlns="http://www.w3.org/2000/svg"
      data-velarscript-mark="vs"
      data-file-icon-kind="velarscript"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={iconColor ?? '#171717'}
      aria-hidden={iconProps['aria-label'] ? undefined : true}
      style={transform ? { ...style, transform, transformOrigin: 'center' } : style}
    >
      {alt && <title>{alt}</title>}
      <path d="M208 88h-56V32Z" opacity="0.2" />
      <path d="M213.66 82.34l-56-56A8 8 0 0 0 152 24H56a16 16 0 0 0-16 16v72a8 8 0 0 0 16 0V40h88v48a8 8 0 0 0 8 8h48v120h-24a8 8 0 0 0 0 16h24a16 16 0 0 0 16-16V88a8 8 0 0 0-2.34-5.66ZM160 51.31 188.69 80H160Z" />
      <path d="M147.81 196.31a20.82 20.82 0 0 1-9.19 15.23C133.43 215 127 216 121.13 216a61.14 61.14 0 0 1-15.13-2 8 8 0 1 1 4.3-15.41c4.38 1.2 15 2.7 19.55-.36.88-.59 1.83-1.52 2.14-3.93.35-2.67-.71-4.1-12.78-7.59-9.35-2.7-25-7.23-23-23.11a20.56 20.56 0 0 1 9-14.95c11.84-8 30.71-3.31 32.83-2.76a8 8 0 0 1-4.07 15.48c-4.49-1.17-15.23-2.56-19.83.56a4.54 4.54 0 0 0-2 3.67c-.12.9-.14 1.09 1.11 1.9 2.31 1.49 6.45 2.68 10.45 3.84 9.79 2.83 26.35 7.66 24.11 23.97Z" />
      <path
        d="m36 152 24 56 24-56"
        fill="none"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ color: iconColor ?? '#171717' }}
      />
    </svg>
  )
}
