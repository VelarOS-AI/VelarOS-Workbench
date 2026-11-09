# Workbench → Platform 0.9.0 接入需求

## 空闲会话控制缺口

实际调用：

- `src/main/conversation/WorkbenchConversationRuntime.ts:316` listNotes、`:325` readNote、`:346` getGoal、`:350` controlGoal。
- 同文件 `:428` withSessionControl：活跃时借现有 session；空闲且已有数据时在 `:460` 打开控制 lease，操作后 finally close。
- `src/main/conversation/WorkbenchConversationSession.ts:287` openControl：目前通过无模型 createRuntime/openSession 读取原状态，不执行输入。
- `src/main/conversation/WorkbenchConversationIpc.ts` 先从发起窗口当前 ProjectHub 核验项目，再调用上述方法。

当前可用公开接口是根 `createRuntime` / `VelarosRuntime.openSession` 和
`VelarosSession.listNotes/readNote/getGoal/controlGoal`。新 Runtime 必须有 storage、binding、
node 或 runner，SessionExecutionBinding 又要求真实模块 instance/generation 完全一致。
Workbench 的空闲入口没有上一轮 request/model/权限选项，不能为读笔记重造 sessions/browser 等执行能力，
也不能读私有 runtime:binding 记录后造伪实现来匹配。

需要的公开行为（命名和实现由 Platform 决定）：

1. **允许打开/恢复已有新代际会话的控制 lease**，只读笔记/目标，或以 baseRevision 执行现有 GoalControl。
   不需要模型、Node/runner、浏览器页面或领域可执行实现；不调用 submit，不启动 Agent，不重新接纳历史输入。
2. 产品提供已核验的不透明 executionIdentity/authorizationScope、sessionId 和存储。核心仍核验恢复边界，
   不改绑、不扩大旧授权；若还需要模块身份清单，请给公开可核验的获取/传递合同，不能要求产品读私有记录。
3. 应用重启后仍可读最后一次成功运行的笔记和目标；读操作不创建另一套执行 owner。
   controlGoal 的 resume 在这里仅改变原有控制状态，不自行启动模型；执行继续走产品发送链。
4. 保留原方法的分页、note key/revision、GoalControl.baseRevision 冲突、NOT_FOUND 和持久化错误语义；
   lease 能明确关闭。Workbench 保留每会话串行控制和删除/关闭排斥。
5. 从未运行：产品现有 getGoal 返回 null、listNotes 返回空页；readNote/controlGoal 报不存在，不因查询创建空会话。
   旧 runtime:workspace 不走兼容恢复；产品切新存储代际，旧界面历史仍保留。

若现有公开接口已经能安全做到以上行为，请给调用组合与边界证明；Workbench 不要求特定新函数名称。

## 一次接入所需归档

两份必须配套；Workbench 使用项目/代码/图像、浏览器、网页和产品会话协作，不能仅接基础包。

来源：Platform commit `697bcba2fdff5b7160116a7c936876df8bf4abb2`。
receipt：`D:/Projects/VelarOS-Platform/.velaros-workspace/candidates/platform-0.9.0-ba4c31c4-7455cef2/candidate.json`。

| 安装身份 | 版本 | 归档 | SHA256 |
| --- | --- | --- | --- |
| @velaros-ai/velaros | 0.9.0 | velaros.tgz | ba4c31c49582380d84f63b884c44bc2fbd4897bb45bbda6a33ad68f1aa789045 |
| @velaros-ai/capabilities | 0.9.0 | capabilities.tgz | 7455cef23df7acab4db1c3e74d7bb036a480a5012000283c8a88e1add49af355 |

receipt 已给全量 SHA512 integrity、大小及 638 输入与提交树的核对证明；这是冻结的本地候选，
保留打包前 dirty 来源证据，不称为已发布的 registry/GitHub Release。owner 已验证 Windows JS/严格声明；
Linux 和供应商 API 仍未覆盖。消费时复制到 Workbench 自己的哈希目录并验字节，不链接兄弟仓 node_modules。

切换范围：manifest/lock/快照来源；专项 import → capabilities；Node 工厂 → velaros/node；显式项目端口、
context source/snapshot、worker/memory/widget 装配；执行身份与授权 scope；新会话数据代际；发行外置包闭包。
继续使用 WorkbenchShellHostRegistry 唯一应用级 Host，产品项目/浏览器选择、登记和权限策略不进入核心。
