import type {
  WorkbenchDirectoryEntry,
  WorkbenchProjectToolTarget,
} from '@shared/contracts/workbench'

import { buildWorkbenchProcessRunCommand } from './workbenchCommandLines'
import type { WorkbenchCommandSuggestion } from './workbenchCommandSuggestions'
import { normalizeWorkbenchRunConfigurationCwd } from './workbenchNamedRunConfigurations'

type ReadManifest = (path: string) => Promise<string | null>
type LabelTask = (kind: 'build' | 'dev', name: string) => string

function parseXml(content: string): Document | null {
  const document = new DOMParser().parseFromString(content, 'application/xml')
  return document.querySelector('parsererror') ? null : document
}

function readSolutionProjects(path: string, content: string): string[] {
  const paths = path.toLowerCase().endsWith('.slnx')
    ? Array.from(
        parseXml(content)?.querySelectorAll('Project[Path]') ?? [],
        (project) => project.getAttribute('Path') ?? ''
      )
    : Array.from(
        content.matchAll(/^\s*Project\("[^"]+"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+\.csproj)"/gimu),
        (match) => match[1]!
      )
  return paths.flatMap((entry) => {
    const project = normalizeWorkbenchRunConfigurationCwd(entry)
    return project && /\.csproj$/iu.test(project) ? [project] : []
  })
}

function canStartDotnetProject(content: string): boolean {
  const project = parseXml(content)?.documentElement
  if (!project || project.localName !== 'Project') return false
  const sdks = [
    ...(project.getAttribute('Sdk') ?? '').split(';').filter(Boolean),
    ...Array.from(
      project.querySelectorAll('Sdk[Name], Import[Sdk]'),
      (element) => element.getAttribute('Name') ?? element.getAttribute('Sdk') ?? ''
    ),
  ]
  if (!sdks.length) return false
  const outputTypes = Array.from(project.querySelectorAll('OutputType'), (element) =>
    element.textContent.trim()
  ).filter(Boolean)
  if (outputTypes.length)
    return outputTypes.some((outputType) => /^(?:win)?exe$/iu.test(outputType))
  return sdks.some((sdk) => sdk.trim().split('/')[0] === 'Microsoft.NET.Sdk.Web')
}

function readMavenStartArguments(content: string): string[] | null {
  const project = parseXml(content)?.documentElement
  if (
    !project ||
    project.localName !== 'project' ||
    project.querySelector(':scope > packaging')?.textContent.trim() === 'pom'
  )
    return null
  const plugins = Array.from(project.querySelectorAll(':scope > build > plugins > plugin'))
  const plugin = (name: string): Element | undefined =>
    plugins.find(
      (element) => element.querySelector(':scope > artifactId')?.textContent.trim() === name
    )
  if (plugin('spring-boot-maven-plugin')) return ['spring-boot:run']
  const mainClass =
    project.querySelector(':scope > properties > exec\\.mainClass')?.textContent.trim() ||
    plugin('exec-maven-plugin')?.querySelector('mainClass')?.textContent.trim() ||
    plugin('maven-jar-plugin')?.querySelector('manifest > mainClass')?.textContent.trim() ||
    plugin('maven-shade-plugin')?.querySelector('mainClass')?.textContent.trim()
  return mainClass && /^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*$/iu.test(mainClass)
    ? ['compile', 'exec:java', `-Dexec.mainClass=${mainClass}`]
    : null
}

