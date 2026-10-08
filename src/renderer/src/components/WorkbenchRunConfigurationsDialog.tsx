/**
 * 「编辑运行配置」对话框：左边是这个项目里用户建的配置（新建、复制、删除），右边改选中那一份的名称、种类
 * （一条命令，或者一个 Node 程序的脚本与参数）、工作目录与环境变量。改动先留在对话框里，点「保存」才整份写进
 * 应用存储；取消或关掉就都不算数。
 *
 * 只在打开时加载（见页面里的 lazy），不进工作区外壳包。
 */
import { type ReactElement, useEffect, useId, useMemo, useState } from 'react'
import { CopyIcon, PlusIcon, TrashIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import type { WorkbenchNamedRunConfiguration } from '@renderer/models/commands/workbenchNamedRunConfigurations'
import {
  buildWorkbenchRunConfigurationFromDraft,
  createWorkbenchRunConfigurationDraft,
  duplicateWorkbenchRunConfigurationDraft,
  toWorkbenchRunConfigurationDraft,
  uniqueWorkbenchRunConfigurationName,
  validateWorkbenchRunConfigurationDraft,
  type WorkbenchRunConfigurationDraft,
  type WorkbenchRunConfigurationDraftIssues,
  type WorkbenchRunEnvironmentTextIssue,
} from '@renderer/models/commands/workbenchRunConfigurationDrafts'

import { toNullable } from '@velaros-ai/core'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Label } from '@velaros-ai/ui/primitives/display/Label'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { Textarea } from '@velaros-ai/ui/primitives/forms/Textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'

import { WorkbenchRunEnvironmentMaxVariables } from '@shared/workbenchRunEnvironment'

import styles from '../styles/WorkbenchRunConfigurationsDialog.module.css'

export interface WorkbenchRunConfigurationsDialogProps {
  open: boolean
  configurations: readonly WorkbenchNamedRunConfiguration[]
  /** 打开时先选中哪一份（▶ 此刻指着的那份）；不给、或它不在列表里，选第一份。 */
  initialConfigurationId?: Nullable<string>
  onOpenChange: (open: boolean) => void
  onSave: (configurations: WorkbenchNamedRunConfiguration[]) => void
}

