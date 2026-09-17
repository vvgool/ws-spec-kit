# ADR 0002：普通步骤支持对话批准

状态：已采纳（2026-09-17，用户确认）

## 背景

用户已在 Agent 对话中同意设计，`wspec decide` 仍因 stdin 非 TTY 拒绝，导致反复确认和手动终端接力。TTY 属性本身也不能独立证明操作者是人。

## 决定

普通 Artifact 审批的批准接受 Host 转录的显式用户确认。Application Protocol v2 增加可选 `confirmation`，同时绑定 Work Item、Request、审批摘要及执行 actor。审批引擎保留 Artifact 和工作区有效性检查、原子推进及幂等语义。

审计区分 `agent_transcribed`、`terminal`、`terminal_token`。对话确认是 Host 声明，不提供独立用户身份认证；仅记录当前确认原话，不保存会话历史。Host 负责判断同意是否明确指向当前版本，Runtime 负责绑定、内容校验和持久化。

外部写入（含发布）、Workflow 信任、外部恢复和现有拒绝确认机制不放宽。普通步骤批准不等于外部动作授权。

## 兼容与验证

旧输入及旧审计记录仍可读取。Driver v10 提供新的审批分支，安装保留现有旧版本不覆盖规则。验证协议字段范围、真实非 TTY CLI 批准、审计恢复、重复与并发提交、旧版本失效，以及严格审批拒绝非 TTY 的既有测试。
