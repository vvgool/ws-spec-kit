# Claude 真实客户端验收

## 结论

状态：**历史观察 `not-run / NO-GO`；证据 authority 为 `legacy-unbound`**。

本页预检发生在外部 authority 和签名 run manifest 引入之前，无法事后补签。机器可读记录中的 `runIdHash`
只关联 sanitized legacy record，不代表存在原始 Claude session/run；本页没有任何可发布 PASS。

2026-08-22 在 macOS 26.6.2 arm64 上预检。WSSpecKit 基线为 `3d0175b7`。PATH 中不存在 `claude` 或其他
Claude Code CLI；本机存在 Claude Desktop `1.28929.0`，其 canonical binary 是 Electron GUI，不提供本任务
所需的 headless Skill 列表、非交互执行或会话恢复接口。

因此没有启动 Claude Code 模型调用，没有验证 `/skills`、自动触发、显式 Driver、`inspect -> acquire`
恢复，也没有生成 Work Item 或 verifier 通过证据。桌面应用文件存在不能替代真实 Claude Code 客户端验收。

未安装、未登录、未修改 Claude 配置，也未读取任何认证配置正文。后续必须在可用且已认证的 Claude Code CLI
环境重新运行同一 prepare/verify 流程。新 verifier 必须同时提供 `--authority <file>` 和
`--authority-identity <sha256>`；缺失或不匹配会 fail closed。
