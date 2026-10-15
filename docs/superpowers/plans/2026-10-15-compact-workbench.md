# EnvDock 紧凑工作台实施计划

> 按用户已确认方案在当前会话执行；版本保持 1.0.0。

**目标：** 减少重复层级与留白，提高请求、响应的正文阅读空间，统一 JSON 分色。

**架构：** 仅调整前端布局和展示组件。共用编辑器负责主题、只读和搜索装饰；请求与响应组件继续调用现有模型，不修改存储和执行链路。

**技术：** React、TypeScript、CodeMirror、Vitest、Tauri。

- [x] 1. 为紧凑请求菜单、正文类型切换、响应折叠搜索和真实 JSON 着色补充行为测试，运行并确认新增功能尚未实现。
- [x] 2. 修改 `RequestEditor.tsx`、`Sidebar.tsx`、`App.tsx` 与 `styles.css`：合并正文工具栏、收起低频操作、压缩栏高与树节点、保留环境警示和锁定。
- [x] 3. 修改 `CodeEditor.tsx`，新增 `editorTheme.ts`；修改 `ResponsePanel.tsx` 共用只读编辑器，保留搜索上限、格式切换、原文复制和清理。
- [x] 4. 更新受入口变化影响的现有测试，运行 `npm.cmd test`、`npm.cmd run build`、`npm.cmd run test:packaging`；浏览器验证紧凑布局与 JSON 配色，记录结果并构建当前版本安装包。

## 完成条件

四项用户诉求均有对应实现和实际检查；既有环境隔离、自动保存、快捷键和异步锁定回归通过。保留原有未提交文件；不自动上传测试数据或覆盖 GitHub Release。

已完成。验证、包校验和限制见 `docs/ui-compact-2026-10-15.md`。
