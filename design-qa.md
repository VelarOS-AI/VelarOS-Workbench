# Workbench Shell Design QA

## 对照基准

- source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-374d25fd-d4f3-4388-ba57-18b696e0daba.png`
- implementation screenshot: `/tmp/workbench-vs-icon-js-ts-final.png`
- full-view comparison: `/tmp/workbench-project-header-comparison.png`
- focused comparison: `/tmp/workbench-project-header-focused-comparison.png`
- viewport: 1280 × 800 CSS px
- source pixels: 2560 × 1600
- implementation pixels: 2560 × 1600
- density normalization: 两侧均按 devicePixelRatio 2、相同像素尺寸直接对照，无缩放
- state: macOS 浅色主题，项目已打开，文件栏展开，搜索栏收起
- annotation handling: 源图红框属于用户标注，不作为产品视觉元素还原；后续“VelarScript 图标参考 JS / TS，使用黑色 VS”要求覆盖源图中的旧 V 图标

### Git 双入口补充基准

- source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-bd7a18c9-2bc1-4501-b2d1-c941d6f35dbf.png`
- implementation full-view: `/tmp/workbench-git-log.png`
- implementation focused state: `/tmp/workbench-git-submit.png`
- viewport: 1280 × 800 CSS px
- source pixels: 2560 × 1600
- implementation pixels: 2560 × 1600
- density normalization: 两侧均为 devicePixelRatio 2，相同视口与像素尺寸，无缩放
- state: macOS 浅色主题，项目已打开；提交面板在左侧，Git 日志面板在底部
- intent normalization: 源图记录的是用户指出的回归态；最终职责以拆分前 Desktop 源码中的上方 `GitCommit` / 下方 `GitBranch` 双入口为设计真值，源图用于核对整体尺寸、位置、密度和底部工具窗样式

### 提交面板收口补充基准

- source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-a017e911-8092-4b43-ab67-657b1a357a04.png`
- implementation screenshot: `/tmp/workbench-commit-input-contained.png`
- viewport: 1280 × 800 CSS px
- source pixels: 2560 × 1600
- implementation pixels: 2560 × 1600
- density normalization: 两侧均为 devicePixelRatio 2、相同视口和像素尺寸，无缩放
- state: macOS 浅色主题，`openvoxel` 项目已打开，左侧提交面板展开
- intent normalization: 源图中的红框仅指示输入框越界；标题右侧数字与目录级未跟踪项属于本轮明确要求移除的回归表现。实现列表展开为真实文件，因此文件数量和编辑器内容与源图不同，不作为视觉漂移。

### 聊天一致性补充基准

- empty-state source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-156861c0-5653-4859-b6d3-a48d6668ac27.png`
- attachment-chip source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-d6ea88bc-ac50-4f07-bf3e-524264629fe8.png`
- composer-plus source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-8bcd16a0-c493-4ac1-9e3b-89c15e8b0ae6.png`
- session-alignment source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-9003b298-41d6-47a0-a955-5c7b246566a7.png`
- header-height source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-3ea41754-e257-4572-9bff-b9fa64ad3b9c.png`
- Git-header source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-64b50ecf-a47e-4c27-8dc6-949460782bda.png`
- implementation empty state: `/tmp/velaros-workbench-source-chat-empty.png`
- implementation chip hover: `/tmp/velaros-workbench-source-chat-chip-hover.png`
- implementation plus menu: `/tmp/velaros-workbench-source-chat-plus-menu-final.png`
- implementation aligned header: `/tmp/velaros-workbench-source-chat-header-aligned.png`
- implementation Git header: `/tmp/velaros-workbench-source-git-header.png`
- viewport: 999 × 624 CSS px
- implementation pixels: 1998 × 1248
- density normalization: 实现按 devicePixelRatio 2 截图；源图为同一台 macOS 显示器上的 2× 图像，原生窗口边框可能产生 1px 裁切差异，因此只比较 renderer 内容区
- state: macOS 浅色主题，`openvoxel` 项目已打开，聊天侧栏展开且为空会话
- annotation handling: 源图红框仅标示用户指出的目标区域，不作为产品视觉元素还原

### 动态帆船空态补充基准

- source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-3edee075-6c8d-4fa9-91d7-64cc4d994f82.png`
- implementation screenshot: `/tmp/velaros-workbench-source-chat-sail.png`
- packaged implementation screenshot: `/tmp/velaros-workbench-packaged-chat-sail.png`
- viewport: 999 × 624 CSS px
- source pixels: 1998 × 1247
- implementation pixels: 1998 × 1248
- density normalization: 两侧均为 macOS 2× 图像；1px 高度差来自原生窗口边框裁切，比较时只核对 renderer 内容区
- state: macOS 浅色主题，项目已打开，聊天侧栏为空会话，当前文件 chip 可见
- intent normalization: 上方红框要求移除气泡图标和标题、改用现有动态小帆船；下方红框要求移除常驻的模型配置错误行。红框本身不属于产品视觉。

