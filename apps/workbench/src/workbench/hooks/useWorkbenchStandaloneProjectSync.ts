import { useEffect, useRef } from 'react'

import type { WorkbenchProject } from '../models/project/workbenchProjects'

interface UseWorkbenchStandaloneProjectSyncOptions {
  activeProject: Nullable<WorkbenchProject>
  lockedProjectId: Nullable<string>
  projects: WorkbenchProject[]
  standalone: boolean
  updateDocumentTitle?: boolean
  onOpenProject: (project: WorkbenchProject) => Promise<unknown>
}

export function useWorkbenchStandaloneProjectSync({
  activeProject,
  lockedProjectId,
  projects,
  standalone,
  updateDocumentTitle = true,
  onOpenProject,
}: UseWorkbenchStandaloneProjectSyncOptions): void {
  const lockedProjectOpenAttemptRef = useRef<string>(null)
  const projectsRef = useRef(projects)
  const onOpenProjectRef = useRef(onOpenProject)
  projectsRef.current = projects
  onOpenProjectRef.current = onOpenProject

  useEffect(() => {
    if (standalone && lockedProjectId) return

    lockedProjectOpenAttemptRef.current = null
  }, [lockedProjectId, standalone])

  useEffect(() => {
    if (!standalone || !lockedProjectId) return

    const lockedProject = projectsRef.current.find((project) => project.id === lockedProjectId)
    if (!lockedProject || lockedProjectOpenAttemptRef.current === lockedProjectId) return

    lockedProjectOpenAttemptRef.current = lockedProjectId
    void onOpenProjectRef.current(lockedProject)
  }, [lockedProjectId, standalone])

  useEffect(() => {
    if (!standalone || !updateDocumentTitle || !activeProject) return

    document.title = activeProject.name
  }, [activeProject, standalone, updateDocumentTitle])
}
