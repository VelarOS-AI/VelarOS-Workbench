// VelarOS-Workbench eslint 配置——自 VelarOS-Desktop monorepo eslint.config.mjs 裁剪:
// 去掉 desktop 主进程/extension 面,保留 react/web 面(react-hooks),规则本体与 monorepo 逐字一致,
// 保证同一份源码两仓 lint 语义不漂移。§12.9 组件形态封闭(uiComponentFormClosure/uiColorLiteralClosure)
// 属 arch-guard-velaros 检查,非 eslint 规则,本批暂留 monorepo(见 README 偏离项)。
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettierConfig from 'eslint-config-prettier'
import eslintComments from 'eslint-plugin-eslint-comments'
import reactHooks from 'eslint-plugin-react-hooks'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import unicorn from 'eslint-plugin-unicorn'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'

const rootDir = dirname(fileURLToPath(import.meta.url))

const commonGlobals = {
  ...globals.browser,
  ...globals.node,
  ...globals.es2024,
}

const localStylePlugin = {
  rules: {
    'explicit-public-methods': {
      meta: {
        type: 'layout',
        fixable: 'code',
        messages: {
          missingPublic: '类方法必须显式写 public。',
        },
        schema: [],
      },
      create(context) {
        const sourceCode = context.sourceCode

        return {
          'MethodDefinition, TSAbstractMethodDefinition'(node) {
            if (
              node.kind !== 'method' ||
              node.accessibility ||
              node.key?.type === 'PrivateIdentifier'
            ) return

            context.report({
              node,
              messageId: 'missingPublic',
              fix(fixer) {
                const decorators = node.decorators ?? []
                const insertBefore = decorators.length
                  ? sourceCode.getTokenAfter(decorators.at(-1))
                  : sourceCode.getFirstToken(node)

                return insertBefore
                  ? fixer.insertTextBefore(insertBefore, 'public ')
                  : null
              },
            })
          },
        }
      },
    },
    'no-braced-return-guard': {
      meta: {
        type: 'layout',
        fixable: 'code',
        messages: {
          unneededBraces: '单语句 return guard 不要包裹大括号。',
        },
        schema: [],
      },
      create(context) {
        const sourceCode = context.sourceCode

        return {
          IfStatement(node) {
            const block = node.consequent
            if (node.alternate || block?.type !== 'BlockStatement') return
            const statement = block.body[0]
            if (block.body.length !== 1 || statement?.type !== 'ReturnStatement') return
            if (sourceCode.getCommentsInside(block).length > 0) return

            context.report({
              node: block,
              messageId: 'unneededBraces',
              fix(fixer) {
                return fixer.replaceText(block, sourceCode.getText(statement))
              },
            })
          },
        }
      },
    },
  },
}

const commonPlugins = {
  'eslint-comments': eslintComments,
  'simple-import-sort': simpleImportSort,
  unicorn,
  'unused-imports': unusedImports,
  'velaros-style': localStylePlugin,
}

