# Agent Driver 统一契约验收

## 验收范围

本验收只证明当前 checkout 的 Driver Skill 文件安装和受控 Fixture 模拟循环，不证明真实 Codex、
Claude 或 Cursor Host 已发现、触发或执行该 Skill。真实 Host 的自动触发、显式触发、模型行为、权限和
跨会话体验必须由后续真实客户端验收单独记录；本结果不得冒充真实 Host 通过，也不得扩大为发布或生产
可用结论。

## 文件安装

公开命令为：

```sh
wspec agent install --client codex
wspec agent install --client claude
wspec agent install --client cursor
wspec agent install --client generic --target <安装目录>
```

Codex、Claude、Cursor 分别安装到宿主约定的 `~/.agents/skills/wsspeckit-driver/SKILL.md`、
`~/.claude/skills/wsspeckit-driver/SKILL.md` 和 `~/.cursor/skills/wsspeckit-driver/SKILL.md`。
Generic 没有可推断的宿主目录，必须显式提供 `--target`。安装器支持 `--dry-run`；同 canonical 摘要重复
安装保持幂等，未知或被修改的同名内容拒绝覆盖。四类安装都只生成中文说明的 `SKILL.md`，不生成 `.mdc`
或后台 Runner。

## 模拟协议循环

每类 Adapter 都对功能任务和纯文档任务执行相同的真实 CLI 子进程序列：

```text
新任务：显式 workflowRef 的 start
恢复：新进程 inspect -> 新进程 acquire
执行：读取 Work Package 引用 -> 当前 Agent 执行 -> 新进程 submit
继续：inspect / acquire / submit，直到审批、阻塞或完成
```

功能任务固定选择 `builtin://workflows/feature-delivery`，纯文档或无代码变更任务固定选择
`builtin://workflows/documentation-delivery`。项目默认 Workflow 在创建后发生变化时，已有 Work Item 仍
保持创建时的 `workflowRef`，Driver 不得静默切换。

Driver 和 WSSpecKit Runtime 不调用模型 API，不缓存或管理 Agent 对话、Token、记忆或隐藏推理。模型上下文
由真实 Agent Host 自主管理。Work Package 和其他协议 JSON 只携带 Artifact 引用，不内嵌 Artifact 正文；
Fixture 还验证协议输出和持久化控制数据不记录测试 secret、机器 HOME 或用户名。需求 Source 本身按产品
合同保存为受控 Artifact，这不属于对话缓存。

## 证据分层

- 文件级证据：四类临时 HOME 的目标路径、中文 Skill、dry-run、幂等、冲突拒绝和无 `.mdc`。
- 模拟循环证据：四个 Adapter 各自执行功能与纯文档 Fixture，共八条跨进程 CLI 路径。
- 安全边界证据：本地模型端点收到零请求，协议无 Artifact 正文，控制数据无对话或 secret 标记。
- 未运行证据：真实 Codex、Claude、Cursor Skill 发现、自动触发、模型执行和真实客户端跨会话恢复。
