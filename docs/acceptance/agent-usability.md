# Agent 接入与流程优化验收

## 本次行为

- agent status 区分未安装、当前版本、旧版、冲突；Host 是否加载独立报告 unknown。
- agent setup 一步创建目录、安装并复核，旧版/自定义内容不会覆盖。
- agent project setup/remove 管理当前初始化项目的 AGENTS.md 区块，保留用户内容；替换已有文件返回 recoveryFile。
- start --intent 显式区分 feature/fix/assessment/docs，不按关键词猜测，更不将“继续”当作新任务。
- continue 恢复原有效 grant；complete 自动 author Artifact 并提交，保留 actor、Lease、原包及幂等校验。
- bugfix 使用专用 bugfix-diagnosis，将诊断与修复计划合并为 tasks；后续 review 直接依据诊断与预期行为，不再要求补造独立 PRD/design。assessment 留档评估但不创建业务 Worktree、不提交或发布。

## 减少了哪些操作

以下为当前资源及 API 结构的可核对差异，不是实际开发耗时或模型自动触发率：

| 用户路径 | 原方式 | 当前方式 |
| --- | --- | --- |
| 首次安装 | 手工建目录，再 install | 一次 agent setup |
| 修复前准备（quick） | explore、clarify、plan 三份 Agent 产物 | explore 一份诊断/修复 tasks |
| 修复前准备（standard） | explore、clarify、design、plan 四份 Agent 产物 | explore 一份完整 tasks，并保留审批 |
| 一步有 N 份输出 | N 次 artifact create + 1 次 submit，手填 grant 字段 | 1 次 complete，原包 + N 个输出文件映射 |
| 重返活动任务 | inspect + acquire，可能更新 lease | continue 原样恢复有效 grant |
| 留档只读评估 | 无专门内置流程，容易误走文档交付 | intake → assess → close |

## 已有自动化证据

- Driver 安装：tests/e2e/driver-install.test.ts，覆盖旧版识别、四客户端、预演、幂等、链接及目录置换。
- 项目指引：tests/unit/project-guidance.test.ts，覆盖原文/LF/CRLF、重复操作、冲突、临界大小、并发操作及旧 fd 写入保留。
- 只读评估：tests/integration/assessment-workflow.test.ts，三个 Profile 从开始到归档、缺报告拒收、重启恢复；业务 HEAD/Worktree 无变化，外部执行器零调用。
- 修复分流：tests/integration/bugfix-workflow.test.ts、tests/unit/compiler.test.ts，低风险进入测试、高风险升级并重新审批，Red/Green/审查/提交门禁保留。
- 高层操作：tests/integration/agent-actions.test.ts，过期及他人 Claim 拒绝、跨任务/篡改拒绝、提交重试、物化后重放、真实可信 Red→Green。
- 进程级入口：tests/e2e/application-cli.test.ts，四意图、项目接入和高层评估闭环。

## 真实环境验收状态

早先仅检查 PATH，没有发现 codex CLI；随后找到 Zed 内置 Codex CLI 0.154.0，并已用真实新会话验收。磁盘安装状态与 Host 实际使用仍分别核对；没有修改用户全局 Driver 或依赖当前对话自动重载。具体实测见下节。

真实 Host 验收需安装已交付版本后开启新会话，确认技能可发现，并分别提出新需求、错误修复、普通咨询、只读评估和继续原任务，记录实际是否加载 Driver、所选工作流和不必要打断次数。不能以时间过去代替验收通过。

Issue/Wiki 真实发布继续依赖目标平台身份和项目绑定。本批保留原链路及测试，并未向真实外部系统写入，不能声称真实 wiki 交付验收通过。

## 2026-09-21 本地验证记录

本次仍为 feat/agent-onboarding 工作区改动，未提交、发布或更新真实本机安装。

- 完整 npm test 首轮：1,101 项，1,096 通过、5 失败，无跳过。
- 其中 4 项为新 CLI / 工作流导致的旧断言及只读测试 fixture 写入问题，修正后重跑所属四个 E2E 文件：55/55 通过。
- 另 1 项为全套运行期间更新内置 code-review Skill 导致 Skill Lock 摘要变更；冻结资源后原失败的过期实现恢复用例通过。
- 新增 Skill URI 文档遗漏由契约测试检出并修正；最终契约测试 84/84 通过。
- 冻结最终资源后，受影响模块回归 68/68 通过，四个 E2E 文件再次验证 55/55 通过（含打包后的干净消费者安装）。
- 类型检查与构建通过，git diff --check 通过；仓库 AGENTS 受管区块已验证 canonical / 幂等。

这里记录的是“完整首轮 + 修复后受影响范围复验”，没有将不同轮次结果冒充为一次完整全绿运行。真实 Host 和外部平台验收仍按上节保持未完成。

## 2026-09-21 真实 Host 验收：体验尚未通过

### 环境与证据边界

使用 Zed 内置 Codex CLI 0.154.0、用户现有模型配置，在六个隔离场景中发出自然语言请求。CLI 来自本次 npm pack 后安装到干净 consumer 的包；使用 generic Driver 安装到项目本地 .agents/skills，由真实 Codex 发现并读取。没有脚本替 Agent 编造产物或选择工作流，也没有向真实 Issue/Wiki 写入。测试不证明所有 Host 或所有提示下的触发率。

