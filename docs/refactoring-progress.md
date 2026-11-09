# Workbench 清理与统一底座接入游标

起点：`5f00388153c513b5cf7e32397383c6c36b365d92`，工作区干净；本仓及上级未发现 AGENTS.md。
遵循 `workbench-internals.md`、`model-requests.md`、`local-platform-release.md` 与产品边界检查。

## 模块与归属

| 负责人 | 独占模块 | 本批工作 |
| --- | --- | --- |
| 主 agent | main/conversation、main/index、ProjectRegistry、shared/preload 登记合同、依赖/发行配置、规范文档 | Platform 显式装配、产品身份迁移、事件持久化、审查/验证/提交 |
| engine_cleanup 子 agent | main/engines 及引擎现有测试 | 协议旧兼容、会话身份与生命周期 |
| project_cleanup 子 agent | 已交付项目/终端/历史批次；Git 源码与相关测试 | Windows 进程取消、stash 对象身份 |
| renderer_cleanup 子 agent | renderer 宿主/组合、项目页面/恢复 hooks 与相关模型 | 删除旧嵌入/伪绑定，接主进程登记、恢复后才保存 |

子 agent 不跨仓、不提交；主 agent 按批审查，只 stage 本批。重型验证通过共享
`D:/Projects/VelarOS-Desktop/scratchpad/heavy-validation.lock` 的独占 token 串行执行。

## 实际依赖边界

当前使用 Platform 正式发布 `v0.7.6` / commit `70e93a2b8c020ad7509a9fb2d8eb3f7a754664a7`，
Velaros / Capabilities 均 `0.9.5`；UI `1.0.0` / `c6be9c5a143a96913422f6a577885a870c6fc274`。
全部为带哈希的本仓归档，不是兄弟仓链接；schema2 记录正式来源。0.9.1 候选及消费证明保留为历史证据。

- Runtime 根入口：createRuntime、openSessionControl、createCapabilityModule、会话/笔记/trace；Node 入口为 `/node`。
- 执行与上下文：execution、execution/local、script、act/agents、kernel、contracts、renderer。
- 显式接入能力：Capabilities 的 project/code/images、browser（含 electron/contracts/renderer）、sessions、web；基础的 memory、widgets、agents 由产品显式选择。
- 产品宿主：project 内核供 IDE 读文件/规则；memory 存储按真实项目根分格；model 连接与目录；core 通用错误、计时、原子写和共享账号资源。
- UI：公开 conversation、contracts、composer、markdown 与组件/样式入口。

Workbench 独占项目/浏览器 workspace、项目成员/资源/权限策略、IDE 与产品窗口、产品会话目录及投递。
Platform 只持有通用 Agent/Session、执行、上下文、交互与授权。Cloud 是独立服务。

## 固定归档接入

1. ADR 0028 / 0029 与配套双包已交付；当前消费 0.9.5 正式归档，执行与独立无执行控制口均使用公开合同。
2. project/code/images、memory、widget、worker profile 已按实际构建后的公开声明显式装配。
3. executionIdentity、authorizationScope 与模块绑定是通用恢复约束；Workbench 的项目与浏览器选择留在产品。
4. manifest、Bun 锁与已安装双包均已切换；可核验来源及归档见迁移文档，不加旧接口适配或 node_modules 补丁。

ADR 0028 已读，产品装配方案：

- 消费固定 `@velaros-ai/velaros` 基础及匹配版本 `@velaros-ai/capabilities` 扩展；专项 import 整批迁移，根 Node 工厂改从 `/node` 消费。
- 保持现有应用级 ShellHostRegistry 为唯一进程 owner；借给每轮 Node，不能让新入口再创建第二份本机 Host。
- 每项目/会话目录显式建立存储；执行身份派生自产品确认的真实项目根、会话，授权范围包含沙箱策略；产品恢复入口重新核验窗口项目。
- 显式建立 project kernel/ports、project/code/images 三模块和稳定 instance/generation；console、browser/devtools/cdp、web、sessions 继续由 Workbench 注入；memory、widgets、worker profile 显式选择。
- 旧 runtime:workspace 不兼容读取；切换到新存储代际，界面历史可保留，新执行从经核验的新会话开始。
- `WorkbenchConversationSession.openControl` 使用产品不可变执行凭据及公开 openSessionControl，不挂业务模块。实际公开调用库存已完整核对，当前无新增 Platform 合同缺口；Workbench 没有空闲 trace 调用。

## 阶段记录

