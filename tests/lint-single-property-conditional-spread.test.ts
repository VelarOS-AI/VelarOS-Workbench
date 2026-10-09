import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import tsParser from '@typescript-eslint/parser'
import { describe, test } from 'bun:test'
import { ESLint, type Rule, RuleTester } from 'eslint'

const repositoryRoot = resolve(import.meta.dirname, '..')
const pluginName = 'velaros-style'
const ruleName = 'no-single-property-conditional-spread'

type EslintConfigEntry = {
  plugins?: Record<string, { rules?: Record<string, Rule.RuleModule> }>
}

// 直接取 eslint.config.mjs 里真正注册的规则本体,测的就是 lint 实际跑的那份。
const { default: eslintConfigEntries } = (await import(
  pathToFileURL(resolve(repositoryRoot, 'eslint.config.mjs')).href
)) as { default: EslintConfigEntry[] }
const rule = eslintConfigEntries
  .map((entry) => entry.plugins?.[pluginName]?.rules?.[ruleName])
  .find((candidate) => candidate)
assert.ok(rule, `eslint.config.mjs 未注册 ${pluginName}/${ruleName}`)

RuleTester.describe = describe
RuleTester.it = test
RuleTester.itOnly = (name, callback) => {
  void test.only(name, callback)
}

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

const objectSpread = [{ messageId: 'objectSpread' }]
const jsxSpread = [{ messageId: 'jsxSpread' }]

ruleTester.run(ruleName, rule, {
  valid: [
    // 一组字段同进同出:非空分支 2+ 属性不报。
    { code: 'const a = { ...(cond ? { k: v, j: w } : {}) }', filename: 'fixture.ts' },
    { code: 'const a = { ...(cond && { k: v, j: w }) }', filename: 'fixture.ts' },
    { code: 'const a = { ...(cond ? { k: v, ...rest } : {}) }', filename: 'fixture.ts' },
    // 分支本身是展开 / 标识符 / 两边都非空,都不是「加一个字段或什么都不加」。
    { code: 'const a = { ...(cond ? { ...extra } : {}) }', filename: 'fixture.ts' },
    { code: 'const a = { ...(cond ? base : {}) }', filename: 'fixture.ts' },
    { code: 'const a = { ...(cond ? { k: a } : { k: b }) }', filename: 'fixture.ts' },
    // 普通展开与推荐写法。
    { code: 'const a = { ...base, k: v }', filename: 'fixture.ts' },
    { code: 'const a = { k: optionalWhen(cond, v), j: toOptional(w) }', filename: 'fixture.ts' },
    // 数组 / 实参展开不在本规则范围。
    { code: 'const a = [...(cond ? [x] : [])]', filename: 'fixture.ts' },
    { code: 'call(...(cond ? [x] : []))', filename: 'fixture.ts' },
    // JSX:普通展开与多属性条件展开不报。
    { code: 'const e = <X {...props} />', filename: 'fixture.tsx' },
    { code: 'const e = <X {...(cond ? { a: 1, b: 2 } : {})} />', filename: 'fixture.tsx' },
    { code: 'const e = <X title={optionalWhen(cond, t)} />', filename: 'fixture.tsx' },
  ],
  invalid: [
    { code: 'const a = { ...(cond ? { k: v } : {}) }', filename: 'fixture.ts', errors: objectSpread },
    { code: 'const a = { ...(cond ? {} : { k: v }) }', filename: 'fixture.ts', errors: objectSpread },
    { code: 'const a = { ...(cond ? { k } : {}) }', filename: 'fixture.ts', errors: objectSpread },
    { code: 'const a = { ...(cond && { k: v }) }', filename: 'fixture.ts', errors: objectSpread },
    { code: 'const a = { ...(a && b && { k: v }) }', filename: 'fixture.ts', errors: objectSpread },
    { code: 'const a = { ...(cond ? { k: v } : undefined) }', filename: 'fixture.ts', errors: objectSpread },
    { code: 'const a = { ...(cond ? null : { k: v }) }', filename: 'fixture.ts', errors: objectSpread },
    {
      code: 'const a = { base: 1, ...(isUndefined(value) ? {} : { value }), other: 2 }',
      filename: 'fixture.ts',
      errors: objectSpread,
    },
    // TS 包装(as / satisfies / !)不影响判定。
    { code: 'const a = { ...((cond ? { k: v } : {}) as Partial<T>) }', filename: 'fixture.ts', errors: objectSpread },
    {
      code: 'const a = { ...(cond ? ({ k: v } satisfies Partial<T>) : ({} as Partial<T>)) }',
      filename: 'fixture.ts',
      errors: objectSpread,
    },
    { code: 'const a = { ...(cond ? { k: v } : {})! }', filename: 'fixture.ts', errors: objectSpread },
    {
      code: 'const a = { ...(cond ? { k: v } : {}), ...(other ? { j: w } : {}) }',
      filename: 'fixture.ts',
      errors: [...objectSpread, ...objectSpread],
    },
    { code: 'const e = <X {...(cond ? { title: t } : {})} />', filename: 'fixture.tsx', errors: jsxSpread },
    { code: 'const e = <X {...(cond && { title: t })} />', filename: 'fixture.tsx', errors: jsxSpread },
  ],
})

void describe(`${pluginName}/${ruleName} 接线`, () => {
  void test('TS 与 TSX 源码都按 error 启用', async () => {
    const eslint = new ESLint({ cwd: repositoryRoot })
    for (const file of ['src/main/index.ts', 'src/renderer/src/main.tsx']) {
      const config = await eslint.calculateConfigForFile(resolve(repositoryRoot, file))
      assert.deepEqual(config.rules?.[`${pluginName}/${ruleName}`], [2], file)
    }
  })
})