### Markdown 控件与文件图标补充基准

- Markdown action source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-5dd3c0a0-b1fe-49b8-befe-4dc76924d9b6.png`
- `.gitignore` icon source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-060fb43f-2ab3-499f-884a-333b0f2a399f.png`
- packaged implementation screenshot: `/tmp/workbench-qa-final-markdown-icons.png`
- Markdown action comparison: `/tmp/workbench-design-qa-border-comparison.png`
- file icon comparison: `/tmp/workbench-design-qa-icon-comparison.png`
- viewport: 999 × 624 CSS px
- implementation pixels: 1998 × 1248
- density normalization: 实现与源图均来自同一台 macOS 2× 显示环境；聚焦对照只比较被标注控件与图标，不把源图红框作为产品元素
- state: macOS 浅色主题，最终打包应用打开 Workbench 源码项目，README 处于渲染预览态，文件树展开到项目根文件
- intent normalization: Markdown 代码块保留下载与复制两个独立图标按钮，但移除包围两者的外层边框；`.gitignore` 使用真实 Phosphor circle-slash 图标。核心只为 JS / TS / JSX / TSX / VelarScript 提供语言专属图标，其他通用文件使用类型图标，框架与额外语言留给插件贡献。

### 欢迎页文案与 Kernel 信息补充基准

- Kernel row source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-452af355-49a3-4567-808c-7221a1c2d1e9.png`
- subtitle source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-a6d1d02e-a700-424f-9318-ca55750653ba.png`
- packaged implementation screenshot: `/tmp/workbench-welcome-final.png`
- full-view comparison: `/tmp/workbench-welcome-comparison.png`
- focused comparison: `/tmp/workbench-welcome-focused-comparison.png`
- viewport: 1280 × 800 CSS px
- source pixels: 2560 × 1600
- implementation pixels: 2560 × 1600
- density normalization: 两侧均为 devicePixelRatio 2、相同视口与像素尺寸；focused comparison 使用相同坐标裁切，不缩放目标区域
- state: macOS 浅色主题、欢迎页；实现使用隔离用户数据，因此最近项目为空，左右项目数据差异不参与本轮欢迎区判断
- intent normalization: 源图红框只标出应删除的 Kernel 状态行和应替换的副标题，不作为产品元素；其余标题、按钮、间距和位置应保持原状

## Findings

最终对照没有遗留 P0/P1/P2 问题。

