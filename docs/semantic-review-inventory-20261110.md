# 2026-11-10 有限语义复审清单

固定范围为 20 个生产文件组、624 个 JS/TS 行为代码与工程脚本文件：src 584、工程与运行 worker 40。
范围在 `68271c1` 固定。当前已审 2 组、待补 18 组；不少待补组已有本轮局部接缝证据，仍不冒作整组结论。
后续只关闭这些组，不以修复或提交数量扩充清单。

这里的整组语义复审核对当前权威来源、真实生产者/消费者、失败结果与生命周期。上一轮全文账本仍独立，
未变纯算法及已有真实运行证据可具名复用；必须列明当前合同与保留理由，不把旧全文回执当作本轮新运行证明。
精确成员与内容指纹在本地 semantic-finite-inventory-20261110.json，组内发现按[本轮修复记录](./refactoring-round-20261110.md)独立交付。

CSS、HTML、声明、归档与依赖二进制不纳入行为代码计数；i18n 入口与调用合同计入，翻译字面量不逐条审校。
真实 DOM、原生连续交互、跨平台、供应商版本及签名发布矩阵保持原证据边界。未审为零不表示全部路径运行过。
| 组 | 生产文件组 | 文件数 | 本轮状态 | 当前负责人 |
| --- | --- | ---: | --- | --- |
| 1 | main composition/localization | 5 | 待补整组结论 | root |
| 2 | account/model | 5 | 已审 | root |
| 3 | analytics | 3 | 已审 | root |
| 4 | projects/windows | 15 | 待补整组结论 | project_cleanup |
| 5 | updates | 8 | 待补整组结论 | project_cleanup |
| 6 | conversation | 31 | 待补整组结论 | engine_cleanup |
| 7 | external engines | 11 | 待补整组结论 | engine_cleanup |
| 8 | main browser | 5 | 待补整组结论 | engine_cleanup |
| 9 | workspace files/Git | 39 | 待补整组结论 | engine_cleanup |
| 10 | terminal/watch/debug | 19 | 待补整组结论 | engine_cleanup |
| 11 | language workers | 27 | 待补整组结论 | project_cleanup |
| 12 | shared/preload | 36 | 待补整组结论 | project_cleanup |
| 13 | renderer shell/host/welcome/styles | 16 | 待补整组结论 | root |
| 14 | renderer chat/runtime | 58 | 待补整组结论 | renderer_cleanup |
| 15 | renderer controllers/commands/project models | 84 | 待补整组结论 | renderer_cleanup |
| 16 | editor/layout models | 95 | 待补整组结论 | renderer_cleanup |
| 17 | file/Git/debug models | 31 | 待补整组结论 | renderer_cleanup |
| 18 | renderer components | 82 | 待补整组结论 | root |
| 19 | renderer support/localization | 14 | 待补整组结论 | root |
| 20 | engineering/release/quality/runtime worker | 40 | 待补整组结论 | root |

账号/模型已核本地 revision、共享凭据原锁/CAS、元数据与目录结果 owner；凭据只 ENOENT 缺失默认，串行写成后才发布缓存。统计已核偏好可用性、metrics 对象回执及 consent 真实关闭票。两组均保留原加密/共享/采样/上传合同，没有新增迁移或运行矩阵。