function readGradleStartTask(content: string): 'bootRun' | 'run' | null {
  const source = content.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gmu, '')
  const pluginBlock = source.match(/\bplugins\s*\{([^}]+)\}/u)?.[1] ?? ''
  if (
    /['"]org\.springframework\.boot['"](?![^\r\n]*\bapply\s+false\b)/u.test(pluginBlock) ||
    /\bspringBoot\s*\{/u.test(source)
  )
    return 'bootRun'
  if (
    /\bapplication\s*\{/u.test(source) ||
    /(?:^|[\n;])\s*application\s*(?:$|[\n;])/u.test(pluginBlock) ||
    /\bid\s*\(?\s*['"]application['"](?![^\r\n]*\bapply\s+false\b)/u.test(pluginBlock) ||
    /\bapply\s*\(?\s*plugin\s*[:=]\s*['"]application['"]/u.test(source)
  )
    return 'run'
  return null
}

function readGradleModules(settings: string): string[] {
  const modules = new Set<string>()
  for (const include of settings.matchAll(/^\s*include(?:\s*\(([^)]+)\)|[ \t]+([^\r\n]+))/gmu)) {
    for (const path of (include[1] ?? include[2] ?? '').matchAll(
      /['"]:?([\w.-]+(?::[\w.-]+)*)['"]/gu
    )) {
      const module = path[1]!
      if (module.split(':').every((name) => name !== '.' && name !== '..')) modules.add(module)
    }
  }
  return [...modules]
}

/** Only reads project manifests. Toolchains run when the user chooses a command. */
export async function buildWorkbenchProjectToolSuggestions(
  rootEntries: readonly WorkbenchDirectoryEntry[],
  readManifest: ReadManifest,
  labelTask: LabelTask
): Promise<WorkbenchCommandSuggestion[]> {
  const files = rootEntries
    .filter((entry) => entry.type === 'file' && !entry.symlink)
    .map((entry) => entry.name)
  const solutions = files.filter((file) => /\.slnx?$/iu.test(file))
  const rootProjects = files.filter((file) => /\.csproj$/iu.test(file))
  const projects = new Set(rootProjects)
  for (const path of solutions) {
    const content = await readManifest(path)
    if (content) for (const project of readSolutionProjects(path, content)) projects.add(project)
  }

  const suggestions: WorkbenchCommandSuggestion[] = []
  function add(
    program: WorkbenchProjectToolTarget['program'],
    kind: 'build' | 'dev',
    name: string,
    source: string,
    argv: string[]
  ): void {
    suggestions.push({
      ...buildWorkbenchProcessRunCommand({ kind: 'project-tool', program, argv }),
      kind,
      label: labelTask(kind, name),
      source,
    })
  }

  for (const path of [...solutions, ...rootProjects])
    add('dotnet', 'build', path, path, ['build', `./${path}`])
  for (const path of projects) {
    const content = await readManifest(path)
    if (content && canStartDotnetProject(content))
      add('dotnet', 'dev', path, path, ['run', '--project', `./${path}`])
  }

  if (files.includes('pom.xml')) {
    add('mvn', 'build', 'Maven', 'pom.xml', ['package'])
    const pom = await readManifest('pom.xml')
    const argv = pom && readMavenStartArguments(pom)
    if (argv) add('mvn', 'dev', 'Maven', 'pom.xml', argv)
  }

  const gradleBuild = files.find((file) => file === 'build.gradle' || file === 'build.gradle.kts')
  const gradleSettings = files.find(
    (file) => file === 'settings.gradle' || file === 'settings.gradle.kts'
  )
  const gradleSource = gradleBuild ?? gradleSettings
  if (gradleSource) {
    add('gradle', 'build', 'Gradle', gradleSource, ['build'])
    const content = gradleBuild && (await readManifest(gradleBuild))
    const task = content && readGradleStartTask(content)
    if (task && gradleBuild) add('gradle', 'dev', 'Gradle', gradleBuild, [task])

    const settings = gradleSettings && (await readManifest(gradleSettings))
    for (const module of settings ? readGradleModules(settings) : []) {
      const directory = module.replaceAll(':', '/')
      const file = `${directory}/build.gradle.kts`
      const script = (await readManifest(file)) ?? (await readManifest(`${directory}/build.gradle`))
      const task = script && readGradleStartTask(script)
      if (task) add('gradle', 'dev', `Gradle :${module}`, gradleSource, [`:${module}:${task}`])
    }
  }
  return suggestions
}
