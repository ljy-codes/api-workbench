# EnvDock Settings and Transfer Implementation Plan

> **For agentic workers:** 使用 superpowers:dispatching-parallel-agents 将数据转换与界面偏好分开实施，主线程负责集成、验证和交付。

**Goal:** 在 1.0.0 内增加离线设置、主题、可选择的导入导出、布局切换和作者信息。

**Architecture:** 复用 Workspace 和 exchange 校验/脱敏，独立 transfer 适配器转换外部格式。轻量本机 preferences 模块驱动 CSS 主题与布局；设置按需加载。

**Tech Stack:** React、TypeScript、CSS variables、Tauri、Rust、Vitest。

---

- [x] 数据转换：新增 `src/lib/transfer.ts`，提供 `detectImport(text)`、`importSelection(workspace, bundle, selection)` 和 `exportSelection(workspace, selection)`；编写合成数据转换及裁剪测试。
- [x] 偏好：新增 `src/lib/preferences.ts` 和对应 hook，校验损坏存储，首屏应用主题，监听系统颜色，持久化布局。
- [x] 设置：新增 `src/components/SettingsPanel.tsx`、改造 `ExchangePanel.tsx`，实现文件/文本预览、项目环境复选和 JSON 导出。
- [x] 集成：修改 `App.tsx`，加入设置入口、侧栏控制和分屏按钮，页脚加 `著作:lxs`；保留现有业务链路。
- [x] 原生文件入口：读取 JSON/YAML 等受支持文本，导出默认 `.json`，维持 10 MiB 和原子写入。
- [x] 视觉：补齐 CSS 主题 token、浅色对比度和布局边界，保留现有深色和 JSON 分色。
- [x] 验证：运行转换/偏好/交互测试、完整前端测试、生产构建、打包检查及 Rust 相关测试；使用合成数据检查浅深主题与双布局。
- [x] 交付：保持 1.0.0，构建本地安装包，记录验证结果；已同步本机交付目录并逐一核对 7 个文件的 SHA256。本轮不发布 GitHub，保留当前工作区、已安装程序、业务数据库及 Yaak。
