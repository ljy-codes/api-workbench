# EnvDock 2.0.0 · macOS 安装说明

## 发布状态

2.0.0 的 `.dmg` 已生成。请不要把 `EnvDock-macOS-1.8.1` 目录中的 DMG 当作 2.0.0 安装包。

2.0.0 安装包名称为：

| Mac 类型 | 安装包 |
| --- | --- |
| Intel Mac | `EnvDock-2.0.0-macos-x64.dmg` |
| Apple Silicon（M 系列）Mac | `EnvDock-2.0.0-macos-arm64.dmg` |

## 兼容性

2.0.0 沿用原应用标识、SQLite 工作区、数据目录和登录钥匙串方案，不需要数据库迁移。升级前仍应保存请求并退出旧版；Intel 构建已完成启动验证，arm64 需要在 M 系列设备上实际启动确认。

本地构建使用临时 ad-hoc 签名，不等同于 Apple Developer ID 签名或公证。对外分发前应使用开发者证书签名并完成公证。
