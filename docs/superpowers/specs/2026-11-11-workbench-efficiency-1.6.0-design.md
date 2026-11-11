# EnvDock 1.6.0 工作台效率闭环设计

> 设计日期：2026-11-11  
> 目标版本：1.6.0  
> 设计依据：`EnvDock-UI更新空间评估.md`、`docs/releases/v1.5.0.md`

## 1. 目标与范围

1.6.0 聚焦工作台高频操作闭环，让接口调试在多标签、窄窗口和键盘操作场景下更顺手：

- 关闭接口标签后，可通过 `Ctrl/Cmd+Shift+T` 恢复最近关闭的标签；
- 增加命令面板，集中发现和执行高频操作；
- 增加快捷键总览，说明当前已支持的快捷键；
- 响应搜索只在响应上下文内响应 `Ctrl/Cmd+F`，请求编辑器和工具窗口不被抢占；
- 分屏拖拽比例继续按本机偏好保存，双击分隔条恢复当前布局的默认值；
- 针对 1000×700 最小窗口与 dark、light、soft、dusk 四套主题补齐回归检查，必要时只做局部样式修正。

本版不改 SQLite 表结构、Tauri IPC 命令、请求执行协议、响应缓存格式、项目交换格式和临时请求数据模型。临时请求标签继续沿用现有独立内存模型，本版的“最近关闭标签”只针对普通项目接口标签。

## 2. 用户行为

### 2.1 最近关闭标签

- 普通项目接口标签关闭后，记录项目 ID、接口 ID 和关闭前的标签位置。
- 最近关闭记录只保存在当前应用会话内，最多保留 20 条；退出应用、重新加载工作区或接口被删除后，失效记录自动丢弃。
- `Ctrl/Cmd+Shift+T` 只在没有输入框、文本域、代码编辑器、下拉框、弹窗和右键菜单获得焦点时生效。
- 恢复动作只针对当前项目。当前项目没有可恢复记录时不改变页面、不弹出空提示。
- 恢复成功后把接口插回原标签位置，切换到该接口并保持原有草稿、响应和环境选择。
- 从左侧重新打开一个已关闭接口时，清除该接口对应的失效恢复记录，避免再次恢复出重复标签。
- “关闭其他”“关闭右侧”“关闭全部”按实际关闭的标签分别记录；快捷键每次恢复最近的一条。
- 如果自动保存失败，关闭动作保持现有行为，恢复栈不提前写入。

### 2.2 命令面板

- 使用 `Ctrl/Cmd+Shift+P` 打开，`Esc` 关闭，输入关键词过滤。
- 面板提供可执行动作和快捷键说明入口，支持上下键移动、`Enter` 执行、`Home/End` 跳转。
- 首版动作包括：
  - 保存全部修改；
  - 恢复最近关闭标签；
  - 新建临时请求；
  - 打开 JSON 工具；
  - 打开临时开发工具箱；
  - 打开请求时间线；
  - 打开设置；
  - 切换上下 / 左右分屏；
  - 收起 / 展开接口侧栏；
  - 打开快捷键总览。
- 当前状态不允许的动作显示为禁用态，并说明原因，例如正在发送请求或工作区仍在加载。
- 命令面板不执行删除、清空数据、生产发送等需要二次确认的破坏性动作；这些动作继续通过现有界面和确认流程完成。
- 面板打开时，底层页面不接收快捷键；关闭后将焦点还给打开面板前的元素。

### 2.3 快捷键总览

快捷键总览使用只读弹层，按“导航、工作台、标签、请求与响应、工具”分组展示：

| 分组 | 快捷键 | 动作 |
|---|---|---|
| 工作台 | `/` | 聚焦接口搜索 |
| 工作台 | `Ctrl/Cmd+K` | 聚焦接口搜索 |
| 工作台 | `Ctrl/Cmd+S` | 保存全部修改 |
| 工作台 | `Ctrl/Cmd+Shift+P` | 打开命令面板 |
| 工作台 | `Ctrl/Cmd+Shift+T` | 恢复最近关闭标签 |
| 请求 | `Ctrl/Cmd+Enter` | 发送当前请求 |
| 响应 | `Ctrl/Cmd+F` | 搜索响应正文 |
| 标签 | `Ctrl/Cmd+W` | 关闭当前普通接口标签 |
| 工具 | `Esc` | 关闭当前搜索、菜单或弹层 |

