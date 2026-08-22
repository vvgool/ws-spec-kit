# Agent Driver 统一契约验收

## 验收范围

本验收只证明当前 checkout 的 Driver Skill 文件安装和受控 Fixture 模拟循环，不证明真实 Codex、
Claude 或 Cursor Host 已发现、触发或执行该 Skill。真实 Host 的自动触发、显式触发、模型行为、权限和
跨会话体验必须由后续真实客户端验收单独记录；本结果不得冒充真实 Host 通过，也不得扩大为发布或生产
可用结论。

## 文件安装

当前安全安装只在 macOS 验证，并依赖系统 `/usr/bin/python3`。先创建最终目标目录，再执行公开命令：

```sh
mkdir -p ~/.agents/skills/wsspeckit-driver
wspec agent install --client codex
mkdir -p ~/.claude/skills/wsspeckit-driver
wspec agent install --client claude
mkdir -p ~/.cursor/skills/wsspeckit-driver
wspec agent install --client cursor
mkdir -p <安装目录>
wspec agent install --client generic --target <安装目录>
```

Codex、Claude、Cursor 分别安装到宿主约定的 `~/.agents/skills/wsspeckit-driver/SKILL.md`、
`~/.claude/skills/wsspeckit-driver/SKILL.md` 和 `~/.cursor/skills/wsspeckit-driver/SKILL.md`。
Generic 没有可推断的宿主目录，必须显式提供 `--target`。四类目标目录都必须预先存在，安装器不会创建
任何祖先或目标目录。安装器支持 `--dry-run`；同 v4 canonical 摘要只读复验并保持幂等，历史 v1-v3、
未知或被修改的同名内容都拒绝覆盖或原地升级。四类安装只生成中文说明的 `SKILL.md`，不生成 `.mdc`
或后台 Runner。

安全 helper 固定使用 canonical、root-owned 且不可 group/world write 的 `/usr/bin/python3 -I -S`；请求只从
stdin 接收结构化 JSON，stdout 仅允许有界固定 JSON，不继承 HOME、PYTHONPATH 或用户凭据，并受超时和
输出上限约束。helper 从根目录开始以 `dir_fd`、`O_DIRECTORY`、`O_NOFOLLOW` 逐段打开预创建目标并核对
最终 inode；新文件只用 `O_CREAT | O_EXCL | O_NOFOLLOW` 写入、fsync 和关闭，现有 v4 只读复验，不执行
pathname `mkdir` 或 `rename`。祖先/最终 symlink、hardlink、非普通文件和两个 parent-swap race 都 fail
closed，且对抗测试验证外部目录无新增或修改。

## 模拟协议循环

Driver v4 正文同时提供人可执行的中文 Host 指南和 fenced JSON `wsspeckit-driver-contract`。结构化合同声明
功能/文档 Workflow 选择、`new`/`recovery` 入口、四条命令的 argv 模板、输出 capture、action 分支与终点。
验收解释器只从安装后的 JSON 合同派生命令，不在测试代码中维护第二套协议。

每类 Adapter 都对功能任务和纯文档任务执行相同的真实 CLI 子进程序列：

```text
新任务：显式 workflowRef 的 start
恢复：新进程 inspect -> 新进程 acquire
执行：读取 Work Package 引用 -> 当前 Agent 执行 -> 新进程 submit
继续：直接处理 submit 返回的 action，直到审批、阻塞或完成
```

`acquire` 和 `submit` 都返回 `execute / await_approval / blocked / completed`。`submit.execute` 已携带并
claim 下一份 Work Package，Host 必须直接执行并继续 submit；若此时错误地再次 acquire，协议会返回
`WSSPEC_STAGE_ALREADY_CLAIMED`。只有 start 后首次进入和 Host 中断恢复才使用 `inspect -> acquire`。
每条 Fixture 都验证 fresh-process recovery、至少两个 execute grants 和至少两次 submit，并到达明确 blocked
终点；功能 Fixture 由本地可信门禁边界停止，文档 Fixture 在不执行真实编辑的边界显式提交 failed 后停止。

功能任务固定选择 `builtin://workflows/feature-delivery`，纯文档或无代码变更任务固定选择
`builtin://workflows/documentation-delivery`。项目默认 Workflow 在创建后发生变化时，已有 Work Item 仍
保持创建时的 `workflowRef`，Driver 不得静默切换。

Driver 和 WSSpecKit Runtime 不调用模型 API，不缓存或管理 Agent 对话、Token、记忆或隐藏推理。模型上下文
由真实 Agent Host 自主管理。Work Package 和其他协议 JSON 只携带 Artifact 引用，不内嵌 Artifact 正文；
Fixture 还验证协议输出和持久化控制数据不记录测试 secret、机器 HOME 或用户名。需求 Source 本身按产品
合同保存为受控 Artifact，这不属于对话缓存。

## 证据分层

- 文件级证据：四类临时 HOME 的目标路径、中文 Skill、dry-run、幂等、冲突拒绝和无 `.mdc`。
- 模拟循环证据：四个 Adapter 各自执行功能与纯文档 Fixture，共八条由安装产物 manifest 驱动的跨进程 CLI 路径。
- 路径安全证据：四类 Adapter 的预创建目录、祖先/最终 symlink、hardlink、非普通文件，以及 mkdir/rename 两个 parent-swap probe 均 fail closed。
- 安全边界证据：本地模型端点收到零请求，协议无 Artifact 正文，控制数据无对话或 secret 标记。
- 未运行证据：真实 Codex、Claude、Cursor Skill 发现、自动触发、模型执行和真实客户端跨会话恢复。
