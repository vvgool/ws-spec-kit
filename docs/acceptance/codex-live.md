# Codex 真实客户端验收

## 结论

状态：**历史观察 `observed-unverified / NO-GO`；证据 authority 为 `legacy-unbound`**。

本页记录发生在外部 authority、签名 fixture receipt 和签名 run manifest 引入之前，无法事后补签或证明原始
客户端身份。因此下述正向结果只保留为 `observed-unverified`，不是发布 PASS，也不能用于推进真实 Host GO。
机器可读的脱敏历史位于 `agent-live-history.json`；其中 `runIdHash` 只关联公开的 sanitized legacy record，
不是对已丢失原始 session/run ID 的伪造替代。

历史记录称 2026-08-22 曾在 macOS 26.6.2 arm64 上运行真实 Codex CLI 与模型。客户端版本为
`codex-cli 0.148.0-alpha.21`，认证状态检查成功，`codex exec` 非交互入口可用。验收基于 WSSpecKit
`3d0175b7`，脱敏 Work Item 为 `WSS-...4AXWZC`。未访问外部 Issue、飞书或其他业务系统。

**2026-08-23 当前复核：** 只允许并仅执行了 `command -v codex`，结果为缺失。没有调用 Codex、没有检查版本或认证、没有启动
Agent 或模型，也没有生成本次 signed receipt。历史段落不能被此复核升级为当前真实 Host evidence。

## 实际调用

第一次全新会话只描述隔离仓库内的 Smoke 目标，没有点名 Driver。Host 读取项目级 Skill 后执行
`inspect -> acquire -> submit`：`intake` 最终提交成功，并返回 `explore` Work Package。CLI 没有提供独立的
Skill-trigger telemetry，也没有 observer-signed auto/explicit/recovery invocation receipts；因此这条只能保留
为 `observed-unverified`，不能标为 partial 或可审计的自动发现 PASS。

第二次全新会话显式调用 `wsspeckit-driver`，使用新 actor 执行 `inspect -> acquire`，取得同一 Work Item 的
`explore` Work Package 后按要求在 submit 前停止。显式调用与 fresh-session recovery 均为未认证历史观察。

真实执行暴露了两个阻塞：

- workspace sandbox 默认不能在 Git control plane 创建短期锁；Guardian 提升该仓库内本地命令后才可继续。
- Driver/Work Package 只给出 Artifact 类型和 Schema 版本，没有提供创建 Artifact 的公开命令，也没有给出
  YAML front matter 与规范化 `contentHash` 的完整可执行契约。Host 被迫反查实现；项目可通过
  `runtime.claimTtlSeconds` 调大 Lease，但默认 60 秒且没有公开 renew 入口，`explore` 在默认配置下无法稳定提交。

SubmitResult 若写入任务 worktree 会进入 Git diff 并触发 `WSSPEC_MODIFIED_FILES_MISMATCH`；仓库外临时目录又
被 Guardian 正确拒绝。把结果放进 Work Item 元数据目录可避开产品 diff，但这一路径约定也未写入 Driver。

## Verifier

旧 verifier 的未认证记录为 FAIL：观察到事件链 9 条、`acquire=4`、`submit=1`；无 Issue Binding，因此外部
Issue Close 按合同跳过。以下必需项未达到：compact plan、同一 `commandId` 的 trusted Red/Green、Review、
预期代码与测试 diff、Work Item Close。原运行没有可回读的 event/verifier digest，manifest 中明确记录为
`null`，不做推测。

新流程必须由 `run-agent-smoke.mjs` observer 持有仓库外 mode `0600` 的 authority，并用显式 canonical
`--client-executable` 启动 auto、explicit、recovery 三阶段。Host child 的 argv/env 不包含 authority path/key；
直接运行 `prepare-agent-smoke.mjs` 只返回 `observer-only-unbound` 的公开 fixture 信息，不返回 authority。完整入口为：

```bash
node scripts/acceptance/run-agent-smoke.mjs \
  --client codex --client-executable /absolute/path/to/codex \
  --directory /absolute/path/to/new-fixture
```

runner 仅在三个 Host child 全部退出后，才向 observer 调用方返回 verifier 所需的 authority path/identity。
verifier 缺少任一 authority 参数或任一阶段 signed receipt 都会 fail closed：

```bash
node scripts/acceptance/verify-agent-smoke.mjs \
  --client codex --repo <fixture-repo> \
  --authority <authority-file> --authority-identity <sha256>
```

三个阶段均以独立 fresh client session 启动，禁止使用 `resume` 或 `--resume` 复用原生 Host session。Host PATH
首项固定为 fixture 的 canonical `bin/`；signed fixture 同时绑定 `bin/wspec` 的 digest、device、inode、mode、
uid、size、identity 和 WSSpecKit commit。每份 invocation receipt 都包含调用前后 event/projection 摘要与脱敏
`inspect/acquire/submit` 计数；相邻 checkpoint 必须严格串联，auto、explicit、recovery 每段都必须有实际控制面
推进，recovery 还必须出现成功 `inspect + acquire`。三段 receipt 全通过仍不足以发布 PASS，最终 verifier 的
全部交付检查也必须通过；本页旧记录不满足其中任何一项，继续 NO-GO。

此边界防止 authority 经 observer 启动的 Host child argv/env 泄露，并以仓库外 `0600` 文件约束普通读取；它不
声称能够抵抗同一 UID 下可扫描临时目录、附加进程或改写 observer 文件的主机级攻击。更强保证需要独立 OS
用户、隔离执行环境或外部 signer。

因此本轮只留下真实 Codex 项目 Skill 行为、显式调用、协议入口与跨会话恢复的未认证历史观察；不证明完整
交付闭环，保持 NO-GO。只有重新运行新 authority 流程并通过签名 verifier 才能产生可发布 PASS。
