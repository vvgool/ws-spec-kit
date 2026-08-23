# 01: 冻结五操作 Application Protocol

**What to build:** 从使用者视角固定 WSSpecKit 的 Work Item 生命周期协议为 `start`、`acquire`、`submit`、`decide`、`inspect`。用户仍可通过 CLI 创建 Artifact，但该能力不再被误解或暴露为第六个同层生命周期操作。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `WSSpecApplication` 的公开调用面只包含五个生命周期操作，`artifact create` 通过 Attempt 作用域服务和 CLI 访问。
- [ ] 公开 Schema、CLI 帮助、中文参考文档与契约测试一致说明 Artifact authoring 是 `execute` Work Package 的辅助能力。
- [ ] 不保留顶层 `artifact()` 的兼容别名、双版本协议或隐式迁移路径。