export function WorkbenchRunConfigurationsDialog({
  open,
  configurations,
  initialConfigurationId = null,
  onOpenChange,
  onSave,
}: WorkbenchRunConfigurationsDialogProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const [drafts, setDrafts] = useState<WorkbenchRunConfigurationDraft[]>([])
  const [selectedId, setSelectedId] = useState<Nullable<string>>(null)
  /** 点过一次保存之后才把没填好的地方标出来：刚新建的空配置不该一上来就满屏报错。 */
  const [showIssues, setShowIssues] = useState(false)

  // 每次打开都从存着的配置重新开始：上次没保存的改动不留到这一次。只在打开的那一刻取一次——开着的时候
  // 别处存了配置，不把正在改的草稿冲掉。
  useEffect(() => {
    if (!open) return

    const nextDrafts = configurations.map(toWorkbenchRunConfigurationDraft)
    setDrafts(nextDrafts)
    setSelectedId(
      toNullable(
        nextDrafts.find((draft) => draft.id === initialConfigurationId)?.id ?? nextDrafts[0]?.id
      )
    )
    setShowIssues(false)
  }, [open])

  const selected = useMemo(
    () => toNullable(drafts.find((draft) => draft.id === selectedId)),
    [drafts, selectedId]
  )
  const issuesById = useMemo(
    () =>
      new Map(drafts.map((draft) => [draft.id, validateWorkbenchRunConfigurationDraft(draft)])),
    [drafts]
  )

  function addDraft(): void {
    const draft = createWorkbenchRunConfigurationDraft(
      uniqueWorkbenchRunConfigurationName(
        t('workbench.runConfigurationNewName'),
        drafts.map((item) => item.name)
      )
    )
    setDrafts((current) => [...current, draft])
    setSelectedId(draft.id)
  }

  function duplicateSelected(): void {
    if (!selected) return

    const copy = duplicateWorkbenchRunConfigurationDraft(
      selected,
      uniqueWorkbenchRunConfigurationName(
        t('workbench.runConfigurationCopyName', { name: selected.name.trim() }),
        drafts.map((item) => item.name)
      )
    )
    setDrafts((current) => {
      const index = current.findIndex((draft) => draft.id === selected.id)
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)]
    })
    setSelectedId(copy.id)
  }

  function deleteSelected(): void {
    if (!selected) return

    const index = drafts.findIndex((draft) => draft.id === selected.id)
    const next = drafts.filter((draft) => draft.id !== selected.id)
    setDrafts(next)
    // 选中补到原来位置上的那一份；删的是最后一份就选它前面那份。
    setSelectedId(toNullable((next[index] ?? next[index - 1])?.id))
  }

  function save(): void {
    const firstInvalid = drafts.find((draft) => issuesById.get(draft.id))
    if (firstInvalid) {
      setShowIssues(true)
      setSelectedId(firstInvalid.id)
      return
    }

    onSave(
      drafts.flatMap((draft) => {
        const configuration = buildWorkbenchRunConfigurationFromDraft(draft)
        return configuration ? [configuration] : []
      })
    )
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>{t('workbench.runConfigurationsDialogTitle')}</DialogTitle>
          <DialogDescription>{t('workbench.runConfigurationsDialogDescription')}</DialogDescription>
        </DialogHeader>
        <div className={styles.body}>
          <div className={styles.sidebar}>
            <div className={styles.sidebarActions}>
              <IconButton
                size="icon-sm"
                label={t('workbench.runConfigurationAdd')}
                onClick={addDraft}
              >
                <PlusIcon size={14} />
              </IconButton>
              <IconButton
                size="icon-sm"
                label={t('workbench.runConfigurationDuplicate')}
                disabled={!selected}
                onClick={duplicateSelected}
              >
                <CopyIcon size={14} />
              </IconButton>
              <IconButton
                size="icon-sm"
                label={t('workbench.runConfigurationDelete')}
                disabled={!selected}
                onClick={deleteSelected}
              >
                <TrashIcon size={14} />
              </IconButton>
            </div>
            <div className={styles.list} role="listbox" aria-label={t('workbench.runConfigurations')}>
              {drafts.map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  role="option"
                  aria-selected={draft.id === selectedId}
                  className={styles.listItem}
                  data-active={draft.id === selectedId}
                  data-invalid={showIssues && !!issuesById.get(draft.id)}
                  title={draft.name}
                  onClick={() => setSelectedId(draft.id)}
                >
                  {draft.name.trim() || t('workbench.runConfigurationNewName')}
                </button>
              ))}
            </div>
          </div>
          {selected ? (
            <WorkbenchRunConfigurationForm
              // 换一份配置就重新挂表单：焦点回到名称框，上一份输入框里的撤销记录不带过来。
              key={selected.id}
              draft={selected}
              issues={showIssues ? toNullable(issuesById.get(selected.id)) : null}
              onChange={(patch) =>
                setDrafts((current) =>
                  current.map((draft) => (draft.id === selected.id ? { ...draft, ...patch } : draft))
                )
              }
            />
          ) : (
            <div className={styles.empty}>
              <Text tone="secondary">{t('workbench.runConfigurationsEmpty')}</Text>
              <Button variant="outline" size="sm" onClick={addDraft}>
                {t('workbench.runConfigurationAdd')}
              </Button>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={save}>{t('workbench.runConfigureSave')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface WorkbenchRunConfigurationFormProps {
  draft: WorkbenchRunConfigurationDraft
  /** 要标出来的问题；null 是不标（还没点过保存，或者这一份没问题）。 */
  issues: Nullable<WorkbenchRunConfigurationDraftIssues>
  onChange: (patch: Partial<WorkbenchRunConfigurationDraft>) => void
}

/**
 * 一份运行配置的表单：名称、种类、命令（或 Node 程序的脚本与参数）、工作目录、环境变量，没填好的地方在字段
 * 下面写明。
 */
export function WorkbenchRunConfigurationForm({
  draft,
  issues,
  onChange,
}: WorkbenchRunConfigurationFormProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const fieldId = useId()

  function describeEnvironmentIssue(issue: WorkbenchRunEnvironmentTextIssue): string {
    switch (issue.reason) {
      case 'too-many':
        return t('workbench.runConfigurationEnvTooMany', {
          count: WorkbenchRunEnvironmentMaxVariables,
        })
      case 'invalid-name':
        return t('workbench.runConfigurationEnvInvalidName', {
          line: issue.line,
          text: issue.text,
        })
      default:
        return t('workbench.runConfigurationEnvInvalidLine', { line: issue.line, text: issue.text })
    }
  }

  return (
    <div className={styles.form}>
      <div className={styles.field}>
        <Label htmlFor={`${fieldId}-name`}>{t('workbench.runConfigurationName')}</Label>
        <Input
          id={`${fieldId}-name`}
          size="sm"
          value={draft.name}
          maxLength={80}
          autoFocus
          spellCheck={false}
          aria-invalid={!!issues?.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        {!!issues?.name && (
          <Text tone="caption" className={styles.issue}>
            {t('workbench.runConfigurationNameRequired')}
          </Text>
        )}
      </div>
      <div className={styles.field}>
        <Label>{t('workbench.runConfigurationType')}</Label>
        <SegmentedControl
          ariaLabel={t('workbench.runConfigurationType')}
          className={styles.type}
          value={draft.type}
          options={[
            { value: 'command', label: t('workbench.runConfigurationTypeCommand') },
            { value: 'node', label: t('workbench.runConfigurationTypeNode') },
          ]}
          onChange={(type) => onChange({ type })}
        />
      </div>
      {draft.type === 'node' ? (
        <>
          <div className={styles.field}>
            <Label htmlFor={`${fieldId}-script`}>{t('workbench.runConfigurationScript')}</Label>
            <Input
              id={`${fieldId}-script`}
              size="sm"
              className={styles.mono}
              value={draft.script}
              maxLength={1000}
              placeholder="src/server.js"
              spellCheck={false}
              aria-invalid={!!issues?.script}
              onChange={(event) => onChange({ script: event.target.value })}
            />
            <Text tone="caption" className={issues?.script ? styles.issue : styles.hint}>
              {issues?.script === 'required'
                ? t('workbench.runConfigurationScriptRequired')
                : issues?.script
                  ? t('workbench.runConfigurationScriptOutsideProject')
                  : t('workbench.runConfigurationScriptHint')}
            </Text>
          </div>
          <div className={styles.field}>
            <Label htmlFor={`${fieldId}-args`}>{t('workbench.runConfigurationArgs')}</Label>
            <Input
              id={`${fieldId}-args`}
              size="sm"
              className={styles.mono}
              value={draft.args}
              maxLength={8000}
              placeholder="--port 3000"
              spellCheck={false}
              onChange={(event) => onChange({ args: event.target.value })}
            />
          </div>
        </>
      ) : (
        <div className={styles.field}>
          <Label htmlFor={`${fieldId}-command`}>{t('workbench.runConfigurationCommand')}</Label>
          <Input
            id={`${fieldId}-command`}
            size="sm"
            className={styles.mono}
            value={draft.command}
            maxLength={8000}
            placeholder={t('workbench.runConfigureCommandPlaceholder')}
            spellCheck={false}
            aria-invalid={!!issues?.command}
            onChange={(event) => onChange({ command: event.target.value })}
          />
          {!!issues?.command && (
            <Text tone="caption" className={styles.issue}>
              {t('workbench.runConfigurationCommandRequired')}
            </Text>
          )}
        </div>
      )}
      <div className={styles.field}>
        <Label htmlFor={`${fieldId}-cwd`}>{t('workbench.runConfigurationCwd')}</Label>
        <Input
          id={`${fieldId}-cwd`}
          size="sm"
          className={styles.mono}
          value={draft.cwd}
          maxLength={1000}
          placeholder={t('workbench.runConfigurationCwdPlaceholder')}
          spellCheck={false}
          aria-invalid={!!issues?.cwd}
          onChange={(event) => onChange({ cwd: event.target.value })}
        />
        <Text tone="caption" className={issues?.cwd ? styles.issue : styles.hint}>
          {issues?.cwd
            ? t('workbench.runConfigurationCwdOutsideProject')
            : t('workbench.runConfigurationCwdHint')}
        </Text>
      </div>
      <div className={styles.field}>
        <Label htmlFor={`${fieldId}-env`}>{t('workbench.runConfigurationEnv')}</Label>
        <Textarea
          id={`${fieldId}-env`}
          size="sm"
          className={`${styles.mono} ${styles.environment}`}
          value={draft.envText}
          placeholder={t('workbench.runConfigurationEnvPlaceholder')}
          spellCheck={false}
          aria-invalid={!!issues?.env}
          onChange={(event) => onChange({ envText: event.target.value })}
        />
        {issues?.env ? (
          // 最多写三条：贴进来一大段不是 KEY=VALUE 的东西时，不把对话框撑满。
          issues.env.slice(0, 3).map((issue) => (
            <Text key={issue.line} tone="caption" className={styles.issue}>
              {describeEnvironmentIssue(issue)}
            </Text>
          ))
        ) : (
          <Text tone="caption" className={styles.hint}>
            {t('workbench.runConfigurationEnvHint')}
          </Text>
        )}
      </div>
    </div>
  )
}
