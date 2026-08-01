/**
 * 独立 Workbench 应用的 codegraph 资源可用性投影（对位 desktop 同名 hook）。
 *
 * 独立应用的基础项目索引由已发布 @velaros-ai/workspace 模块提供，因此始终可用。
 * 更丰富的 CodeGraph 诊断仍通过 status.codeIndex 精确表达，而不是用物理插件目录
 * 猜测能力是否存在。
 */
export function useCodeGraphResourceAvailability(): boolean {
  return true
}
