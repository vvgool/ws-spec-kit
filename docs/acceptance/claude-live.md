# Claude 真实客户端验收

## 结论

状态：**历史观察 `not-run / NO-GO`；证据 authority 为 `legacy-unbound`**。

本页预检发生在外部 authority 和签名 run manifest 引入之前，无法事后补签。机器可读记录中的 `runIdHash`
只关联 sanitized legacy record，不代表存在原始 Claude session/run；本页没有任何可发布 PASS。

历史记录称 2026-08-22 在 macOS 26.6.2 arm64 上预检。WSSpecKit 基线为 `3d0175b7`。PATH 中不存在 `claude` 或其他
Claude Code CLI；本机存在 Claude Desktop `1.28929.0`，其 canonical binary 是 Electron GUI，不提供本任务
所需的 headless Skill 列表、非交互执行或会话恢复接口。

**2026-08-23 当前复核：** 只允许并仅执行了 `command -v claude`，结果为缺失。没有调用 Claude、没有检查版本或认证、没有启动
Agent 或模型，也没有生成本次 signed receipt；历史 Desktop 观察不是当前真实 Host evidence。

因此没有启动 Claude Code 模型调用，没有验证 `/skills`、自动触发、显式 Driver、`inspect -> acquire`
恢复，也没有生成 Work Item 或 verifier 通过证据。桌面应用文件存在不能替代真实 Claude Code 客户端验收。

未安装、未登录、未修改 Claude 配置，也未读取任何认证配置正文。后续必须在可用且已认证的 Claude Code CLI
环境通过 observer 运行完整流程；本机未验证 Claude CLI argv 模板，也没有启动模型会话：

```bash
node scripts/acceptance/run-agent-smoke.mjs \
  --client claude --client-executable /absolute/path/to/claude \
  --directory /absolute/path/to/new-fixture
```

直接运行 `prepare-agent-smoke.mjs` 只返回 `observer-only-unbound` 的公开 fixture 信息；runner 仅在三个 Host
child 全部退出后向 observer 调用方返回 authority path/identity。新 verifier 必须同时提供 `--authority <file>` 和
`--authority-identity <sha256>`；并要求 observer-signed auto/explicit/recovery 三阶段 invocation receipts，
缺失或不匹配会 fail closed。

auto、explicit、recovery 必须是三个互不相同的 fresh client session，不使用 `--resume`。Host PATH 首项必须是
fixture canonical `bin/`，`bin/wspec` 的 path/digest/device/inode/mode/uid/size/identity/WSSpecKit commit 均由
signed fixture 绑定。每份 receipt 还要绑定 before/after event、projection 和 wrapper command checkpoint；三段
都必须有 meaningful delta，recovery 必须通过 `inspect + acquire` 取得新的 Work Package。只有这些阶段证据与
最终 verifier 同时通过才允许 PASS；本页没有运行 Claude Code，因此全部保持未满足和 NO-GO。

信任边界是 observer process、Host child 的 clean argv/env 和仓库外 mode `0600` authority；不声称抵抗同一
UID 的主机级扫描、进程附加或文件改写。更强保证需要独立 OS 用户、隔离执行环境或外部 signer。
