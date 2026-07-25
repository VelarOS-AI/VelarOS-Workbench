import { type ReactElement } from 'react'
import { InfoIcon, WarningCircleIcon } from '@phosphor-icons/react'

export type WorkbenchProblemSeverityIconKind = 'error' | 'warning' | 'hint'

interface WorkbenchProblemSeverityIconProps {
  kind: WorkbenchProblemSeverityIconKind
  size?: number
  className?: string
}

function ProblemErrorIcon({
  size,
  className,
}: Pick<WorkbenchProblemSeverityIconProps, 'size' | 'className'>): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden
      focusable="false"
    >
      <circle cx="8" cy="8" r="7" fill="var(--status-red)" />
      <rect x="7.25" y="3.75" width="1.5" height="5.75" rx="0.75" fill="white" />
      <circle cx="8" cy="11.75" r="1" fill="white" />
    </svg>
  )
}

export function WorkbenchProblemSeverityIcon({
  kind,
  size = 12,
  className,
}: WorkbenchProblemSeverityIconProps): ReactElement {
  switch (kind) {
    case 'error': {
      return <ProblemErrorIcon size={size} className={className} />
    }
    case 'warning': {
      return <WarningCircleIcon size={size} weight="fill" className={className} aria-hidden />
    }
    default: {
      return <InfoIcon size={size} weight="fill" className={className} aria-hidden />
    }
  }
}
