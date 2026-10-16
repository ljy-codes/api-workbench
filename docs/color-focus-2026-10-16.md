# EnvDock 内容优先配色 · 2026-10-16

## 已确认事实与方案

- 用户以 Yaak 为参考，要求降低工具自身颜色的存在感，突出数据；保持当前版本 1.0.0。
- 应用入口先载入 `styles.css`，再载入 `themes.css`；旧深色配色在基础样式中硬编码，浅色在主题文件覆盖。
- 请求与响应共用 CodeMirror 的 `editorTheme` 和 JSON 高亮类。主题与布局偏好单独存于本机，工作区数据由桌面版 SQLite 保存。
- 工具界面使用低饱和灰阶：导航、标签、按钮和选中区域维持清晰层次；JSON 字段名为蓝色、字符串为琥珀色、数字为青绿色、布尔值和 null 为珊瑚色。
- GET / POST / PUT、PATCH / DELETE 继续按绿 / 琥珀 / 蓝 / 红区分，URL 方法选择器与标签颜色一致；仪表盘图表使用相同语义色。
- 深浅主题共享组件配色规则，只在主题 token 层定义色值，避免深色仍残留紫色覆盖。

## 已修改文件与影响范围

| 文件 | 修改目的 |
| --- | --- |
| `src/themes.css` | 深浅调色板、低饱和控件、共享主题规则、语法色和方法色 |
| `src/styles.css` | 移除重复的根配色，焦点使用专用主题 token |
| `src/components/editorTheme.ts` | 选择与查找颜色使用主题 token |
| `src/components/RequestEditor.tsx` | 为请求方法选择器补充呈现类名，不改变事件处理 |
| `src/components/Dashboard.css` | 图表方法色与工作台保持一致 |
| `README.md`、`docs/releases/v1.0.0.md` | 同版本修订说明 |

没有修改请求执行、保存流程、SQL、缓存、事务或数据结构，没有新增依赖。已有仪表盘、服务地址统一、树快捷操作、标签关闭等改动保留。

## 验证记录

- `npm.cmd test -- --reporter=dot --maxWorkers=1`：32 个文件，519 项通过。
- 首轮 4 个 worker：517 项通过，设置弹窗与导入错误提示的异步加载等待超时。两个失败文件用单 worker 单独复测 22 项通过；串行全量通过。没有为配色修改设置或导入逻辑，也没有调整测试断言与等待时间。
- `npm.cmd run test:packaging`：11 项通过。
- 浏览器使用内存示例验证深色、浅色、跟随系统、JSON 高亮和格式化、七种方法色、仪表盘、820×760 窄窗口、键盘焦点与编辑器查找高亮；未调用真实接口。
- 深色、浅色各检查 39 组关键正文/控件文本对比度，最低分别为 4.57:1、4.59:1；明亮颜色集中在正文和数据状态。保留焦点、选中细线、状态文字及原有 reduced-motion 设置。计算结果保存在 `.tmp/color-contrast.json`。
- 效果截图位于 `.tmp/color-content-dark.png`、`.tmp/color-content-light.png`；截图仅含内存示例。
- `scripts/build-installer.ps1`：TypeScript、Vite 生产构建、Rust release 及 NSIS 安装器构建成功，产物版本 1.0.0。

## 兼容性与风险

- 版本、应用标识、本机数据目录和偏好存储 key 保持原值，无数据库迁移。
- 本次变更以呈现为主；深浅主题与 CodeMirror 的 CSS 覆盖顺序是主要视觉风险，已通过实际渲染检查。
- 同版本安装器文件名不变，区分修订应以更新时间和 `SHA256SUMS.txt` 为准。
- 已按用户要求卸载本机旧版并安装本次修订，安装目录仍为 `D:\Program File\EnvDock`；卸载保留工作区，未使用数据清理参数。

## 本机安装验证

- 2026-10-16 完成旧版卸载和新版安装，两次退出码均为 0，版本仍为 1.0.0。
- 安装器 SHA256：`12C00812045464C45D62EAB38B178941C0F461AEDE4161C2300D3991177E99DF`。
- 安装后 EXE SHA256：`99D442E810A6985635B3BD9614D7B67352D0C501FBAA17434AE4B76E72A68D0A`；已按 Tauri NSIS bundle 标记差异在内存中校验，与本次 release 构建一致。
- 首次启动前，工作区 4 个文件、WebView 配置 407 个文件均与备份 SHA256 一致；注册项、桌面和开始菜单快捷方式正确。
- 安装后的程序已启动，进程路径为 `D:\Program File\EnvDock\EnvDock.exe`，主窗口标题为 `EnvDock · API Workbench`，响应正常。
- 安装前备份位于 `D:\专用工具\接口工具\本机备份\before-color-focus-install-20261016-115002`；该目录包含数据、旧程序、逐文件校验清单和安装结果记录。

## 交付与后续

- 安装器：`publish/EnvDock-1.0.0-windows-x64/EnvDock-1.0.0-windows-x64-setup.exe`。
- 配套 `使用说明.md`、`更新说明.md` 和 `SHA256SUMS.txt` 随本次构建同步，安装器校验值以该目录为准。
- 本轮配色、验证、安装包生成和本机替换安装均已完成，原工作区数据与配置保留。
