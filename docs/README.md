# EnvDock 文档索引

仓库只保留当前有效的契约、平台规则、功能对照和发布说明。旧计划、旧验收记录和旧版本说明已清理，需要追溯时使用 Git 提交历史。

## 当前文档

- [共享契约](contract.md)：TypeScript / Rust DTO、IPC 和数据边界。
- [GitHub 分支与版本规定](platform-branch-and-version-policy.md)：三条长期分支、版本号、标签和 Release 规则。
- [macOS 适配](macOS.md)：构建、数据目录、钥匙串和平台限制。
- [macOS / Windows 功能对照](macOS-feature-matrix.md)：当前版本功能一致性和平台差异。
- [Windows 2.0.1 发布说明](releases/v2.0.1.md)：当前 Windows 版本变更和交付信息。
- [总体方案](总体方案.md)：历史设计基线，不代表当前全部实现。

## 维护规则

- `README.md` 同时作为安装包内的 `使用说明.md`，必须保留安装、数据目录、迁移、使用限制和安全说明。
- 新版本发布说明放入 `releases/`，每个平台只保留当前版本。
- 不新增历史计划或阶段验收副本；需要追溯时查看对应 Git 提交。
- `docs/test.md` 等本机验证记录可能包含业务数据，按 `.gitignore` 保留在本地，不提交 GitHub。