- 独立清理已收口：项目窗口、外部引擎、账号/模型凭据、renderer 宿主/评论/持久化装配、终端、本地历史、会话恢复。
- 核查后不改：AtomicFileWrite、TextCodec、DeleteUndoStore 的真实字节/权限/撤销约束；账号 routePolicy.models 是真实 Cloud producer，不属于旧兼容。
- 用户要求减少测试：主 agent 合并一次必要受影响验证，不跑全量回归、长 E2E、大型矩阵与重复 build；子 agent 不独立跑重型检查。
- 已通过：项目/引擎/恢复/终端/产品边界 6 文件 62 项；账号/凭据 4 文件 34 项；产品边界静态门。后续仅定向验证新增故障场景及 JSON 工厂变更。
- node/web 类型已通过。38 个变更 node、20 个变更 web 文件 lint 的四处格式问题已定向修正并复查；其余原通过结果复用。12 个变更测试文件 lint 通过。
- 追加定向验证已通过：历史 2 项、引擎写盘重试 1 项、跨窗口登记 1 项、stash 3 项、远端/控制 3 项；Node 实际常驻进程 3 项。Windows 上另外 5 项非 Windows 远端场景如实跳过。
- 项目身份现由主进程 ProjectRegistry 单队列持有；只在首次新存储建立时导入原 v1 完整快照，原 ID/编辑器会话键保留；renderer 不再整表回写项目列表。此为产品数据迁移，不是旧运行行为 fallback。
- 更新过的项目/JSON 9 项通过，产品边界检查通过；脚本按仓库 lint 配置被忽略，其三个真实 Node 进程行为已验证。没有运行全量回归、性能/长 E2E 或生产 build。
- 前八批独立清理代码均已提交；这不代表全仓已审完。模块级完整/局部/未覆盖及合理保留记录位于 ignored `.velaros/workspace/checks/module-coverage.md`，下一轮按缺口继续。

已提交批次（各批保留上述通过证据，不重复回归）：

| commit | 模块 |
| --- | --- |
| e6efbc5 | 账号/凭据 |
| f87bbb0 | 会话恢复与无消费注入 |
| 96d38f7 | 终端资源端口与退出等待 |
| 5d7bae3 | 外部引擎协议、接纳、持久身份 |
| 6bb82d5 | 本地历史失败保全 |
| 02aa856 | 控制台启动取消与常驻进程展示 |
| 4f7cba8 | stash 并发与 Windows Git 进程取消 |
| 7cda76a | 主进程项目身份、恢复保存闸门、renderer 旧状态清理 |
| f0cd235 | 显式 0.9.1 底座与候选来源/消费证明 |
| a5b313c | 保存与停止失败回执 |
| d5e9c7f | 资源 owner 关闭、迟到启动与真实退出回执 |
| a590459 | 偏好写盘成功后才更新内存 |
| 2096ff3 | canonical checkpoint 准入、NUL unstage、退役 Git 字段 |
| 3b872b3 | 调试设置确认与 renderer 迟到资源接纳 |
| 28a3ea5 | 正式 Platform v0.7.3 / 双包 0.9.2 固定来源 |
| 380a550 | 跨包 TS 删除/重建与项目配置缓存 |
| 649bd9f | 死项目桥与旧 AI 索引合同 |
| 2353c7a | 内联补全的文档、选区、配置与生命周期归属 |
| 6f5dd47 / 07762db | Apache-2.0 开源、公开构建说明与许可证行尾 |
| 4dea2a5 | 丢弃 LSP overlay、旧诊断及 worker 初始化失败回执 |
| 3efe38d | signature 插件 owner、snippet 实际语言身份与死 textarea 链 |
| ff86bc4 | brace 展开前收束剩余预算 |
| b5defa2 | 无消费 System 合同与 workspace 旧导出别名 |
| 3c969dc | 图片后缀查找不再读取对象原型 |
| 578c6bf | 搜索 owner 取消并等待替换旧请求及匿名请求 |
| d882237 | 保存/关闭采用即时草稿 owner 与有效格式 |
| d53d719 | 退役无生产入口的绝对附件/Office 预览链 |
| c1c8c9d | source map 无源区间截断前一段映射 |
| fdd3431 | 空白行不参与缩进检测 |
| 6181979 | incremental blame 支持真实 40/64 位对象名 |
| 3667cea / 1b075f0 | 发布说明的文本/列表形状与无关格式差量回收 |
| 5be420e | 打包清单显式携带项目 LICENSE |
| ba755f9 | catalog 替换空窗后的跨进程签名平台并集恢复 |
| afaeecb | 历史选择、来源切换与迟到缓存写入的 owner |
| 45bd3a7 | 删除等待期间新增草稿保留为已删文件冲突 |
| 94568f5 | CodeMirror 重命名/格式化/保存等待归原文件 |
| 7a23605 | 删除仅测试消费的旧 graph neighborhood helper |
| d3242bb | raw observer 到场时获知当前观察缺失 |
| 7e33207 | 双后端提交准备、peer、journal 删除与关闭统一 owner |
| ca1f720 | 观察卡按持久请求序号接纳，旧回合继续结算原卡 |
| aea65c3 | 冷 lazy 导航由实际编辑器就绪与接纳回执消费 |
| bef1d1e | typed lint 单批修复后用新 Program 独立验证 |

统一底座接入批：配套 0.9.1 基础/扩展显式装配、产品不可变执行凭据、foundation-v1 数据代际、
无执行空闲控制、active-only tell 与错误回执、schema2 来源和正式候选拒绝门；来源 commit、
双归档 SHA256 与全部公开调用库存见 `workbench-platform-migration.md`。当前确认无新增 Platform 合同缺口。

本批受影响验证：node / web 类型通过（单分区原 45s / 2GiB 预算）；20 个 node、8 个 web、9 个
测试文件 lint 通过，失败导入区和后续两处测试改动仅定向复查。脚本沿用仓库 ESLint 忽略规则，
由对应真实行为测试检查。产品边界及三包固定归档/完整锁身份通过。
执行凭据 5 项、peer 6 项、来源快照 2 项、正式发布来源门 5 项、类型属主 5 项、模型配置 1 项、
行内补全 1 项通过；Node 24.22.0 四项真实项目/进程/SQLite/会话委派场景通过。
peer 与属主测试初次各一项旧断言失败，按新合同修正后仅重跑失败项，其余绿项复用。
未运行全量回归、跨平台矩阵、长 E2E、生产 build 或安装包发布；此批当时的本地候选不能进入正式 stage。

