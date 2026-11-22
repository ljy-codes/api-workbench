# EnvDock 1.8.1 · macOS 安装与更新

源码基线：`f93d868fe0db2b26ffa8036b3391cdbe1f9a138f`（上游 `v1.8.1`）。本版修复直接填写 Bearer Token 时认证值被错误拒绝、未写回请求配置的问题。

| Mac 类型 | 安装包 |
| --- | --- |
| Intel Mac | `EnvDock-1.8.1-macos-x64.dmg` |
| Apple Silicon（M 系列）Mac | `EnvDock-1.8.1-macos-arm64.dmg` |

保存请求并退出旧版，打开对应 DMG，将 EnvDock.app 拖到 Applications 并替换。沿用原应用标识、SQLite 工作区、数据目录和登录钥匙串方案，无数据库迁移。安装后无需 Node.js 或 Rust。

本机 Intel 版已安装启动，原工作区已载入。M 系列包由 Intel Mac 交叉编译，未在 M 系列设备实际启动验证。应用使用临时 ad-hoc 签名，未使用 Apple Developer ID 或公证。

构建、校验和安装记录见 `BUILD-INFO.json`、`VERIFICATION.json` 和 `SHA256SUMS.txt`。发布包不包含用户数据库、凭据或备份。
