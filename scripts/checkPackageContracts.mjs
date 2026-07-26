import { spawnSync } from 'node:child_process'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDirectory = path.join(repositoryRoot, 'packages/workbench')
const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
const utilityTypeModule = '@velaros-ai/ui/utility-types'
const utilityTypeNames = [
  'JsonStringifyReplacer',
  'JsonStringifyReplacerValue',
  'LooseOptional',
  'Nullable',
  'Nullish',
  'PlainObject',
]
const requiredDocumentSections = [
  '定位与非目标',
  '安装',
  '公共入口',
  '核心类与接口',
  '生命周期/并发',
  '依赖注入',
  '错误模型',
  '最小第三方示例',
  '扩展点',
  '兼容策略',
]

validateMetadataAndDocumentation()
await validateBuiltExportTargets()
await validatePackedConsumer()

console.info(
  'Workbench package contract: metadata, exports, Chinese API docs, tarball, and strict consumer typecheck are valid.'
)

function validateMetadataAndDocumentation() {
  for (const field of ['description', 'license', 'repository']) {
    if (!manifest[field]) throw new Error(`${manifest.name} is missing package.json#${field}`)
  }
  if (!manifest.engines?.node) throw new Error(`${manifest.name} is missing a Node.js engine range`)
  if (manifest.sideEffects === undefined) throw new Error(`${manifest.name} must declare sideEffects`)
  if (!manifest.files?.includes('docs')) throw new Error(`${manifest.name} does not publish docs`)
}

async function validateBuiltExportTargets() {
  const documentation = await readFile(path.join(packageDirectory, 'docs/api.zh-CN.md'), 'utf8')
  for (const section of requiredDocumentSections) {
    if (!documentation.includes(`## ${section}`)) {
      throw new Error(`${manifest.name} API documentation is missing "${section}"`)
    }
  }
  const readme = await readFile(path.join(packageDirectory, 'README.md'), 'utf8')
  if (!readme.includes('./docs/api.zh-CN.md')) {
    throw new Error(`${manifest.name} README must link the Chinese API documentation`)
  }

  for (const [publicPath, declaration] of Object.entries(manifest.exports ?? {})) {
    for (const target of readExportTargets(declaration)) {
      const probe = target.includes('*') ? target.slice(0, target.indexOf('*')) : target
      try {
        await access(path.join(packageDirectory, probe))
      } catch {
        throw new Error(`${manifest.name} export ${publicPath} points to missing ${target}`)
      }
    }
  }
}

async function validatePackedConsumer() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'velaros-workbench-contract-'))
  try {
    capture(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
      packageDirectory
    )
    const tarballs = (await readdir(temporary)).filter((file) => file.endsWith('.tgz'))
    if (tarballs.length !== 1) throw new Error(`${manifest.name} produced ${tarballs.length} tarballs`)

    const consumerDirectory = path.join(temporary, 'consumer')
    const packedPackageDirectory = path.join(
      consumerDirectory,
      'node_modules',
      ...manifest.name.split('/')
    )
    await mkdir(packedPackageDirectory, { recursive: true })
    capture(
      'tar',
      [
        '-xzf',
        path.join(temporary, tarballs[0]),
        '--strip-components=1',
        '-C',
        packedPackageDirectory,
      ],
      packageDirectory
    )

    for (const requiredFile of ['package.json', 'README.md', 'docs/api.zh-CN.md']) {
      await access(path.join(packedPackageDirectory, requiredFile))
    }
    await assertModuleScopedUtilityTypes(packedPackageDirectory)
    await linkConsumerDependencies(consumerDirectory)
    await typecheckEveryExport(consumerDirectory, packedPackageDirectory)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function assertModuleScopedUtilityTypes(packedPackageDirectory) {
  const duplicateGlobals = path.join(packedPackageDirectory, 'dist/velaros-globals.d.ts')
  try {
    await access(duplicateGlobals)
    throw new Error(`${manifest.name} tarball contains duplicate dist/velaros-globals.d.ts`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const declarations = await collectFiles(path.join(packedPackageDirectory, 'dist'), '.d.ts')
  if (declarations.length === 0) throw new Error(`${manifest.name} tarball has no declarations`)
  for (const declaration of declarations) {
    const sourceText = await readFile(declaration, 'utf8')
    if (sourceText.includes('velaros-globals.d.ts') || sourceText.includes('declare global')) {
      throw new Error(
        `${path.relative(packedPackageDirectory, declaration)} leaks ambient utility types`
      )
    }
    const importLine =
      sourceText
        .split('\n')
        .find((line) => line.includes(`from '${utilityTypeModule}'`)) ?? ''
    const declarationBody = sourceText.replace(importLine, '')
    for (const typeName of utilityTypeNames) {
      if (
        new RegExp(`\\b${typeName}\\b`, 'u').test(declarationBody) &&
        !new RegExp(`\\b${typeName}\\b`, 'u').test(importLine)
      ) {
        throw new Error(
          `${path.relative(packedPackageDirectory, declaration)} uses ${typeName} without a module import`
        )
      }
    }
  }
}

async function linkConsumerDependencies(consumerDirectory) {
  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    '@types/node',
    '@types/react',
  ])
  for (const dependency of dependencies) {
    const candidates = [
      path.join(packageDirectory, 'node_modules', ...dependency.split('/')),
      path.join(repositoryRoot, 'node_modules', ...dependency.split('/')),
    ]
    const source = await firstAccessiblePath(candidates)
    if (!source) {
      throw new Error(`Cannot typecheck packed consumer: local dependency ${dependency} is missing`)
    }
    const destination = path.join(consumerDirectory, 'node_modules', ...dependency.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    try {
      await lstat(destination)
    } catch {
      await symlink(source, destination, 'junction')
    }
  }
}

async function firstAccessiblePath(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Continue to the next workspace install location.
    }
  }
  return undefined
}