后续按模块覆盖短表补空白，继续文件/搜索/监听、语言/调试、renderer hooks/models；检查点最终采集
与下一轮 capture 入队顺序后来由 `2096ff3` 收口。已确认的绿项不重复运行。

接入后的模块排查继续推进：`a5b313c` 修复退出同步保存和运行卡重启对失败信封的忽略；保存成功后才确认
已刷盘，停止成功后才清旧输出并重启。其 web 类型及 2 个 hook 的 lint 已通过，未为这两个直接错误转发新增镜像测试。

资源清理批：恢复删除项先收束真实父目录，越界拒绝且保留撤销副本；watch 的异步订阅先取得 owner，
项目释放/窗口销毁回收晚到订阅，服务 dispose 为永久终态，阻止晚到 raw observer 重建监听。
前台命令现在接窗口/项目/应用关闭取消，等待进程组强杀边界；shell 先退也不能撤掉子孙清理。
Terminal / Debug 等待并撤销准备中的启动，拒绝关闭期间的新资源，调试晚交资源停止失败同时返给启动与关闭调用方。
LSP 关闭共用实际 Promise，真实退出未确认时保留进程引用并报告失败；旧失败清理也保留待收束进程。
应用与 probe / fixture 的关闭调用均等待新回执。

该批 node / web 类型及 10 个 node、2 个 web、8 个测试文件 lint 通过；遗漏日志 import 与一处数组类型
规则仅定向修正。8 个最小故障场景通过（真实 Node 子孙清理、命令 owner、恢复越界、两类 watcher 关闭、
Terminal 准备取消、Debug 晚交清理失败、真实 LSP 协议/共享 dispose）。沿用原分区预算与已有绿项，未跑全量或生产构建。

后续 Git 顺序、argv、退役字段，跨包 TS 磁盘版本与数据配置缓存，renderer 调试确认及启动接纳均已继续收口。
仍未完成的明确项：语言 worker 硬终止时跨线程子进程 owner、Markdown 计算取消，
代码型配置及依赖模块完整热重载；
source map/Windows helper 资源边界及其余覆盖表空白。历史读取、删除期间草稿与跨后端删除事务已由后述批次收口。
worker 必须有真实资源所有权方案，不能靠加大 8s 预算或 best-effort PID 通知宣称解决。
正式资产已交付：Platform v0.7.3 双包 0.9.2 已经 Release/tag→commit/asset digest/实际下载 SHA
核验并安装，Bun 锁只变更双包 spec、integrity 与 required peer。0.9.2 的 idle trace/traceBranches 是新增只读口，
Workbench 当前无新增消费；原四个真实 Node 场景复用，最终仅补归档/锁身份及受影响静态/类型。

上述后续一致性批验证：偏好真实写盘失败/同值重试 1 项；Git 顺序/别名固定、长 argv unstage、分支 IPC
3 项；跨包 TS 删除重建、真实 ESLint、Prettier 数据配置/EditorConfig 3 项；调试启动期间设置变化和两类拒收重试 3 项。
10 项通过。TS 新用例首次揭示缺失模块解析缓存未清，修正结构失效并仅重跑失败项；仍为同一个热 service，未放宽断言。
源码 11 个 node / 9 个 web、7 个测试文件 scoped lint 通过；后续 Host/fixture 修正及死端口/内联补全增量
7 个 node / 2 个 web / 2 个测试文件 lint 通过，未变源码绿项复用。0.9.2 安装后的 node/web 类型与三包完整锁身份通过。
所有分区沿用原 45s / 2GiB 预算；没有补跑四个真实 Node 场景、全量回归或生产构建。

两类死项目端口及旧 AI 索引合同已沿唯一 preload/IPC/Manager 链删除；没有给零生产消费代码新增镜像测试。
内联补全以对象 token 比较完整模型配置快照与项目/路径，另外核文档、完整选区和 plugin 代际；不序列化凭据，
不把前端丢弃结果称为已取消后端请求。该处以实际唯一消费链与 web 类型/lint 检查，未引入新的 DOM 测试框架。
全仓排查仍未完成，完整、接缝、未读和合理保留范围持续记录在 ignored 模块覆盖表。

Workbench 开源准备沿用公开 Platform / UI 的 Apache-2.0：加入完整许可证、包元数据及公开 clone / 构建说明，
移除当前三包固定快照已经不再需要的私有 registry 配置。保留 `private: true` 以禁止误发 npm 包；它不控制 GitHub 可见性。
发布前使用校验过官方 SHA256 的 Gitleaks 8.30.1，以 `--all --full-history` 扫描全部本地可达 refs，
实际处理 560 个有内容的提交、约 13.15 MB，默认规则及忽略注释禁用、输出完全脱敏，未发现凭据匹配。
当前跟踪树没有本地数据库、密钥、依赖归档、可执行程序或 symlink；本机缓存、用户数据及进行中的未提交清理不进入本次提交。
该扫描是发布内容检查，不代表全仓模块审计已经完成，也不替代依赖各自的许可证。

