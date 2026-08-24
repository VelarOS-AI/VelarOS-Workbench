import type { IconProps } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { FileTypeIcon } from '@velaros-ai/ui/primitives/display/FileTypeIcon'
import type { LooseOptional } from '@velaros-ai/ui/utility-types'
import { getFilePresentationVariant } from '@velaros-ai/ui/utils/filePresentation'

interface WorkbenchFileTypeIconProps extends Omit<IconProps, 'children'> {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}

/** Workbench 内的紧凑文件图标；VelarScript 与 Phosphor 的 JS / TS 文件图标保持同一造型。 */
export function WorkbenchFileTypeIcon(props: WorkbenchFileTypeIconProps): ReactElement {
  const {
    fileName,
    mediaType,
    size = 14,
    color,
    mirrored = false,
    weight: _weight,
    alt,
    style,
    ...iconProps
  } = props
  if (getFilePresentationVariant({ fileName, mediaType }) !== 'velarscript')
    return <FileTypeIcon {...props} />

  const transform = mirrored
    ? [style?.transform, 'scaleX(-1)'].filter(Boolean).join(' ')
    : style?.transform

  return (
    <svg
      {...iconProps}
      xmlns="http://www.w3.org/2000/svg"
      data-velarscript-mark="vs"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color ?? '#171717'}
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
        style={{ color: color ?? '#171717' }}
      />
    </svg>
  )
}