async function typecheckEveryExport(consumerDirectory, packedPackageDirectory) {
  const declarations = await collectFiles(path.join(packedPackageDirectory, 'dist'), '.d.ts')
  const declarationPaths = declarations.map((file) =>
    `./${path.relative(packedPackageDirectory, file).split(path.sep).join('/')}`
  )
  const specifiers = new Set()

  for (const [publicPath, conditions] of Object.entries(manifest.exports ?? {})) {
    const typeTarget =
      typeof conditions === 'string'
        ? conditions
        : typeof conditions?.types === 'string'
          ? conditions.types
          : undefined
    if (!typeTarget) throw new Error(`${manifest.name} export ${publicPath} has no types condition`)

    if (!typeTarget.includes('*')) {
      specifiers.add(toPackageSpecifier(publicPath))
      continue
    }

    const matcher = wildcardMatcher(typeTarget)
    const matches = declarationPaths.filter((candidate) => matcher.test(candidate))
    if (matches.length === 0) {
      throw new Error(`${manifest.name} export ${publicPath} matches no declaration files`)
    }
    for (const target of matches) {
      const capture = target.match(matcher)?.[1]
      if (capture === undefined) continue
      specifiers.add(toPackageSpecifier(publicPath.replace('*', capture)))
    }
  }

  const sourceText = [...specifiers]
    .sort()
    .map((specifier, index) => `import type * as Export${index} from ${JSON.stringify(specifier)};`)
    .join('\n')
  await writeFile(path.join(consumerDirectory, 'consumer.ts'), `${sourceText}\n`)
  await writeFile(
    path.join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'Preserve',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
          jsx: 'react-jsx',
          types: ['node', 'react'],
        },
        files: ['consumer.ts'],
      },
      null,
      2
    )}\n`
  )

  capture(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    consumerDirectory
  )
}

function toPackageSpecifier(publicPath) {
  return publicPath === '.' ? manifest.name : `${manifest.name}/${publicPath.slice(2)}`
}

function wildcardMatcher(pattern) {
  const [prefix, suffix] = pattern.split('*')
  return new RegExp(`^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function collectFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name)
      return entry.isDirectory()
        ? collectFiles(entryPath, suffix)
        : Promise.resolve(entryPath.endsWith(suffix) ? [entryPath] : [])
    })
  )
  return files.flat()
}

function readExportTargets(declaration) {
  if (typeof declaration === 'string') return [declaration]
  if (!declaration || typeof declaration !== 'object') return []
  return Object.values(declaration).filter((value) => typeof value === 'string')
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${(result.stdout || '').trim()}\n${(result.stderr || '').trim()}`
    )
  }
  return result.stdout.trim()
}