弹层中的快捷键说明必须与实际事件绑定共用同一份定义，避免只更新文案而忘记实现。

### 2.4 响应搜索上下文

- `Ctrl/Cmd+F` 仅在焦点位于响应面板、响应代码编辑器或响应工具栏时打开响应搜索。
- 请求正文编辑器、普通输入框、JSON 工具、临时开发工具箱和设置表单继续使用浏览器 / 编辑器自身的查找行为。
- 响应搜索打开后自动聚焦搜索框；`Esc` 清空并关闭；已有高亮和匹配数量规则保持不变。
- 没有响应时不打开响应搜索，避免出现没有内容的搜索框。

### 2.5 分屏尺寸

- `editorHeight` 和 `editorWidth` 继续使用现有本机偏好存储，不增加数据库字段。
- 上下分屏双击分隔条恢复 `DEFAULT_PREFERENCES.editorHeight`；左右分屏双击分隔条恢复 `DEFAULT_PREFERENCES.editorWidth`。
- 键盘 Home / End、方向键、Shift 加速拖动保持现有行为。
- 1000×700 时限制响应工具栏和请求工具栏的溢出，正文区域优先保留滚动空间。

## 3. 设计与调用链

### 3.1 标签恢复模型

在 `useWorkbench` 内增加会话级恢复栈，不写入 `Workspace`：

```ts
type ClosedTab = {
  projectId: string;
  requestId: string;
  index: number;
};
```

`closeTabs` 在 `switchContext` 成功后按关闭前 `openTabs` 的顺序写入栈；栈按最近关闭时间倒序保存，超过 20 条淘汰最旧记录。`restoreClosedTab` 取当前项目最近一条有效记录，验证接口仍属于当前项目后插回标签列表。`selectRequest` 在主动打开接口时移除相同接口的恢复记录。

工作台模型暴露：

```ts
restoreClosedTab: () => Promise<boolean> | boolean;
canRestoreClosedTab: boolean;
```

返回值用于命令面板和快捷键判断，不通过通知打扰用户。

### 3.2 全局命令与快捷键

新增纯数据定义 `src/lib/commands.ts`，统一维护：

```ts
type CommandId =
  | 'save'
  | 'restore-closed-tab'
  | 'open-temporary'
  | 'open-json-tools'
  | 'open-dev-tools'
  | 'open-history'
  | 'open-settings'
  | 'toggle-layout'
  | 'toggle-sidebar'
  | 'open-shortcuts';
```

命令定义只描述标题、关键词、分组、快捷键和执行前置条件；执行函数由 `App.tsx` 注入，避免纯数据模块依赖 React 状态。命令面板渲染这份定义，快捷键总览也渲染同一份定义。

全局事件处理继续放在 `App.tsx` 的捕获阶段，但补充以下规则：

1. 先判断当前是否有命令面板、快捷键弹层、设置、JSON 工具、开发工具箱、时间线或确认框；
2. 排除 `input`、`textarea`、`select`、`[contenteditable="true"]`、`.cm-editor`；
3. 仅把保存、发送、命令面板、恢复标签、关闭当前标签交给全局处理；
4. `Ctrl/Cmd+F` 不由全局处理，交给响应面板基于焦点上下文处理。

### 3.3 分隔条恢复

为 `ResizeHandle` 增加 `onReset` 属性和双击事件。`App.tsx` 传入当前布局对应的默认值，普通拖动和键盘调整仍调用现有 `onChange`。该变化不触碰偏好存储格式。

### 3.4 视觉边界

- 命令面板和快捷键弹层使用现有 `Dialog` / 弹层语义，沿用四套主题令牌。
- 不引入新的大面积渐变和主题专属颜色；操作状态只使用现有强调色、成功色、警告色和危险色。
- 小窗口只减少辅助说明、压缩工具间距和让列表滚动，不隐藏当前请求、发送、响应搜索和关闭操作。