- 字体与层级：沿用 Workbench 系统 UI 字体；项目名使用 11.5px/600，清楚但不压过编辑器标签。
- 间距与布局：项目标题区与编辑器标签栏实测均为 35px；macOS 左侧保护区为 48px，图标与名称没有侵入交通灯区域；文件树从顶级文件开始，不再重复项目根名称。
- 颜色与视觉令牌：标题区和标签栏背景实测均为 `rgb(248, 248, 248)`，边界与现有 Workbench 令牌一致。
- 图标与资源：文件夹、搜索等通用图标继续使用现有 Phosphor 图标；VelarScript 使用与 Phosphor `FileJs` / `FileTs` 相同的文件轮廓、折角、尺寸和视觉重量，只将内部字样换为黑色 `VS`。标签位保持 13px、文件树位保持 15px，不再出现横向过宽的旧 V 图形或偏小的裸文字。
- 文案与内容：标题区显示真实项目名 `openvoxel`；搜索按钮保留可访问名称；文件树内不重复显示项目名。
- 交互：搜索按钮可展开并自动聚焦输入框，输入框无聚焦高亮框，也没有单独关闭按钮；左侧文件夹按钮可隐藏并恢复文件栏。
- 运行状态：上述交互期间未捕获到渲染异常或错误日志。
- 标签滚动：在 115px 的真实溢出区间连续发送右向触控板输入，位置序列为 `30 → 60 → 90 → 115 → 115`，到达右端后保持稳定，没有回弹或反向位移。
- 设置下拉：外部点击后下拉内容立即卸载，`body` 的指针锁从 `none` 恢复为空值；随后实点“编辑器”分类成功切换，页面交互没有被残留面板拦截。
- Git 双入口：左上 `GitCommit` 单独打开 310px 宽的提交面板，包含变更选择、提交说明、生成、回滚、提交和推送；左下 `GitBranch` 只打开底部分支/日志/详情视图。底部实现中提交编辑器节点数量为 0，不再出现职责合并。
- Git 展开行为：提交按钮再次点击可关闭左面板，实测 `data-file-panel-open` 从 `true` 变为 `false`；随后项目按钮可恢复文件树。Git 按钮再次点击可独立收起底部面板。
- 提交面板收口：提交说明输入框实测边界为 `left 48 / right 402 / width 354`，表单边界为 `left 38 / right 412 / width 374`，左右各保留 10px，未侵入编辑器；标题区域的可见文本仅为“提交”，数字徽标节点为 0。
- 未跟踪项粒度：未跟踪目录已展开为真实文件路径；实机列表共显示 50 个文件项，目录结尾路径数量为 0，目录本身不再作为文件计数或提交项。
- 聊天空状态：空白区使用共享组件库现有的 `VelarSailMark` 动态小帆船，并保留三条可点击起手建议；旧气泡图标和“从这个项目开始”标题均已移除。帆、桅杆和船体分别运行共享的 steady 动画，没有复制或重画品牌资产。
- 聊天输入区：左下角恢复 Desktop 同款“添加文件和能力”加号；菜单严格只显示“添加照片和文件”“计划模式”“目标模式”，没有插件、技能、快捷建议或编辑器控制等额外入口。右侧模型、语音和发送入口保持原位，输入卡片没有被额外控件挤压。
- 当前文件 chip：默认显示 Phosphor 文件图标，悬浮后同一位置切换为 `X` 图标；点击后 chip 节点立即移除。图标状态切换不改变 chip 尺寸，因此没有文字跳动。
- 会话标题：`新对话` 按钮的实测 `justify-content` 为 `flex-start`，标题内容从聊天栏左侧起排，不再居中悬浮。
- 顶栏高度：编辑器标签栏与聊天标题栏的 DOM 实测均为 `top 0 / bottom 35 / height 35`；两侧背景和底部分隔线落在同一条水平线上，标题与操作按钮在各自栏内垂直居中。
- 执行模式：计划模式和目标模式的共享开关均实测完成 `unchecked → checked → unchecked`，并最终恢复关闭状态；选择结果会进入 Agent 的 `executionModes`，不是仅有视觉反馈的空开关。
- Git 标题：底部面板标题区可见文本仅为 `Git`，重复的“日志”会话按钮节点已移除；日志内容仍保留在面板主体中。
- 起手建议交互：点击“了解项目”后，输入框写入完整建议内容并进入发送校验；在未配置 API 密钥的开发态正确显示模型配置提示，没有静默失效。
- 视口边界：验证视口内 `documentElement.scrollWidth === innerWidth`，聊天补充控件没有制造页面级横向滚动；产品现有桌面最小宽度策略不在本轮改动范围内。
- 运行状态：完整交互路径没有捕获 renderer exception 或 console warning/error。
- 模型配置提示：输入卡片上方不再渲染常驻红色错误行；缺少模型配置时保留用户输入，不增加会挤压输入区域的提示节点。
- Markdown 代码块操作区：最终打包应用中 `data-streamdown='code-block-actions'` 的计算样式为 `border-width: 0px`、`box-shadow: none`；下载与复制按钮仍可见，外层不再形成第三个嵌套边框。
- Markdown 项目链接：复用 `@velaros-ai/ui` 的 Streamdown 渲染与安全插件，同时由 Workbench 自己校验项目内相对路径；最终包中相对链接正常显示为链接，不再出现聊天场景的 `[blocked]` 文案。
- 文件图标：`.gitignore` 使用 Phosphor `Prohibit` 的圆圈斜杠；`.npmrc`、锁文件、补丁、JSON、Markdown、图片、音频、压缩包等常用文件均使用真实图标库资源，不再统一回退为默认文件图标。
- 生态边界：内建语言专属图标限定为 JS / TS / JSX / TSX / VelarScript；Vue、Python 等未内建框架或语言不会伪装成已支持，统一走通用 code 图标。文件展示解析器提供注册入口，后续插件可贡献新的文件匹配规则和图标种类。
- 欢迎页信息层级：底部 `Kernel：内置宿主（随 Workbench 运行）` 已从渲染树和样式表同时移除；副标题改为“构建你的下一个项目。”，不再重复“打开项目”按钮的动作。
- 欢迎页布局稳定性：删除 Kernel 行后以 211px 的 hero 最小高度保留原有垂直构图。旧包 title top 为 `294.5547px`，最终包为 `294.5px`；actions top 由 `373.9453px` 到 `373.8906px`，偏差小于 0.06px，属于子像素取整而非视觉漂移。

