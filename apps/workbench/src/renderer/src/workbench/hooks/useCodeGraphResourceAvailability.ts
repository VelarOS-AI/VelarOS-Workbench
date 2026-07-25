/**
 * 独立 Workbench 应用的 codegraph 资源可用性投影（对位 desktop 同名 hook）。
 *
 * Desktop 依赖插件目录探测 codegraph 插件是否物理安装；独立应用的 AI 索引 / 代码图谱
 * 属 kernel 域（Phase 3 kernel-protocol 接入批），在此之前恒不可用——索引 UI 全体灰显、
 * AI 索引控制器被 `enabled: false` 关断。
 */
export function useCodeGraphResourceAvailability(): boolean {
  return false
}
