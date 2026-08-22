# Cursor 真实客户端验收

## 结论

状态：**历史观察 `not-run / NO-GO`；证据 authority 为 `legacy-unbound`**。

本页记录发生在外部 authority、签名 fixture receipt 和签名 run manifest 引入之前，无法事后补签。下述
launcher、认证状态和 Driver 安装结果仅为 `observed-unverified`，不是发布 PASS。机器可读记录中的
`runIdHash` 只关联 sanitized legacy record，不冒充已丢失的原始 session/run ID。

2026-08-22 在 macOS 26.6.2 arm64 上预检。WSSpecKit 基线为 `3d0175b7`，脱敏 Work Item 为
`WSS-...W2GV6`。`cursor` launcher 明确报告没有可用 Cursor IDE，并提示改用 Cursor Agent。canonical
`agent` 版本为 `2025.10.28-0a91dc2`，帮助信息声明支持 headless `--print`、结构化输出和 resume。

`agent status` 与 `agent whoami` 都显示登录流程成功但无法获取用户详情；真正的 headless Agent 调用却在模型
启动前返回 `Authentication required`。该不一致说明只读状态检查不能作为真实认证证据。没有读取、复制或注入
API key，也没有继续登录流程。

因此没有发生 Cursor 模型调用，无法验证项目级 `.cursor/skills` 的 UI/Agent 发现、自动触发、显式 Driver 或
新 Agent 会话恢复。严格 verifier 对已准备 fixture 返回 FAIL：事件链只有初始 `start` 1 条，
`acquire=0`、`submit=0`，compact plan、trusted Red/Green、Review、预期 diff 与 Close 均不存在。

创建本地空 chat ID 的命令可运行，但这不证明已认证模型执行或 Skill 可见，不能计为部分通过。后续必须先让
真实 headless 调用与 `status` 使用同一有效认证，再通过 observer 重跑本验收：

```bash
node scripts/acceptance/run-agent-smoke.mjs \
  --client cursor --client-executable /absolute/path/to/agent \
  --directory /absolute/path/to/new-fixture
```

直接运行 `prepare-agent-smoke.mjs` 只返回 `observer-only-unbound` 的公开 fixture 信息；runner 仅在三个 Host
child 全部退出后向 observer 调用方返回 authority path/identity。新 verifier 必须同时提供
`--authority <file>` 和 `--authority-identity <sha256>`，并核对 observer-signed auto/explicit/recovery
invocation receipts；旧 fixture 缺少签名 receipt 时会 fail closed。

新流程的 auto、explicit、recovery 均为独立 fresh client session，不允许用 `--resume` 复用 chat。Host PATH
首项固定为 fixture canonical `bin/`，signed fixture 绑定 `bin/wspec` 的 path/digest/device/inode/mode/uid/size、
identity 与 WSSpecKit commit。三份 invocation receipt 必须各自绑定 before/after event/projection 和 wrapper
command checkpoint，严格串联且每阶段均有 meaningful delta；recovery 必须通过 `inspect + acquire` 恢复新的
Work Package。只有阶段证据和最终 verifier 全部通过才允许 PASS；本页没有有效模型调用，继续 NO-GO。

信任边界是 observer process、Host child 的 clean argv/env 和仓库外 mode `0600` authority；不声称抵抗同一
UID 的主机级扫描、进程附加或文件改写。更强保证需要独立 OS 用户、隔离执行环境或外部 signer。
