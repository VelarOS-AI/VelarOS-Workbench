/**
 * 渲染进程的全局样式表，按级联顺序排好：共享 UI 包的设计令牌 → 共享原语 → 跨产品共享层 → Workbench
 * 自己的全局层（Tailwind 入口、滚动条、少量对共享原语的全局修正）。
 *
 * 产物里样式按模块求值顺序拼接，同特异性的规则后写者胜。main.tsx 必须第一个导入本模块，全局样式表
 * 才会排在所有应用模块之前，Workbench 与共享包各组件的 CSS Module 都落在原语之后，产品样式覆盖原语，
 * 而不是反过来被 `.velar-button-size-icon-sm`、`.velar-text-tone-default` 这类同为单类的全局原语盖掉。
 * 本模块是副作用导入，import 排序规则把它排在所有具名导入之前；四张表放在这里而不是 main.tsx 末尾，
 * 就是为了这个位置。
 */
import '@velaros-ai/ui/styles/tokens/design-tokens.css'
import '@velaros-ai/ui/styles/components/index.css'
import '@velaros-ai/ui/styles/components/product.css'
import './index.css'