开源已执行：`VelarOS-AI/VelarOS-Workbench` 的 `main` 已推送至 `07762db`，GitHub 管理接口及
无授权头的匿名 API 均确认 `private: false`、Apache-2.0；Desktop 仍由独立私有仓库管理。

公开后的第一组模块清理已分批提交：搜索所有请求同步取得窗口 owner，同 id 被替换的旧请求仍握完成票，
崩溃、项目释放及应用关闭取消并等待；匿名搜索保持一次性结果，取消批不再送旧流。
LSP 完整 dirty 快照撤销丢弃的正文，省略快照继续保留；同 URI 重开使用递增版本，拒收明确过期的版本诊断。
首次 Windows 用例揭示未落盘文件经不同 URI 库往返造成盘符身份漂移，改为同一 Node URI producer，原断言保留并只重跑失败项。
Worker 冷启动与退避创建同步抛错都会 settle 待请求，后续请求能重试且不重放失败请求；没有增加预算或新测试注入口。
signature help 的 tooltip 与代际归具体 plugin，destroy 撤销晚回执；snippet 两缓存共用编辑器的真实特殊文件名优先 token。
brace 展开达到 64 项就停止访问后续分支；图片类型改用 Map，`.constructor` / `.__proto__` 不再被误认图片。
删除零消费的旧 textarea 编辑链、System 旧合同及七个别名；EngineProcess 的真实 CommandHelper 消费改为 canonical 类名。

本组 11 个必要场景通过：搜索 IPC 3、LSP 3、Worker 真实构造拒绝 1、snippet 1、glob 2、图片识别 1。
Worker 的重试/关闭部分复用现有测试 transport，未宣称启动真实线程。node/web 类型通过，20 node / 5 web / 6 测试
文件 scoped lint 已通过；唯一测试数组类型规则修正后只复查该文件，所有其他绿项复用。原 45s / 2GiB 预算不变。
未执行全量回归、生产构建或安装包发布；模块覆盖表仍分别记完整、局部及未读，不能以这些批次代表全仓完成。

下一组五批已提交：标签正文/格式修改同步接纳到同一 owner，再发布 React snapshot；旧保存回执只确认自己写下的版本，
排队保存也保留请求时的有效格式。关窗静默 flush 与确认保存后都重算当前 dirty，不能用旧 saved/skipped 计数放行。
轻量预览的两个实际 producer 都持有当前项目身份；旧绝对附件 builder/Office selector 只有测试在调用，
因此连同死解码/保存分支、session 附件 host 口、System 合同、不可达 UI/样式整链移除。当前项目内图片只读和文本保存仍走真实项目端口。
按 ECMA-426 保留 source map 合法单字段无源片段，mapped→unmapped→mapped 区间不再借前一段冒充源位置；
缩进忽略纯空白行；blame 严格识别 Git 的 SHA-1 / SHA-256 40/64 位对象名及同宽全零未提交号，不扩成任意长度。

本组 13 个受影响场景通过（既有保存模型 6、关窗定向 2、项目图片只读 1、source map 2、缩进 1、blame 1），
node/web 类型、产品边界门、4 node / 9 web / 6 测试文件 scoped lint 一次通过。保存故障证据使用实际生产模型函数，
没有复制 hook、增加测试专用生产口或 DOM 框架；完整 React / 原生窗口交互未测。没有全量回归、压力测试或重复生产构建。
覆盖新增 Runtime 本体及 DebugSession 全算法、17 组非语言/对话 shared 桥、主文件/命令/归属账本、Windows 更新 helper 全文；
准确文件与仍仅接缝/未读的 renderer 大组件、部分 shared 语言/对话协议、发行与工程脚本继续见 ignored 模块覆盖表。

再一轮已验证并分批提交：history 的空选择、inactive/空 records、source 切换及卸载都撤销旧请求代际，
回执只写捕获的 cache owner；文件树删除后只关当前 clean 标签，后来出现的正文或格式草稿保留并进入既有 deleted 恢复保存流。
CodeMirror 的文件 owner 覆盖复用 view、卸载和 A→B→A，rename/format 在任何编辑或跨文件交接前复核原文档，
save 在格式化等待后仍调用原文件回调。没有把丢弃前端回执称为已取消后端，也未宣称跨文件写入事务原子化。
原 graph neighborhood helper 只有旧测试调用，随其专属断言退役；真实 compiler graph 解析、patch 和 UI 投影保留。
raw observer 注册后立即获知当前 watcher 缺失，首轮创建失败和加入既有 unavailable 根都不再误报已观察。

双后端会话现由 Dispatcher 同步登记准备再执行：普通发送与 peer 的 UI/journal 准备共用 receipt，保留真实
streamId/sequence/emittedAt；caller 取消只管准备，后端同步交接后解除该绑定。取消、重复删除、项目关闭和应用关闭
都等待准备、执行、持久流 finish；同一删除共用 Promise，两后端及产品 journal 都尝试收束后统一交付失败。
Ipc 不再持另一张 admission 表，也不在 runtime 删除开闸后另删 journal；peer 改用同一 Dispatcher，settled 在其实际 finish 后发。
统计仅在取得准备 receipt 后登记，统计异常不能丢掉 receipt；准备失败不会残留 Reporter 的待结算 run-start。