## Comparison history

- Pass 1: `/tmp/workbench-project-header-v1.png`。发现 [P2] 标题区为 34px、编辑器标签栏为 35px，与“高度对齐”的明确要求相差 1px。
- Fix: 将标题区固定高度和 flex 基准统一为 35px。
- Pass 2: `/tmp/workbench-project-header-final.png`。实测两侧均为 35px，背景、分隔线和顶部起点一致；P2 已关闭。
- Pass 3: `/tmp/workbench-vs-icon-final.png`。按后续要求把 VelarScript 旧 V 图形替换为 `VS` 字标；文件树、标签栏和底部路径均已实机显示，旧图标数量为 0。
- Pass 4: `/tmp/workbench-vs-icon-js-ts-final.png`。根据“太小”和“参考 JS / TS”的反馈，将裸 `VS` 改为同系列文件图标：黑色文件轮廓内嵌 `VS`，实机检查标签栏、文件树及状态栏均为 SVG 图标，旧 V 图标数量仍为 0。
- Pass 5: 修复顶部标签栏滚动边界和设置下拉退出状态。实机连续右滚到最大值后位置保持不变；设置下拉点外部后内容节点数量从 1 变为 0，页面指针锁释放，后续分类点击生效。
- Pass 6: `/tmp/workbench-git-log.png` 与 `/tmp/workbench-git-submit.png`。发现并关闭 [P1] Git 提交与历史被错误合并到底部大面板的问题：恢复左上提交入口及左侧提交面板，底部 Git 仅保留历史；相同 1280 × 800 视口下，两块面板与既有 rail、编辑器和状态栏对齐，无裁切或重叠。
- Pass 7: 源图与 `/tmp/workbench-commit-input-contained.png` 在同一对照输入中检查。关闭 [P1] 提交说明输入框右侧越出左栏的问题：宽度由 374px 收到 354px，并在 374px 表单内保留完整 10px 右边距；同时移除标题数字徽标，并把未跟踪目录展开为文件。字体、间距、颜色、现有图标资源和“提交”文案均与既有 Workbench 令牌保持一致，无新增 P0/P1/P2 差异。目标区域在 2× 全图中清晰可读，因此不需要额外裁切对照。
- Pass 8: 将聊天空态、当前文件 chip、输入区加号、会话标题和 Git 标题的源图与 `/tmp/velaros-workbench-source-chat-empty.png`、`/tmp/velaros-workbench-source-chat-chip-hover.png`、`/tmp/velaros-workbench-source-git-header.png` 放入同一视觉对照输入。恢复缺失内容与控件，关闭 [P1] 空白聊天不可引导、[P2] chip 无法移除、[P2] 会话标题居中和 [P2] Git 标题重复问题；点击、悬浮、删除与缺少模型配置时的失败反馈均已实机验证，无新增 P0/P1/P2 差异。
- Pass 9: 将最新源图与 `/tmp/velaros-workbench-source-chat-sail.png` 放入同一视觉对照输入，并在打包后使用 `/tmp/velaros-workbench-packaged-chat-sail.png` 复核最终产物。关闭 [P2] 空态品牌图形错误和 [P2] 输入区错误提示占位问题：气泡与标题替换为共享 `VelarSailMark` 的 small/steady 状态，帆、桅杆、船体均检测到持续动画；输入卡片中 `role=alert` 节点数量为 0。打包产物与源码预览的字体、卡片间距、灰阶令牌和起手建议文案一致，无新增 P0/P1/P2 差异。
- Pass 10: 将 chip 源图、最新顶栏高度标注图与 `/tmp/velaros-workbench-source-chat-chip-hover.png`、`/tmp/velaros-workbench-source-chat-plus-menu-final.png`、`/tmp/velaros-workbench-source-chat-header-aligned.png` 放入同一视觉对照输入。当前文件 chip 继续使用共享 Desktop 位置和样式，仅补齐悬浮删除；加号菜单收口为文件图片、计划、目标三个入口；聊天标题栏由 39px 调整为 35px，与编辑器标签栏的上下边界完全一致。交互与实测尺寸均通过，无新增 P0/P1/P2 差异。
- Pass 11: 将 Markdown 控件源图与最终打包截图放入 `/tmp/workbench-design-qa-border-comparison.png`，并将 `.gitignore` 图标源图与实现放入 `/tmp/workbench-design-qa-icon-comparison.png`。实测外层操作组边框为 0，两个功能按钮仍保留自身交互轮廓；`.gitignore` 的圆圈斜杠轮廓、灰阶与尺寸匹配参考，旁边 `.npmrc` 和锁文件也已使用不同的真实类型图标。无新增 P0/P1/P2 差异。
- Pass 12: 首次删除 Kernel 行后，实测欢迎区因父级垂直居中向下移动 21.75px，记录为 [P2] 构图漂移。给 hero 保留原始 211px 高度后重新打包，并把两张源图与 `/tmp/workbench-welcome-final.png` 合并到 `/tmp/workbench-welcome-focused-comparison.png`。最终标题与按钮位置相对旧包差异均小于 0.06px；Kernel 文案节点为 0，新副标题清晰且没有换行，P2 已关闭。

