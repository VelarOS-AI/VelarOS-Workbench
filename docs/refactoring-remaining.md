# 剩余实施与验证清单

2026-11-10 更新。既有生产行为源码的完整阅读回执已经合并，剩余未证实全文路径为 **0**。
这仅表示阅读覆盖收口；新增实现、行为验证和运行矩阵分别计账，不据文件数或提交数推导完成率。

## 阅读证据

- main / preload / shared 已有具名或明确目录全文记录。
- `724ab61` 清单中的 renderer 95 路径，先补齐 31 个具名回执，再独立全文读取其余 64 路径、8209 行。
  最后 64 路径在 `f694f64` 上初末 hash 相同，清单指纹为
  `9a05bccfd04cf68377580a8191075db26323210ab02141393aed2370a56246d9`。不再重读旧清单寻找重复工作。
- 工程入口 `scripts/test/conversationRuntime.test.mjs` 已全文读取 911 行、20 场景；
  `scripts/release/mainExternalEsmPlatformPackages.json` 两项配置及两个真实消费者已核对。
- 新增 owner、工具隔离算法及后续结构化执行合同按实施差量继续审阅，不冒称旧 hash 覆盖新实现。

## 当前交付与剩余工作

| 边界 | 当前状态 | 最小剩余工作 |
| --- | --- | --- |
| JS/TS/CJS 配置传递依赖 | `ff0ea87` 已交付。真实同 Services 根外 CJS→ESM lint 与 CJS formatter 依赖变化在原 5 秒内通过；新增 Tools Worker 入口实际打包及 NativeNode RPC/退出通过。 | 无已知待修；TS 热服务身份保留，相关类型、源码/测试 lint 与脚本严格检查已绿。 |
| Windows updater helper 回收 | `d5e6ec7` 已交付。真实 worker 句柄、匹配终态回执及取消停止 ACK 均由任务 owner 持有；实际原生安装收尾、恢复、错回执、相邻目录保留、替换和取消已验证。 | 无已知待修；五项必要用例、node 类型及相关 TS/JS lint 已绿，未扩充原预算。 |
| probe / isolated 宿主收口 | `9c2b932` 已交付。实际 CP/终止命令 close、延迟 force 和清理 ACK 已接通；真实缺回执故障及原 entrypoint 用例通过，实际 Electron/PTY 原 17 项断言通过。 | 无已知待修；原 120 秒预算保留。 |
| renderer 最后阅读发现 | `49e4399`、`564b14e`、`59bcbcb`、`48e94c9` 已交付请求归属、根路径、精确 fuzzy、死链及测试运行器识别修复。 | 无已知待修；必要路径用例、类型及相关 lint 已绿；DOM 乱序未实测。 |
| 生成命令字面参数 | `aa15f43` 已贯通 shared、terminal/debug、生成器、菜单、保存、启动项与重启。10 项 renderer、10 项 backend、三次真实 PTY 启动及一次真实 npm-prefix 查询取消/关闭故障通过。 | 无已知待修；node/web 类型与全部改动源码/测试定向 lint 已绿。实际 Corepack 下载/版本矩阵未运行；用户手写 command/raw args 保留实际 shell 语义。 |
| Tree 与 EditorConfig | `b9bb6c6` 已交付目录读取请求归属、失败 Promise 身份移除和错误分类；仅 NOT_FOUND 缓存缺失，其他失败不应用父规则，下一次自然请求可重试。 | 无已知待修；web 类型与两文件 lint 已绿，真实 DOM 乱序未实测。 |
| observe 预览与 peer 引用 | `a5d3ffd` 已交付 observe/execute 有界摘要副本及 destroyed peer watcher 释放；实际 Board 八项断言、原 trace/共享身份及相关检查通过。 | 展示层和新 Core 0.9.4 接入均已收口；产品未重建动态上下文、历史或缓存。 |
| Platform 固定归档 | 当前为正式 v0.7.6 / 0.9.5；独立归档/peer 核验、一次安装、三包锁与 node 类型通过。本产品不经过被修复的 packageEnvironment 包装，无产品源码修改。 | 无已知待修；0.9.4 的 web/lint、真实 Node/项目编辑证明及更早回执保持原身份，不重复执行或重标。 |

Tools Worker 额外短命 isolate 使用原 H 堆上限；H 不是两个 isolate 的聚合上限，潜在总量有限增加。
冷配置加载可能在原请求期限内明确失败，不能承诺所有大型项目仍按旧热缓存时延成功。
任意项目配置自行创建、脱离已知 owner 的外部服务不属于线程退出的完整保证。

已交付源码的必要验证见 [refactoring-progress.md](./refactoring-progress.md)。已合理保留的账号 CAS、编码往返、
事务撤销、真实进程树、Git 影子 index/ref、TS 热池与有界缓存、编辑器同步 owner、跨组文件状态不重复改写。
旧 Claude CLI unknown 授权状态缺少足够版本证据支持删除，保持既有合同。

上一轮截至正式 0.9.5 接入的已知问题与必要接入验证已完成；新的语义复审已交付七个独立源码批次，
包括项目退役准入、克隆目录保全和 Hub 投影。偏好不可读的实际承接正在实施，consent 关闭 owner 留作下一独立批；
具体游标见 [本轮记录](./refactoring-round-20261110.md)。
下列未实测矩阵是证据边界，不作为机械扩大改动的清单。

## 数据、fixture 与运行矩阵

- renderer 两份大语言表只核入口/合并/消费，未逐条核对翻译字面量；31 CSS、声明、HTML 未做逐字或视觉审计。
- 历史 `tests/fixtures/**` 按实际故障消费核读，不声称每份历史 fixture 全文。
- 真实 DOM、滚动/字体帧、HMR/native 连续时序、跨 OS PTY/磁盘/权限、第三方工具版本、Cloud 续期、签名安装与负载矩阵未穷尽。
- 已脱离父链/进程组且关闭继承 stdio 的任意 daemon 后代，不在 Node 公开 ChildProcess close 合同的完整保证内。
- observe 已确认保留，按小状态、摘要、差量和引用提供反馈；独立动态上下文及历史读取由 Platform 核心实现。
  Workbench 已消费正式 0.9.5，沿用 0.9.4 的真实宿主支持声明转发，不在产品补造核心 API；UI 预览仍保持原始 trace、
  增量事实、请求指纹和 provider 前缀缓存的既有合同。
