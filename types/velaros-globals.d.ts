/**
 * VelarOS 各包共用的全局 TypeScript **类型别名**（单一数据源）。
 *
 * - 各包 `src/velaros-globals.d.ts`（于 `packages/<name>/src/`）仅三斜杠引用本文件，避免重复维护。
 * - 构建后由 `scripts/build/copy-velaros-globals-to-dist.mjs` 复制到各包 `dist/velaros-globals.d.ts`。
 *
 * 仅保留**纯类型别名**（编译期，无运行时）。原先挂在此处的运行时全局函数 / 变量（`AppError`、
 * `isString` 等守卫、`toNullable` / `optionalWhen` / `mapDefined`）与原型扩展（`JSON.stringifyPretty`）
 * 已改为 `@velaros-ai/core` 具名导出，调用点显式 `import`，不再污染宿主全局。
 *
 * 全局空占位：`undefined` 与 `null`。
 * 新代码优先用 `undefined`；仅在 JSON／IPC、DOM/React ref、序列化必须用 `null` 时写 `null`。
 */
type Nullish = undefined | null
type Nullable<T> = T | null
type PlainObject = Record<string, unknown>
type JsonStringifyReplacerValue =
  | ((this: any, key: string, value: any) => any)
  | Array<string | number>
type JsonStringifyReplacer = Nullable<JsonStringifyReplacerValue>

type LooseOptional<T> = T | Nullish