发行侧保留签名 schema2 catalog 的不可变事务资产，替换公开 metadata 前先持久化完整平台并集。
新进程按名称 digest、签名、source/tag/version/channel/note 及唯一远端字节验证后恢复；不凭孤立二进制猜身份，
不把事务副本当 completion 或伪造合并后的旧签名。canonical 尚在而事务并集更大也为 partial。
最初新用例遗漏传 staged 而误走既有完成态复用门，改用实际 stage 读取后仅重跑该故障，其余五个绿项复用。
新增平台在删旧 catalog 后上传失败、丢弃本机 metadata、fresh read 再完成的故障通过，旧平台及 assetId 保留。
发布说明标题严格为文本、变更严格为列表；打包 YAML 显式加入 LICENSE，已解析核验，未制作新安装包。

本轮必要验证：raw watcher 1、发布说明 2、publisher 6、tab-close 7、Vim 既有接线断言 2、真实 graph 消费 1、
Dispatcher 故障/路由 3、peer 6 均通过。受影响 node/web 类型及 scoped lint 已绿；6 node / 3 测试的两处纯样式问题
仅复查一个 source，随后 Ipc 统计增量只复查该 source 与 node 类型。另 1 node / 7 web / 3 测试 lint 已通过。
脚本遵循仓库 ESLint 忽略规则，以真实故障用例验证，不冒称脚本 lint 通过。历史/CodeMirror 的完整 DOM 异步交互未测，
仅以真实消费链、类型/lint和既有接线断言交付；没有新 DOM 框架、hook 镜像、全量回归、压力矩阵或生产 build。
CodeMirror 基线 3424 行以及 EditorPanel/EditorGroupsPanel/FilePanel 已全文补审；发行两大脚本、打包、Node 资源准备与
部分工程 runner 已全文，剩余缺口仍按细表推进，尚未把全仓标为完成。

观察卡现在采用公开 `ActTurnTrace.request.sequence` 的持久模型请求顺序。成功登记或清除只推进该序号，
清除保留 tombstone；重读旧回合仍可结算它第一次取得的执行目标，但不能覆盖后来登记的观察。
没有用 UUID、抓取时间或另一套运行时计数推断顺序。新增旧回合 pending、更新、清除和重读组合故障及既有脚本 IPC 用例通过。

冷 lazy 编辑器由 CodeMirror 实际安装状态后的 onReady 唤醒。Panel 保留一项导航意图及可取消帧，
请求、项目、文件、组和可见代码面改变时撤销旧 owner；句柄返回实际接纳布尔值后才消费共享请求 id。
GoToLine 在未就绪时保留输入和意图，取消、改输入或转查找会失效。未加轮询或测试专用 ready epoch。
两条既有编辑器组接线断言通过；没有宣称覆盖真实 DOM 的冷加载交互。

正式 lint 的 typed 分区不再让 ESLint 对同一个不可变 Program 反复改文本：只应用首批公开诊断中的
不相交 fix，核对 Program 与输入及落盘前内容，保留 BOM；然后退出该 worker，由新 worker 重建 Program 只读验证。
应用修复返回独立未验证退出码，剩余错误不能报告成功；修复及验证共用原单分区 45s / 2GiB 预算。
实际插件的重叠 import 排序/移除用例验证了单批写入、BOM 唯一、无重复 import、新诊断及旧快照拒绝。
初始夹具加载整个仓库配置触及原 5s 测试限制，缩小为相同已安装插件及最小源码后 118ms 通过，未改预算或断言。

本批共 5 项必要行为/接线检查通过，node/web 类型及 1 node / 2 web / 3 测试文件 scoped lint 通过。
最后仅夹具的 prefer-template 一处写法失败，修正后只复查该文件；其余绿项复用。JS runner 遵循原 ESLint 忽略，
未执行全仓 autofix、完整回归、压力测试或生产构建。跨线程 LSP owner 方案已完成只读审查，实施仍在进行，尚未算解决。

`98885e9` 沿用实际文件 owner 收束“选择所有语义引用”：请求捕获原文档、项目与路径，后继请求、
选区/正文事务、切文件或卸载都会使旧回执失效；fallback 也只用原 identifier。web 类型与该单文件 lint 通过，
没有新 DOM harness 或镜像测试，真实 DOM 异步交互未测。新的团队短游标及已证未修项见
[refactoring-coverage.md](./refactoring-coverage.md)，后续按实际未读生产路径补齐，已审且合理保留的模块不反复找新题。

`ed22db1` 让保存全部返回当前同步 owner 是否仍有草稿，编辑器测试/调试入口只有确认 clean 才启动。
失败、冲突、不可保存的草稿及保存等待中新输入都不能被“Promise 已完成”冒充已落盘；现有逐文件提示保留。
`f9abf60` 在首次 browser snapshot 等待期间若已收到同会话站点通知，保留 live 结果，不让旧快照覆盖。
两处实际调用链及 web 类型/单文件 scoped lint 已核，没有复制 hook 或引入 DOM 测试框架，完整交互未测。

`4de59a1` 将 Git hunk 确认目标保存为原项目/路径/来源/分组及复制的 header/lines，刷新后不按旧 index
重新取块；确认发送前再核当前未保存编辑门，主进程继续用原有 CAS 拒绝已变块。
退役仅三条源码正则、且锁住旧 index 行为的专属 case；既有真实仓库“原块已变拒绝而不猜测”用例通过。
组件/测试 scoped lint 与 web 类型通过，未宣称驱动真实 Dialog。`e6ce7ae` 在非仓库 revision 下不再返回旧 blame，
沿用已有 HeadContent 的同一结果门；单文件 lint 通过，web 类型复用此次检查。

