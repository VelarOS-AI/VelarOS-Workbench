# 2026-11-10 有限语义复审清单

固定范围为 20 个生产文件组、624 个 JS/TS 行为代码与工程脚本文件：src 584、工程与运行 worker 40。
范围在 `68271c1` 固定。最终已审 20 组、未审 0 组、已证实未修 0 项、未解决检查失败 0 项。
内容差量核到源提交 `b863730`；最终正式依赖接入已独立记录身份与验收，没有扩本轮语义审查范围。
审查范围已收口，不以修复或提交数量扩充清单。

这里的整组语义复审核对当前权威来源、真实生产者/消费者、失败结果与生命周期。上一轮全文账本仍独立，
未变纯算法及已有真实运行证据可具名复用；必须列明当前合同与保留理由，不把旧全文回执当作本轮新运行证明。
精确成员与内容指纹在本地 semantic-finite-inventory-20261110.json，组内发现按[本轮修复记录](./refactoring-round-20261110.md)独立交付。

CSS、HTML、声明、归档与依赖二进制不纳入行为代码计数；i18n 入口与调用合同计入，翻译字面量不逐条审校。
真实 DOM、原生连续交互、跨平台、供应商版本及签名发布矩阵保持原证据边界。未审为零不表示全部路径运行过。

| 组 | 生产文件组 | 文件数 | 本轮状态 | 当前负责人 |
| --- | --- | ---: | --- | --- |
| 1 | main composition/localization | 5 | 已审 | root |
| 2 | account/model | 5 | 已审 | root |
| 3 | analytics | 3 | 已审 | root |
| 4 | projects/windows | 15 | 已审 | project_cleanup |
| 5 | updates | 8 | 已审 | project_cleanup |
| 6 | conversation | 31 | 已审 | engine_cleanup |
| 7 | external engines | 11 | 已审 | engine_cleanup |
| 8 | main browser | 5 | 已审 | engine_cleanup |
| 9 | workspace files/Git | 39 | 已审 | engine_cleanup |
| 10 | terminal/watch/debug | 19 | 已审 | engine_cleanup |
| 11 | language workers | 27 | 已审 | project_cleanup |
| 12 | shared/preload | 36 | 已审 | project_cleanup |
| 13 | renderer shell/host/welcome/styles | 16 | 已审 | root |
| 14 | renderer chat/runtime | 58 | 已审 | renderer_cleanup |
| 15 | renderer controllers/commands/project models | 84 | 已审 | renderer_cleanup |
| 16 | editor/layout models | 95 | 已审 | renderer_cleanup |
| 17 | file/Git/debug models | 31 | 已审 | renderer_cleanup |
| 18 | renderer components | 82 | 已审 | root |
| 19 | renderer support/localization | 14 | 已审 | root |
| 20 | engineering/release/quality/runtime worker | 40 | 已审 | root |

账号/模型已核本地 revision、共享凭据原锁/CAS、元数据与目录结果 owner；凭据只 ENOENT 缺失默认，串行写成后才发布缓存。统计已核偏好可用性、metrics 对象回执及 consent 真实关闭票。两组均保留原加密/共享/采样/上传合同，没有新增迁移或运行矩阵。

有限组新确认的 6 项均已修复并验证：更新通道串行化、外部引擎请求取消与真实进程关闭、浏览器关闭失败传播、搜索 Worker 真实退出、终端退出回执。另删除 Git 设置死写链与零消费发布导出。整组审查已收口，后续不再新增排查。

root 补齐的 1/13/18/19/20 共 157 文件：装配先安装真实 owner 再开窗；项目壳按根 key 重建、Host 仅映射真实 IPC；组件复用全文并审九份差量，浏览器重试 timer 绑定 view；支持层保实际收尾/事件职责；工程层保旧 deadline、不可变归档、真实 ACK/close，零消费发布导出已退役。

有限尾项共 28 个不同定向场景通过，node/web 类型和 13 node / 3 web / 6 测试文件精确 lint 通过，发布脚本单文件 JS lint 通过。
首次诊断均在必要差量中修正，只补受影响检查；共享锁冲突和 ignored warning 没有冒作运行证明。面板真实 DOM、供应商、原生完整矩阵及跨 OS 仍是明确边界。

最终接入只复核 7 个已批准来源差量：真实 agentId 的宿主投影、现行 UI 消费及 canonical 发布依赖/归档/锁校验。
五个线程场景、五个发行规则场景及精确 lint 通过；已有类型和行为证明保持原归档身份。
Platform/capabilities 0.9.7、UI 1.1.2 的实际普通/frozen 安装、同一基础入口、一次 bundle 和隔离隐藏窗口欢迎页/真实 IPC/退出通过。
来源与运行边界见[正式接入记录](./workbench-platform-migration.md)，不把基本启动当作全部 DOM 或项目/Agent 路径运行证明。
