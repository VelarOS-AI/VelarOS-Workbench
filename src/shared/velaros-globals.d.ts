/** Workbench 进程与界面共用的编译期类型别名。 */
type Nullish = undefined | null
type Nullable<T> = T | null
type PlainObject = Record<string, unknown>
type JsonStringifyReplacerValue =
  | ((this: any, key: string, value: any) => any)
  | Array<string | number>
type JsonStringifyReplacer = Nullable<JsonStringifyReplacerValue>

type LooseOptional<T> = T | Nullish