本轮新增完整静态覆盖：PageModel、Controller、项目 session/context index、DebugPanel、浏览器两面板、
EmbeddedKernel/Adapter、main i18n、shared 大合同，以及 Git 全 hooks/13 组件/16 模型和直接 editor/history/refresh 消费。
未发现需要修改的跨组状态、调试暂停序号、变量按需读取、webview 事件解除等约束保留；剩余只接缝与未读路径见短表。

`736f66d` 将行内评论草稿绑定原文件 owner 和真实文档，在外部改写的 ViewUpdate 中先映射范围再发布正文；
删除范围即撤销，旧 popup 提交与测量回执不能操作后继草稿。非删除映射保留已输入评论。web 类型和单文件 lint 通过，
没有新 DOM harness，popup/字体帧交互未实测。

`e4a7ade` 在同一 32 MiB 上限下，先核内联编码字节再解码，外置映射持文件句柄 stat 后做有界读取，
多一个字节判定读取期间增长。既有内联 Unicode 和真实 Node 外置映射断点场景通过，相关 lint、统一 node 类型通过。
`dfc23c7` 删除零生产消费的列表/超时/类型别名和文件变更 identity wrappers；实际事务/编码逻辑保留。
旧摘要 helper 专属断言随死链退役；两条真实编码用例、watch probe 原 16 项断言、相关 lint 与 node 类型通过。
watch 的依赖目录断言现在必须先观察到真实事件，不能靠空数组 every 通过；未扩大原预算或断言数量。

`bfdbfaf` 让慢恢复与发送准备共用真实项目/会话 owner。撤销后旧读取不能替换后继运行；实时与持久流先匹配
inputId/streamId，再推进该运行的 sequence。旧 journal 仅从真实 header 补齐缺失身份，冲突拒绝。
外层恢复生命周期保留；实际 ChatConversationPane 使用项目/会话 key，固定 UI 1.0.0 内部迟到 goal 状态随会话卸载。
恢复撤销与旧日志身份两项必要故障、node/web 类型及 3 node / 3 web / 1 测试 lint 通过；新增 Pane key 后仅复查 web 类型和 Adapter lint。
真实 DOM/native/HMR 连续交互未测，没有增加第二套后端 admission 锁或修改发布包。

本轮额外全文覆盖 PagePresentation、terminal 组件与输出总线、十个聊天卡片/工具窗口、账号/模型 IPC 主体。
外部只读补齐三个编辑器插件和三个 codeGraph UI，共 3338 行，初末 hash 相同；其引用的既有测试仅阅读，未冒称绿项。
编辑器无高置信行为问题，零生产消费者的 hover helper 正在窄删；codeGraph Dialog 三项归属问题进入实施。
LSP main owner 新故障及两个本地协议场景仍在原预算内超时，只有进程终止旧场景通过；node 类型已绿，尚未交付该批。
Markdown 新 SDK 读取故障同样正在定位真实 gate，不能用静态实施冒充完成。

`d515e9f` 交付主线程 LSP 进程 owner：Worker 创建前登记真实 MessageChannel/scope，输入请求同步捕获项目 lease；
worker 只持有有界字节传输，main 保留 ChildProcess、stdio、终止命令和退休 scope 到真实 close。
关闭仍共用原 8 秒绝对期限，普通请求仍为 15 秒。真实 worker 硬终止、本地分块协议、项目隔离/语义/缺工具链等七项必要行为通过。
首轮协议挂起定位为 Bun 的 stdin.write 回调先于返回值，写回执补齐两项事实后才 settle；只复查原失败项，读取算法与原预算保留。

同批 Markdown 将 signal 接到请求级 workspace、SDK token、FS await/循环与解析边界，取消后不缓存读取；
等 run 真正收束再 dispose，成功/失败路径都归一 CANCELLED。三处交互 signal 和 fallback 读盘前准入已接通。
新增真实 SDK gate 故障最初因夹具改写 SDK 冻结对象的 dispose 而提前抛错；改用公开 factory 委托真实 SDK 观察释放后，
原全部断言在 21ms 通过，原 5 秒不变。最终 node 类型、10 node / 12 测试 lint 通过，三处 import 排序只单批写入后 fresh 复查。
无消费的 type-hover helper 与专属测试同批退役；未加新 DOM 框架或依赖。

`836b981` 撤销卸载/失活/上下文变化后的图请求发布，源码仅接纳最新打开意图，图/片段/源码沿用相同草稿优先规则。
`3e5a00a` 仅在录制中捕获键位，真实空格可录；规则读取随清理失效，分析/更新偏好失败被接收并提示，分析只发布 Main 确认值及 revision。
`15ab73d` 删除零调用旧标题行、恒空包装/专属样式、无读者 chrome 字段及文件树 identity wrapper；实际 mutation controller 与 partial-failure 逻辑保留。
三批 web 类型、10 web / 2 测试 lint 和 Space 真实记录/派发用例通过；没有把 DOM 乱序、保存失败 UI 记作实测。

