# Codex 真实客户端验收

## 结论

状态：**PARTIAL / NO-GO**。

2026-08-22 在 macOS 26.6.2 arm64 上运行真实 Codex CLI 与模型。客户端版本为
`codex-cli 0.148.0-alpha.21`，认证状态检查成功，`codex exec` 非交互入口可用。验收基于 WSSpecKit
`3d0175b7`，脱敏 Work Item 为 `WSS-...4AXWZC`。未访问外部 Issue、飞书或其他业务系统。

## 实际调用

第一次全新会话只描述隔离仓库内的 Smoke 目标，没有点名 Driver。Host 读取项目级 Skill 后执行
`inspect -> acquire -> submit`：`intake` 最终提交成功，并返回 `explore` Work Package。CLI 没有提供独立的
Skill-trigger telemetry，因此自动触发只能由真实行为链佐证，记为 `partial`，不扩大为可审计的自动发现
PASS。

第二次全新会话显式调用 `wsspeckit-driver`，使用新 actor 执行 `inspect -> acquire`，取得同一 Work Item 的
`explore` Work Package 后按要求在 submit 前停止。显式调用与 fresh-session recovery 均为 PASS。

真实执行暴露了两个阻塞：

- workspace sandbox 默认不能在 Git control plane 创建短期锁；Guardian 提升该仓库内本地命令后才可继续。
- Driver/Work Package 只给出 Artifact 类型和 Schema 版本，没有提供创建 Artifact 的公开命令，也没有给出
  YAML front matter 与规范化 `contentHash` 的完整可执行契约。Host 被迫反查实现；约 60 秒 Attempt Lease 在
  探索与构造产物期间反复过期，`explore` 无法稳定提交。

SubmitResult 若写入任务 worktree 会进入 Git diff 并触发 `WSSPEC_MODIFIED_FILES_MISMATCH`；仓库外临时目录又
被 Guardian 正确拒绝。把结果放进 Work Item 元数据目录可避开产品 diff，但这一路径约定也未写入 Driver。

## Verifier

严格 verifier 返回 FAIL：事件链 9 条有效，真实 `acquire=4`、`submit=1`；无 Issue Binding，因此外部 Issue
Close 按合同跳过。以下必需项未达到：compact plan、同一 `commandId` 的 trusted Red/Green、Review、预期
代码与测试 diff、Work Item Close。

因此本轮只证明真实 Codex 的项目 Skill 行为、显式调用、协议入口与跨会话恢复；不证明完整交付闭环，保持
NO-GO。