## 4. 文件边界

预计修改或新增：

- `src/hooks/useWorkbench.ts`：增加普通接口标签恢复栈和恢复方法。
- `src/lib/commands.ts`：新增命令与快捷键纯数据定义。
- `src/components/CommandPalette.tsx`：新增命令面板。
- `src/components/CommandPalette.test.tsx`：命令过滤、键盘导航和禁用态测试。
- `src/components/ShortcutsDialog.tsx`：新增快捷键总览弹层。
- `src/components/ShortcutsDialog.test.tsx`：分组和共用快捷键定义测试。
- `src/components/RequestTabs.tsx`、`src/components/RequestTabs.test.tsx`：恢复入口、标签关闭后的恢复行为和快捷键提示。
- `src/components/ResponsePanel.tsx`、`src/components/ResponsePanel.test.tsx`：响应搜索上下文测试。
- `src/components/ResizeHandle.tsx`、新增对应测试：双击恢复默认尺寸。
- `src/App.tsx`：命令面板、快捷键弹层和全局命令执行接入。
- `src/lib/preferences.test.ts`：确认上下 / 左右尺寸偏好继续独立保存。
- `src/styles.css`：命令面板、快捷键弹层和 1000×700 下的局部布局适配。
- `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`：统一升级到 `1.6.0`。
- `README.md`、`docs/releases/v1.6.0.md`：操作说明、兼容性和验证记录。

不修改：

- `src-tauri/migrations/*`；
- `src-tauri/src/engine/*`、请求执行 IPC 和 SQLite 存储；
- 临时请求的数据模型和云同步实验目录。

## 5. 错误处理与兼容性

- 标签恢复只引用当前仍存在的接口；接口删除、项目切换和工作区重新加载都会过滤无效记录。
- 自动保存失败时不改变现有标签和恢复栈，继续显示现有失败通知。
- 命令执行统一复用现有 `save`、`openTemporary`、`setPage`、`updatePreferences` 和弹层开关，不复制业务逻辑。
- 所有新状态均为会话内存或现有 localStorage 偏好，不影响旧数据库升级和跨版本回退备份。
- 如果浏览器模式没有桌面保存能力，命令面板沿用现有内存会话提示，不伪造保存成功。

## 6. 验收与测试

### 自动化测试

- 标签恢复：
  - 关闭当前、关闭其他、关闭右侧和关闭全部后按顺序恢复；
  - 恢复位置、当前选中项、项目隔离和接口删除后的失效清理；
  - 自动保存失败时恢复栈不提前写入。
- 命令面板：
  - 关键词过滤、无结果、禁用命令、上下键、Home/End、Enter、Escape；
  - 面板打开时阻断底层快捷键，关闭后恢复原焦点；
  - 快捷键总览与命令定义中的标题、快捷键一致。
- 快捷键：
  - `/`、`Ctrl/Cmd+K`、`Ctrl/Cmd+S`、`Ctrl/Cmd+Enter` 的既有行为不回归；
  - `Ctrl/Cmd+Shift+P`、`Ctrl/Cmd+Shift+T`、`Ctrl/Cmd+W` 只在允许上下文触发；
  - 输入框、CodeMirror、弹层和菜单中不抢占。
- 响应搜索：
  - 响应面板获得焦点时 `Ctrl/Cmd+F` 打开；
  - 请求编辑器和 JSON 工具中不打开响应搜索；
  - 搜索、关闭、匹配高亮及无响应状态保持现有行为。
- 分隔条：
  - 拖动、方向键和双击恢复；
  - 上下与左右尺寸偏好独立保存，异常 localStorage 仍回退默认值。

### 交付验收

- 前端全量测试、Rust 测试、打包检查全部通过；
- 1000×700 与 1440×900 窗口各验证一次；
- dark、light、soft、dusk 四主题各验证一次；
- 普通接口标签、临时请求标签、JSON 工具和开发工具箱的焦点与快捷键边界逐项验证；
- 版本元数据、安装器名称、ZIP 名称、Release 说明和 SHA-256 文件统一为 `1.6.0`。

