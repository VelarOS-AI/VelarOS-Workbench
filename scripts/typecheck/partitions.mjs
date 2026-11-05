// 用途：登记 Workbench 类型检查分区，让调度器与结构门共用一份清单。

// 按运行环境分成主进程与渲染进程两个独立程序；测试保留 Bun 逐文件隔离执行。
// 分区只为给单个程序的内存与耗时设上限，不承担边界约束——模块边界由 arch-guard 管。
const TypecheckPartitions = Object.freeze([
  { name: 'node', group: 'node', config: 'tsconfig/node.json' },
  { name: 'web', group: 'web', config: 'tsconfig/web.json' },
])

export { TypecheckPartitions }