`724ab61` 为安装验收脚本添加单次资源会话，等待实际 close 后交完整流式 UTF-8 输出；命令/终止命令保留 owner，
取消和期限在 120 秒内预留现有 5500ms 关闭窗口。原错误与清理错误分别报告，未确认资源收束时仍注销但保留临时目录。
12 项受控时序/故障和一项真实原生进程用例通过，两个脚本定向严格类型与新测试 lint 通过；首次定向配置误取未安装的 Bun 类型，
改用实际 Node/Electron 脚本环境，未放宽严格规则；实际 stdin=null 类型与诊断 code 联合类型按真实合同修正，行为绿项复用。
Windows 已脱离父链且关闭 stdio 的后代仍非完整保证；保留实际安装/Web/Core/Desktop 入口，未重跑整套安装验收。

精确剩余清单见 [refactoring-remaining.md](./refactoring-remaining.md)。原 renderer 95 个行为源码已合并 31 份回执，
最后 64 路径又全文读取 8209 行且初末 hash 相同；既有生产行为源码的全文证据缺口现为零。
工程最后两项（conversationRuntime 测试入口及外置包清单数据）也已补齐；i18n 大数据、声明/样式、fixture 与运行矩阵另计。

Platform 0.9.3 正式发布身份、tag/source、GitHub 资产 digest、实际归档 SHA/长度及 tar 身份核验通过；
一次 Bun 1.4.3 安装后，三包完整锁身份和新归档上的真实 Node 24.22 取消/关闭/写窗口用例通过。
0.9.1/0.9.2 原字节及回执保留；旧业务绿项没有改称新归档执行。UI 1.0.0 与产品项目/浏览器选择保持原合同。

## 2026-11-09 最后实施与验收

`a5d3ffd` 为 observe/execute 的 UI 预览统一制作有界摘要副本，并在 peer 销毁时移除 watcher 强引用。
实际 Board 八项断言通过，包含冻结 summary、完整 trace 字节及 request/summary 身份保持；相关类型和 lint 通过。
读取原始完整 trace 的既有授权路径保留，未修改模型编译、provider、缓存或执行增量事实。

`49e4399` 交付 AIChanges、Insights、Suggestions、layout、BrowserSite、NewProject、UpdateProgress 的请求归属与事件修复。
`564b14e` 修正 fuzzy 为精确 O(mn) 动态规划，原六项用例及 `axabc`/`abc` 反例通过；矩阵从每格 13 字节变为
16 字节并加 O(n) hull，不能称内存不变；同时退役排序死链。`59bcbcb` 修复根 `/` 路径并退役零消费叶模块和选项。
`48e94c9` 通过语法树识别测试运行器导入，新增三项行为通过。相关类型与定向 lint 已绿，DOM 乱序未实测。

`9c2b932` 让 probe/isolated 宿主保留真实子进程、终止命令、延迟 force 与资源清理 ACK 的 owner。
SIGTERM 前登记后续强杀对同一 PID 集合的责任，实际列举/信号任务、强杀和 onExit 完成后才接收清理回执。
真实 Node 缺回执故障及三条原 entrypoint 夹具通过；实际 Electron/PTY terminal probe 原 17 项断言通过。
构建、运行、关闭与强杀仍在原 120 秒绝对预算内，没有重写 TerminalSessions 原输出/背压算法。

`ff0ea87` 为 lint/formatter 每次请求建立真实短命 Tools Worker，避免 CJS/ESM 传递依赖继续复用旧模块缓存。
同一 Services 上根外 CJS→ESM lint 及 CJS Prettier 依赖变化在 4643ms 内通过，原 5 秒不变，TS 热服务身份保留。
node 类型、18 node / 12 测试 lint、安装验收脚本严格检查与 Vite 配置 lint 通过；只打包新增真实入口，
再以 NativeNode 24 执行真实 Worker lint/format RPC 并确认退出，行为约 7.8 秒，统一 45 秒预算内通过。
每个 isolate 使用既有 H 堆上限；H 不限制两个 isolate 的聚合内存，潜在总量有限增加。
冷配置加载可能在原请求期限内明确失败；任意配置自行脱离 owner 的外部 daemon 不属于线程退出完整保证。

`b9bb6c6` 为树读取捕获原项目、目录与请求身份，在成功、NOT_FOUND 及队列提交处均核当前 owner。
EditorConfig 仅缓存 NOT_FOUND；其他失败按原 Promise 身份移除，不套用父规则，下一次自然请求可以重试。
失败按 AppError 分类并由当前 effect 报告一次。两个 hook lint 及最终 web 类型通过，没有新增镜像 hook/DOM harness。

`d5e6ec7` 以持久任务身份、匹配终态回执和实际进程关闭收束 Windows updater helper。
PowerShell 通过系统 conhost 启动，持有真实 worker Process 句柄；取消停止 ACK 只确认观察者停止，
不能冒充 worker 已退出。主进程等待真实 worker close 并核回执后才回收本任务目录，未知状态保留诊断。
五项必要用例通过：回滚双错与受保护目录两项，原生安装收尾/恢复/错回执/相邻目录一项，原生替换与取消两项。
node 类型、三份 TS 和两份 JS lint 通过。未运行真实应用重启、签名或整套安装矩阵，原测试预算不变。