## Open Questions

- 无。

## Implementation Checklist

- [x] 左上保留 macOS 窗口按钮保护区
- [x] 项目名进入顶部标题区
- [x] 与右侧编辑器标签栏精确等高
- [x] 去除文件树中的重复项目根行
- [x] 搜索入口收进标题区并保持可用
- [x] 文件栏开关保持可用
- [x] VelarScript 图标统一为与 JS / TS 同系列的黑色 VS 文件图标
- [x] 顶部标签栏滚动到边界后不抖动、不反向
- [x] 设置下拉支持点外部关闭并释放页面交互
- [x] 左上恢复独立提交按钮与提交面板
- [x] 左下 Git 按钮仅展示分支与提交历史
- [x] 左侧提交面板与文件面板分别可开关，互不污染底部 Git 状态
- [x] 提交说明输入框严格收在左侧面板内
- [x] 移除“提交”标题右侧的变更数字徽标
- [x] 未跟踪目录展开为真实文件，目录本身不计数
- [x] 空白聊天使用共享动态小帆船并保留三条起手建议
- [x] 移除空态标题和输入卡片常驻模型错误行
- [x] 输入框左下角恢复添加文件加号
- [x] 加号菜单仅保留文件图片、计划模式和目标模式
- [x] 当前文件 chip 悬浮切换为删除图标并可移除
- [x] 聊天会话标题左对齐
- [x] 聊天标题栏与编辑器标签栏上下边界精确对齐
- [x] Git 底部标题移除重复“日志”按钮
- [x] Markdown 代码块操作组移除外层根边框
- [x] Markdown 项目内相对链接正常渲染
- [x] `.gitignore` 使用圆圈斜杠图标
- [x] 常用配置、锁文件、补丁、文档、媒体和数据文件使用对应类型图标
- [x] 内建语言专属图标收口为 JS / TS / JSX / TSX / VelarScript
- [x] 文件图标解析保留插件贡献入口
- [x] 欢迎页移除面向实现细节的 Kernel 状态行
- [x] 欢迎页副标题改为“构建你的下一个项目。”
- [x] 删除状态行后保持标题和按钮的原始垂直位置

## Follow-up Polish

- 无阻塞项。

final result: passed