const commonRules = {
  'array-callback-return': 'error',
  'arrow-body-style': ['error', 'as-needed'],
  'curly': ['error', 'multi-line', 'consistent'],
  'default-case-last': 'error',
  'dot-notation': 'off',
  'eqeqeq': ['error', 'smart'],
  'eslint-comments/no-unused-disable': 'error',
  'eslint-comments/require-description': [
    'error',
    { ignore: ['eslint-enable'] },
  ],
  'no-array-constructor': 'error',
  'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
  'no-else-return': ['error', { allowElseIf: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-lonely-if': 'error',
  'no-nested-ternary': 'off',
  'no-new-object': 'error',
  'no-param-reassign': ['error', { props: false }],
  'no-restricted-syntax': 'off',
  'no-return-await': 'error',
  'no-unneeded-ternary': 'error',
  'no-useless-computed-key': 'error',
  'no-useless-concat': 'error',
  'no-useless-rename': 'error',
  'no-var': 'error',
  'object-shorthand': ['error', 'always'],
  'one-var': ['error', 'never'],
  'prefer-const': ['error', { destructuring: 'all' }],
  'prefer-object-spread': 'error',
  'prefer-template': 'error',
  'simple-import-sort/exports': 'error',
  'simple-import-sort/imports': [
    'error',
    {
      groups: [
        // Side-effect imports 在插件内以 \\u0000 为前缀参与匹配（见 eslint-plugin-simple-import-sort）。
        // 扩展入口须全局最先；勿删此组以免 autofix 把 @shared/extensions 排到 ./ 相对 import 之后。
        ['^\\u0000@shared/extensions$', '^\\u0000@velaros-ai/core/extensions$'],
        ['^\\u0000dotenv/'],
        ['^\\u0000'],
        ['^node:'],
        ['^react$', '^react-dom', '^@?\\w'],
        ['^@velaros-ai/'],
        ['^@shared/', '^@components/', '^@features/', '^@hooks/', '^@pages/', '^@styles/', '^@utils/', '^@/'],
        ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
        ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],
        ['^.+\\.s?css$'],
      ],
    },
  ],
  'unicorn/consistent-function-scoping': 'off',
  'unicorn/error-message': 'error',
  'unicorn/explicit-length-check': 'off',
  'unicorn/no-array-for-each': 'off',
  'unicorn/no-await-expression-member': 'off',
  'unicorn/no-empty-file': 'error',
  'unicorn/no-for-loop': 'off',
  'unicorn/no-lonely-if': 'off',
  'unicorn/no-negated-condition': 'off',
  'unicorn/no-new-array': 'error',
  'unicorn/no-typeof-undefined': 'error',
  'unicorn/prefer-array-find': 'off',
  'unicorn/prefer-array-flat-map': 'error',
  'unicorn/prefer-at': 'off',
  'unicorn/prefer-code-point': 'off',
  'unicorn/prefer-includes': 'error',
  'unicorn/prefer-logical-operator-over-ternary': 'off',
  'unicorn/prefer-modern-dom-apis': 'off',
  'unicorn/prefer-node-protocol': 'error',
  'unicorn/prefer-number-properties': 'off',
  'unicorn/prefer-query-selector': 'off',
  'unicorn/prefer-string-replace-all': 'off',
  'unused-imports/no-unused-imports': 'error',
  'velaros-style/no-braced-return-guard': 'error',
}

export default [
  {
    ignores: [
      '**/.git/**',
      '**/.claude/**',
      '**/.vite/**',
      '**/.velaros/**',
      '**/dist/**',
      '**/dist-plugins/**',
      '**/node_modules/**',
      '**/out/**',
      '**/release/**',
      '**/release-stage/**',
      'scripts/**',
      '**/*.config.cjs',
      'bun.lock',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: commonGlobals,
      sourceType: 'module',
    },
    plugins: commonPlugins,
    rules: {
      ...commonRules,
      'no-undef': 'error',
      'unicorn/prefer-module': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: commonGlobals,
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: rootDir,
      },
      sourceType: 'module',
    },
    plugins: {
      ...commonPlugins,
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...commonRules,
      'react-hooks/rules-of-hooks': 'error',
      'no-undef': 'off',
      'no-array-constructor': 'off',
      'no-implied-eval': 'off',
      'no-return-await': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-array-constructor': 'error',
      '@typescript-eslint/no-confusing-non-null-assertion': 'error',
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreIIFE: true, ignoreVoid: true },
      ],
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      // This rule can autofix guarded non-null assertions inside callbacks into TS errors
      // (for example optionalWhenLazy(value, () => value!)). TypeScript is the safer guard here.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/prefer-for-of': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/unified-signatures': 'error',
      'velaros-style/explicit-public-methods': 'error',
      'no-redeclare': 'off',
      'unused-imports/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          vars: 'all',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.d.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: false,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-implied-eval': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/return-await': 'off',
      'unicorn/no-empty-file': 'off',
      // ambient 全局增强必须用 `declare var`（与 extensions.ts 的全局 var 对齐）；no-var 的 autofix
      // 会把它改成 block-scoped 的 let，导致与全局声明冲突而编译失败。.d.ts 内一律关闭该规则。
      'no-var': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@velaros-ai/core/extensions',
              message:
                '原型扩展由各进程入口统一装载（src/main/index.ts、src/renderer/src/main.tsx）；业务与库包勿 side-effect 导入。',
            },
            {
              name: '@shared/extensions',
              message:
                '勿直接导入 @shared/extensions；由上述应用入口统一加载（测试目录除外）。',
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
]
