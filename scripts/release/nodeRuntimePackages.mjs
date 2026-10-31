// 用途：为独立 Node 复制代码工具依赖，并核验发行资源及按需导入时的实际执行。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

import { NodeDefaultPackages } from '@velaros-ai/script'

import WorkbenchNodePackages from '../../src/main/conversation/workbenchNodePackages.json' with { type: 'json' }

import { installedPackage } from './externalEsmArchive.mjs'

const SourceOnly = /(?:\.map|\.tsx|(?<!\.d)\.ts|(?<!\.d)\.[cm]ts|\.tsbuildinfo)$/iu
const TrailingSourceMap =
  /(?:^|\n)\s*\/\/[#@]\s*sourceMappingURL\s*=[^\r\n]*(?:\r?\n)?$|\/\*[#@]\s*sourceMappingURL\s*=.*?\*\/\s*$/u

/** 分发保留运行代码、原包说明和类型声明；去除已排除 map 文件的尾部引用。 */
async function normalizePackageFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await normalizePackageFiles(path)
    else if (/\.[cm]?js$/iu.test(entry.name)) {
      const source = await readFile(path, 'utf8')
      const normalized = source.replace(TrailingSourceMap, '\n')
      if (source !== normalized) await writeFile(path, normalized)
    }
  }
}

async function inventory(root, directory = root) {
  const files = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(files, await inventory(root, path))
    else {
      assert(entry.isFile(), `默认 Node 环境不能包含链接或特殊文件：${path}`)
      const key = relative(root, path).replaceAll('\\', '/')
      if (key === 'manifest.json') continue
      assert(!SourceOnly.test(key), `默认 Node 环境包含开发源码或 map：${key}`)
      files[key] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    }
  }
  return files
}

/** 按实际安装版本复制闭包；嵌套 node_modules 保持不同版本，不在发布时重新解析或联网安装。 */
export async function prepareNodeRuntimePackages(repository, destination) {
  await mkdir(destination)
  const script = installedPackage('@velaros-ai/script', repository)
  const versions = {}
  const copy = async (name, parent, targetParent, ancestors = new Map()) => {
    const record = installedPackage(name, parent)
    if (ancestors.get(name) === record.root) return
    const target = join(targetParent, 'node_modules', name)
    const bundled = Array.isArray(
      record.manifest.bundleDependencies ?? record.manifest.bundledDependencies
    )
      ? (record.manifest.bundleDependencies ?? record.manifest.bundledDependencies)
      : []
    await cp(record.root, target, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const path = relative(record.root, source)
        return (
          !path
            .split(/[\\/]/u)
            .some((part) =>
              ['.git', '.gitkeep', '.DS_Store', ...(bundled.length ? [] : ['node_modules'])].includes(part)
            ) && !SourceOnly.test(path)
        )
      },
    })
    const branch = new Map(ancestors).set(name, record.root)
    const optional = Object.keys(record.manifest.optionalDependencies ?? {})
    const required = new Set([
      ...Object.keys(record.manifest.dependencies ?? {}).filter((name) => !optional.includes(name)),
      ...Object.keys(record.manifest.peerDependencies ?? {}).filter(
        (name) => !record.manifest.peerDependenciesMeta?.[name]?.optional
      ),
    ])
    for (const dependency of required)
      if (!bundled.includes(dependency)) await copy(dependency, record.root, target, branch)
    for (const dependency of optional) {
      if (bundled.includes(dependency)) continue
      const candidate = installedPackage(dependency, record.root, true)
      if (!candidate) continue
      const matches = (values, actual) =>
        !values ||
        (!values.includes(`!${actual}`) &&
          (!values.some((value) => !value.startsWith('!')) || values.includes(actual)))
      if (
        matches(candidate.manifest.os, process.platform) &&
        matches(candidate.manifest.cpu, process.arch)
      )
        await copy(dependency, record.root, target, branch)
    }
    return record.manifest.version
  }
  // 宿主固定版本优先；同名默认包只复制一次，避免混入另一版本的残留文件。
  for (const name of NodeDefaultPackages.filter((name) => !WorkbenchNodePackages.includes(name)))
    versions[name] = await copy(name, script.root, destination)
  for (const name of WorkbenchNodePackages)
    versions[name] = await copy(name, repository, destination)
  const installers = { npm: await copy('npm', repository, destination) }
  await normalizePackageFiles(destination)
  await writeFile(
    join(destination, 'package.json'),
    JSON.stringify(
      {
        name: 'velaros-node-runtime',
        private: true,
        type: 'module',
        dependencies: { ...versions, ...installers },
      },
      null,
      2
    )
  )
  await writeFile(
    join(destination, 'manifest.json'),
    JSON.stringify({ packages: versions, installers, files: await inventory(destination) }, null, 2)
  )
}

