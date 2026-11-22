# EnvDock 2.0.0 · macOS 更新

## 版本变化

- macOS 当前源码版本升级为 `2.0.0`。
- npm、Tauri、Rust crate、Cargo.lock 和 Tauri 配置的版本号保持一致。
- SQLite 工作区、请求配置、响应缓存、变量和登录钥匙串方案保持兼容，无数据库迁移。
- 工作台快捷键和派生数据处理减少重复监听与重复扫描，浅色主题可读性和渲染异常恢复路径同步改进。
- Rust 测试默认不访问真实登录钥匙串；需要钥匙串访问时再单独运行被忽略的集成测试。

## 交付说明

2.0.0 已生成 Intel x64 与 Apple Silicon arm64 DMG，并完成 DMG 完整性、签名和版本字段检查。Intel 版本已在本机启动验证；arm64 仍需在 M 系列设备上实际启动验证。`EnvDock-macOS-1.8.1` 仅作为上一版历史交付保留。

构建命令：

```sh
npm ci
npm run build:mac
npm run build:mac:arm64
```

Windows 专属安装包、便携版和卸载流程不在本次 macOS 版本升级范围内。