最终包完整性：`sha512-6VdDI2izxxfhsMsTyqlriZYHttV1nH9ZL9BDDWLjn+TFTddxuFD8HQJQqV3ibWl3yFtyCU+XWX8Ic5ZVsWTbQw==`。包仍标记工作区 beta.15，不是已发布新版。临时环境为 `/private/tmp/wspec-real-acceptance-final-osFLGE`；原始事件与测试脚本在本地 `.scratch/agent-usability/acceptance/` 记录，避免把带临时授权字段的原始日志提交到仓库。

### 已确认的行为

- 普通咨询：回答项目用途及错误实现，不启动 Work Item，工作区干净。
- 小修复：主动使用 Driver 和 bugfix 流程，真实读取 bugfix-diagnosis；完成 tasks 后进入 write-tests，按测试要求停止，未修改业务代码。中间发生章节补写与 Lease 重领，不算无返工通过。
- 新功能：主动选择 feature-delivery，停在 clarify 的真实 awaiting_approval。没有越过审批，但后续计划尚未执行，不能称完整新功能交付完成。
- 文档：主动选择 documentation-delivery，实际修改隔离 Worktree 的 README，通过文档 Gate 与审查，停在 commit 执行前；未提交、未推送。期间出现章节、结构化任务、草稿定位和缺输出返工。
- 跨会话恢复：独立新会话沿用 `WSS-01M3147A1A8MX3MDZ1DHB2XMVF` 恢复 write-tests，未新建任务，未编写测试。
- 只读评估：前两轮都曾完成归档；最终指引新会话再次出现高低层协议混用、必填字段错误及过期重领。在 10 分钟验收时限内未归档，停止后核对仍为 assess / active，业务文件未改。因此不能把早先成功归档当成最终版稳定通过。

最终一轮实测（错误数来自已完成命令输出中的 CLI `ok:false`，不包括 Host 自身网络重试）：

| 场景 | Host 命令数 | CLI 错误数 | 实际结束点 |
| --- | ---: | ---: | --- |
| 咨询 | 2 | 0 | 无 Work Item，业务工作区干净 |
| 留档评估 | 21 | 9 | assess，10 分钟未归档 |
| 小修复准备 | 15 | 2 | write-tests，未编写测试 |
| 新功能准备 | 13 | 2 | clarify / awaiting_approval，未越过审批 |
| 文档交付 | 23 | 4 | commit 前；仅 Worktree README 改动 |
| 新会话恢复 | 3 | 0 | 原 Work Item 的 write-tests，无重复任务 |

引擎状态独立核对确认文档 verify-document 与 review-fix 已 succeeded，存在 trusted docs.integrity Evidence；所有业务仓库 HEAD 均未变化。证据摘要、原始事件与 SHA-256 清单保存于本地 `.scratch/agent-usability/acceptance/evidence/final/`。

### 本轮发现并已修的问题

1. Host workspace-write 将 Git 元数据设为只读，start 在创建 `.git/wsspec/work-items` 时遇到 EPERM，却仅显示 INTERNAL_ERROR。已增加 `WSSPEC_FILESYSTEM_PERMISSION_DENIED` 固定恢复指引和真实 macOS 沙箱回归，不反射路径、不修改 Host 安全设置。后续流程测试仅显式增加隔离仓库 `.git` 的写权限，仍保留 workspace-write 沙箱。
2. Driver 没有完整 complete 输入例子。已补齐字段与对象数组示例、业务改动和草稿的区别、必须读取步骤 Skill 的规则，以及绑定的正文定位方式。通过真实 Host 发现后修复，而非仅文字评审。

### 尚未解决的阻断与下一步

1. 日常高层入口和低层兼容合同同时出现，真实 Agent 仍可能把 complete wrapper 提交给旧 submit。应拆开默认执行入口与恢复参考，并给出绑定当前执行包的完整可用模板。
2. requiredOutputs 没有直接可用的产物模板，Agent 会遗漏规格章节和 tasks YAML，靠错误逐项修补。需提供与正式 schema 一致的模板入口，覆盖功能、文档、评估。
3. 默认 Lease 是 60 秒，真实阅读/写产物反复超时；需设计适合 Host 执行时长的默认值或显式续期，同时保留过期拒绝、actor/digest 校验和审计。当前未擅自放宽此规则。
4. `wspec start --help` 不支持，真实 Agent 只能退回全局帮助或读实现，应补齐子命令帮助。

这些问题已进入本地任务 `issues/06-real-host-acceptance.md`。Issue/Wiki 验收等待用户指定测试目标与写入授权；当前仓库本身无项目绑定，GitLab 未认证，Feishu 的无副作用 Doctor 也不能证明身份可用。不能向任意业务目标写入来代替验收。

### 最终自动化结果

包含本轮权限错误与 Driver 输入模板回归的完整测试：**1,105 / 1,105 通过，0 失败、0 跳过**，耗时约 691 秒。类型检查、构建与差异检查通过。这是完整一轮结果，不是将局部重跑拼成全绿；但它不能覆盖上表已经观察到的真实 Host 体验失败。当前未提交、发布或更新用户全局安装。