/** 所有目标平台先核对资源清单；跨平台产物也不能跳过字节验证。 */
export async function assertNodeRuntimePackageFiles(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  assert.deepEqual(
    Object.keys(manifest.packages).sort(),
    [...new Set([...NodeDefaultPackages, ...WorkbenchNodePackages])].sort()
  )
  for (const [name, version] of Object.entries(manifest.packages)) {
    const installed = JSON.parse(
      await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8')
    )
    assert.equal(installed.name, name)
    assert.equal(installed.version, version)
  }
  const actual = await inventory(directory)
  const differences = [...new Set([...Object.keys(manifest.files), ...Object.keys(actual)])].filter(
    (file) => actual[file] !== manifest.files[file]
  )
  assert.equal(
    differences.length,
    0,
    `默认 Node 环境的文件缺失、增加或被改动（${differences.length} 项）：${differences.slice(0, 12).join(', ')}`
  )
  assert.deepEqual(Object.keys(manifest.installers), ['npm'])
  return manifest
}

/** 由发行 Node 执行基础工具、重构、格式化、结构搜索与网页测试的原包 API。 */
export async function assertNodeRuntimePackages(directory, executable) {
  const manifest = await assertNodeRuntimePackageFiles(directory)
  const { stdout } = await promisify(execFile)(
    executable,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {execa} from 'execa';import {rgPath} from '@vscode/ripgrep';
    import {globby} from 'globby';import {diffLines} from 'diff';
    import {parse} from 'yaml';import {createNode} from 'yaml/util';
    assert.equal(parse('answer: 42').answer,42);assert.equal(typeof createNode,'function');
    assert((await globby('package.json')).includes('package.json'));
    await assert.rejects(globby('{'.repeat(4000)+'a,b'+'}'.repeat(4000)),/maximum depth/);
    assert(diffLines('a','b').some(part=>part.added));
    assert.match((await execa(rgPath,['--version'])).stdout,/ripgrep/);
    console.log('NODE_DEFAULT_PACKAGES_VERIFIED');
  `,
    ],
    {
      cwd: directory,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', PATH: '' },
      timeout: 10_000,
      maxBuffer: 64_000,
    }
  )
  assert.match(stdout, /NODE_DEFAULT_PACKAGES_VERIFIED/u)
  const codeTools = await promisify(execFile)(
    executable,
    [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict';
      import {Project} from 'ts-morph';import {format} from 'prettier';
      import * as typescript from 'prettier/plugins/typescript';
      import * as estree from 'prettier/plugins/estree';
      const project=new Project({useInMemoryFileSystem:true});
      const source=project.createSourceFile('/math.ts','export function double(value:number){return value*2}');
      const consumer=project.createSourceFile('/use.ts',"import {double} from './math';export const answer=double(21);");
      source.getFunctionOrThrow('double').rename('twice');
      assert.match(consumer.getFullText(),/answer=twice\\(21\\)/);
      assert.equal(project.getPreEmitDiagnostics().length,0);
      assert.equal(await format('const total:number=42;', {parser:'typescript',plugins:[typescript,estree],semi:false}),'const total: number = 42\\n');
      assert.match(await format('export const View=()=> <p>hello</p>',{filepath:'View.tsx'}),/<p>hello<\\/p>/);
      import {modify,applyEdits} from 'jsonc-parser';
      import {parse as parseCode,Lang} from '@ast-grep/napi';
      import {test} from '@playwright/test';
      const config='{// keep\\n"value":1}';
      assert.match(applyEdits(config,modify(config,['value'],2,{})),/keep/);
      assert.equal(parseCode(Lang.TypeScript,'call(42)').root().findAll('call($A)').length,1);
      assert.equal(typeof test,'function');
      console.log('CODE_TOOLS_VERIFIED');
    `,
    ],
    {
      cwd: directory,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', PATH: '' },
      timeout: 15_000,
      maxBuffer: 64_000,
    }
  )
  assert.match(codeTools.stdout, /CODE_TOOLS_VERIFIED/u)
  const npm = await promisify(execFile)(
    executable,
    [join(directory, 'node_modules/npm/bin/npm-cli.js'), '--version'],
    {
      cwd: directory,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', PATH: '' },
      timeout: 10_000,
      maxBuffer: 64_000,
    }
  )
  assert.equal(npm.stdout.trim(), manifest.installers.npm)
  return Object.keys(manifest.files).length
}
