# EnvDock 2.0.0

发布日期：2026-11-22

## 本次变更

- macOS 当前源码版本升级为 `2.0.0`，npm、Tauri、Rust crate 及锁文件保持一致。
- 沿用原应用标识、macOS 数据目录、SQLite 工作区结构、IPC 契约和登录钥匙串方案。
- 本次版本号升级不新增数据库迁移，已有 1.8.1 工作区可以继续打开。
- 渲染异常增加本地恢复界面；全局快捷键监听和工作台派生数据改为稳定引用与记忆化计算，降低编辑和响应处理期间的重复开销。
- 浅色主题补齐低对比度文字令牌；CSP 增加对象、基础 URL、框架嵌入和表单提交限制。
- macOS 单元测试在 `cfg(test)` 下使用固定内存密钥，真实登录钥匙串只由显式忽略测试覆盖；文件校验允许 macOS 的系统目录别名 `/var`、`/tmp` 和 `/etc`。
- 测试初始化兼容 Node 25 的实验性 Web Storage；CI 基于 Node 22、低并发 Vitest 和串行 Rust 测试，版本一致性由 `npm run check:version` 检查。

## 交付状态

- 已生成 Intel x64 和 Apple Silicon arm64 的 2.0.0 `.app` / `.dmg`。
- 两个 DMG 已通过 `hdiutil verify`；两个应用包已通过 `codesign --deep --strict`，版本字段均为 `2.0.0`。
- Intel 构建已在本机 macOS 13.7.8 启动并确认进程及主窗口存在；arm64 版本由 Intel Mac 交叉编译，仍需在 M 系列设备上实际启动验证。
- 1.8.1 交付目录继续作为历史材料保留，不与 2.0.0 交付混用。

## 兼容性

- 不改变工作区数据库 schema、请求配置、响应缓存、变量格式或敏感值加密方案。
- 不改变 Bundle ID `local.apiworkbench.desktop`。
- Windows 专属安装包、便携版和卸载流程仍按现有 Windows 交付说明维护。