`aa15f43` 统一生成命令的结构化 process/argv 合同，贯通 terminal/debug、gutter、菜单、配置保存、启动项与重启。
展示文字不再解析后执行；raw command/Node raw args 保留所选实际 shell 语义。每次启动固定实际 cwd 与一次登录环境快照，
叠加请求 env 后在同一快照上解析及启动 Node/Python/CLI；Node inspector 前缀和测试运行器参数位置分别保留。
受支持的完整 npm/cmd-shim 模板按真实安装前缀和 shim 分支解析，Corepack 保留实际选中的 dispatcher，未知 wrapper、
PnP 与非 Node bin 明确失败。launcher 内容单句柄读取上限 64KiB+1；CLI 查询登记真实子进程与终止命令，
共享原 5 秒绝对期限和 64KiB 聚合输出上限，settled 超时不提前释放尚未实际关闭的 owner。

本批 10 项 renderer、10 项 backend（含真实 Node/CDP 控制器集成）通过；三次实际 Electron/PTY 启动验证了含空白、
空参数、`%PATH%`、`$()`、反引号、单双引号及尾反斜杠的字面 argv，raw Git Bash 展开，以及真实 npm 脚本/参数传递。
raw shell 按自身规则改变 PATH，测试核对实际选中 Node 身份；不错误要求 shell 启动后 PATH 字节不变。
最后一次 NativeNode 24 npm-prefix 查询故障在就绪时关闭终端 owner，789ms 内确认查询和终止命令实际 close，
启动为 CANCELLED、零 PTY 输出且未到达 CLI；原 5 秒用例不变。node/web 类型与全部改动源码/测试定向 lint 通过。
实际 Corepack 下载/版本、跨 OS 及 DOM 连续交互未运行；没有完整构建、全量回归或再次安装依赖。

截至 `2836ee1`，既有生产行为源码全文阅读剩余为零，以上新增实现另按差量审阅；当时剩余接入项是下一份
固定正式 Core observe 包。用户已确认保留 observe 的小状态/摘要/差量/引用，动态上下文与历史由 Core 提供；
收到正式身份后才转发真实 `ShellHostPort.observationSupport()`，不在旧 0.9.3 上补造支持声明或改写 provider 前缀缓存。

## Platform 0.9.4 最终接入

正式 `v0.7.5` / `1b0004d773ac54c9f20f3748f9f4baed021a6481` 的基础、能力包均固定为 0.9.4。
独立核验官方公开状态、tag/source、asset digest、下载 SHA256/SHA512/长度、tar 包身份及精确 peer 后，
执行一次 Bun 1.4.3 安装；三包完整锁身份通过，UI 1.0.0 和产品 workspace/session 归属保持原合同。
两包版本为 0.9.4，归档的平台代际仍为 0.7。

宿主仅增加一行真实 `observationSupport()` 转发。公开宿主端口为可选方法，本地工厂实际提供实现；转发与既有
runObservationCommand 一样保留真实方法调用，不生成默认支持值。当前模型配置使用公开 AI SDK driver，
容量包装不拆分请求；生产代码没有 compiledPrompt 旧帧标记读取，静态容量夹具保留。
历史/动态区/采集预算/消息布局/指纹与缓存由新 Core/SDK 提供，未在产品重建。

node 类型、web 类型及唯一修改 TS 文件的 scoped lint 通过。新归档的真实 NativeNode 用例增加同一宿主支持查询断言：
Windows 无额外只读后端时 available 为 false，普通 exec 继续完成项目编辑、原生进程输出、IDE 通知和资源收尾。
原 30 秒测试中行为约 2397ms、夹具全过程约 20.2 秒通过；只运行这一条，旧 PTY/CLI 取消/调试绿项复用。
原 45 秒/2GiB 类型与 lint 分区保留；下载不占共享锁，安装与定向验证沿既有锁串行。

0.9.1/0.9.2/0.9.3 原字节与回执保持历史身份，发布方 Linux 归档证明未改称本地 Windows 采集证据。
没有全量回归、完整生产构建、新跨 OS/供应商缓存/模型选择率或签名安装矩阵。已知源码修复、审计记录和此次正式接入均已收口。

## Platform 0.9.5 包装查询修复接入

2026-11-10 固定正式 `v0.7.6` / `70e93a2b8c020ad7509a9fb2d8eb3f7a754664a7` 的配套 0.9.5 归档。
独立核验公开 Release、tag/source、资产 digest、实际下载字节的长度/SHA256/SHA512、tar 身份和精确 peer；
基础 SHA256 为 `8d8bc25d98bda5ab207c6bae05151922df77c23d1494a6e5cab17273d3db3b2b`，
能力 SHA256 为 `f576132e2309413d333a2671e3d2e7c333c8a183914fc5941e5939787cfe6601`。
两包第三方依赖声明与 0.9.4 相同，UI 1.0.0 保持原身份。

实际装配未传 `packageEnvironment`，固定 Node 包目录不等同动态环境 registry；RuntimeBootstrap 不会对本产品调用
`withPackageEnvironment()`。本批无产品源码修改，也没有兼容或默认支持兜底。
公开 Node runner 返回类型加强、project 版本字面量更新，因此仅补一个 node 类型分区，1.7 秒通过；一次安装及完整三包锁检查通过。
没有重跑 web/lint、真实 Node、PTY、CLI 或构建；这些旧绿项和旧 Linux 回执均保持原版本身份。
发布方对同正式基础归档的查询转发、JS、严格声明证据覆盖本次 Core 修复，不冒称 Workbench 实际只读采集。
