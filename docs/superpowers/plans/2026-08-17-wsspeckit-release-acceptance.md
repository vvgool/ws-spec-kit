# WSSpecKit 完整工作流与发布验收计划

> **Agent 执行要求：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务执行；前三份计划门禁全部通过后开始。

**目标：** 在 Codex、Claude、Cursor 中完成真实中文 Driver Skill 与跨会话恢复验收，对 Generic Adapter 完成安装和统一协议契约验收，并验证项目自定义 Workflow 与真实 GitHub/GitLab/飞书交付，产出可审计的 npm 发布候选。

**架构：** 自动化契约验证、真实宿主 Smoke、真实外部平台验收和发布包验收分层执行。每层独立记录环境、版本、命令、目标、摘要和结果；任何较低层证据都不能替代较高层。

**技术栈：** Node.js 22、TypeScript、npm、Codex CLI/App、Claude Code、Cursor Agent/CLI、`gh`、`glab`、`lark-cli`。

## 全局约束

- 不新增核心协议；发现协议缺口必须回到对应计划修复并补回归测试。
- 所有发布文档、模板、CLI 文案和 Skill 正文使用中文。
- 不在仓库中记录 Cookie、Token、CLI 配置、用户名、个人目录或未脱敏远端正文。
- 真实验收只使用专用测试仓库、Issue 和飞书空间；每个外部写入仍需本次精确授权。
- 缺少客户端、CLI、认证或测试目标时状态为 `not_run`，对应层级为 NO-GO。
- 本计划生成发布候选和报告，不执行 `npm publish`、push、merge 或 release。

---

### Task 1：项目自定义 Workflow 与 Global Skill E2E

**文件：**
- 创建：`tests/e2e/custom-workflow.test.ts`
- 创建：`tests/fixtures/workflows/custom-delivery/*`
- 创建：`tests/fixtures/skills/{package-security-review,global-security-review,project-security-review}/*`

**接口：**
- 输入：`workflow list/show/eject/validate/use`、四类 Skill Resolver 和 Workflow 快照。
- 输出：无新接口；形成用户自定义能力验收。

- [ ] **步骤 1：编写失败 E2E**

在临时 HOME 和项目中 eject 内置 Workflow，新增 Package Skill、Project Skill、安全 Review Step 和
`global://global-security-review` + Builtin fallback。分别断言 Global 命中、缺失走 fallback、
同名同摘要去重、同名不同摘要返回 `WSSPEC_SKILL_AMBIGUOUS`；移动 Package 后
`package://skills/security-review` 仍绑定同一摘要，且活动 Work Item 使用其快照。

- [ ] **步骤 2：运行失败测试**

运行：`node --import tsx --test tests/e2e/custom-workflow.test.ts`

预期：若基础计划接线完整则 PASS；否则明确指出缺失的 workflow/Skill 契约，不允许修改测试绕过。

- [ ] **步骤 3：补齐快照不变性场景**

启动 Work Item 后修改 Workflow、Project Skill 和 Global Skill：活动 Work Item 的 Workflow/
Project 快照保持不变，Global 摘要变化阻塞未开始 Step；更新锁或选择 fallback 必须产生决策记录。

增加所有非 Builtin Workflow Package 的信任场景，同时覆盖 `project://` 和外部安装 Package：首次 `workflow use` 返回来源、文件清单摘要、Skill 摘要和副作用能力，未确认时不能启用或 `start`；明确拒绝保持 blocked；确认后相同摘要可复用。随后分别修改普通文件和新增 `external-write` 能力，断言旧信任失效并要求重新确认；仅移动相同摘要 Package 不失效；非交互执行必须返回 `WSSPEC_WORKFLOW_TRUST_REQUIRED`。信任确认后仍要单独申请外部写入授权。

- [ ] **步骤 4：运行并提交**

运行：`node --import tsx --test tests/e2e/custom-workflow.test.ts tests/integration/skill-lock.test.ts && npm run typecheck`

预期：PASS。

```bash
git add tests/e2e/custom-workflow.test.ts tests/fixtures/workflows tests/fixtures/skills
git commit -m "test: cover project workflow customization"
```

### Task 2：Driver 安装与统一协议契约

**文件：**
- 创建：`tests/e2e/agent-driver-contract.test.ts`
- 创建：`tests/fixtures/agent-homes/{codex,claude,cursor,generic}/*`
- 创建：`docs/acceptance/agent-driver-contract.md`

**接口：**
- 输入：`wspec agent install --client <provider> [--target <path>]`。
- 输出：四类中文 Driver Skill 及统一 `start/inspect -> acquire -> submit` 循环。

- [ ] **步骤 1：编写安装路径失败测试**

Codex 目标为 `~/.agents/skills/wsspeckit-driver/SKILL.md`，Claude 为
`~/.claude/skills/wsspeckit-driver/SKILL.md`，Cursor 为
`~/.cursor/skills/wsspeckit-driver/SKILL.md`，Generic 必须显式 target。覆盖 dry-run、已有同摘要、
已有不同内容拒绝覆盖、中文 frontmatter/正文、无 `.mdc` 输出。

- [ ] **步骤 2：编写 Driver 循环失败测试**

为每个 Adapter 分别执行功能与纯文档 Fixture：Driver 为新任务传递明确的 `workflowRef`，随后
`acquire/submit`；中断后用新进程 `inspect/acquire` 恢复。断言文档任务选择
`documentation-delivery`、功能任务选择 `feature-delivery`，且 Driver 不调用模型 API、不缓存对话、
不把 Artifact 正文塞进协议 JSON，也不在创建后切换 Workflow。

- [ ] **步骤 3：运行契约测试**

运行：`node --import tsx --test tests/e2e/agent-driver-contract.test.ts`

预期：PASS；失败必须按 Provider 报告目标路径或协议差异。

- [ ] **步骤 4：记录契约范围并提交**

文档明确此任务仅证明文件安装和模拟 Agent 循环，不能标记真实 Codex/Claude/Cursor 通过。

```bash
git add tests/e2e/agent-driver-contract.test.ts tests/fixtures/agent-homes docs/acceptance/agent-driver-contract.md
git commit -m "test: validate agent driver contracts"
```

### Task 3：真实 Codex、Claude、Cursor 客户端验收

**文件：**
- 创建：`scripts/acceptance/prepare-agent-smoke.mjs`
- 创建：`scripts/acceptance/verify-agent-smoke.mjs`
- 创建：`docs/acceptance/{codex,claude,cursor}-live.md`
- 创建：`docs/acceptance/agent-live-matrix.yaml`

**接口：**
- 输入：已安装客户端、隔离临时仓库和生成的 Smoke Work Item ID。
- 输出：每个宿主的版本、Skill 发现、协议调用、跨会话恢复和完成证据。

- [ ] **步骤 1：实现可重复 Smoke Fixture**

`prepare-agent-smoke.mjs --client <name>` 创建临时 Git 仓库、安装 Driver，并启动固定 Quick TypeScript 代码任务：为现有模块增加一个无副作用纯函数及对应测试。Fixture 预置可运行的测试命令，但不包含目标函数实现；
输出 work item ID 和中文操作提示。`verify-agent-smoke.mjs` 只读取事件、Artifact、Git diff 和状态，
断言至少一次真实 `acquire/submit`、紧凑计划、测试先失败后实现、同一 `commandId` 的 trusted Red/Green Evidence、Review、外部 Close
（存在 Issue Binding 时）和 Work Item Close。

- [ ] **步骤 2：运行真实 Codex 验收**

启动全新 Codex 任务，让用户只描述 Smoke 需求而不显式点名 Skill；记录是否自动触发。再显式调用
Driver 完成流程，中断并开启第二个任务用 `inspect + acquire` 恢复。运行 verifier，预期 PASS。

- [ ] **步骤 3：运行真实 Claude Code 验收**

在同构隔离仓库启动 `claude`，先验证 `/skills` 可见 Driver，再做自动触发、显式触发和第二会话恢复。
运行 verifier，预期 PASS。若客户端不可用或未认证，记录 `not_run`，不得模拟。

- [ ] **步骤 4：运行真实 Cursor 验收**

在 Cursor Agent/CLI 打开隔离仓库，确认 Customize/Skills 或 `/` 菜单可见 Driver；执行自动触发、
显式触发和新 Agent 会话恢复。运行 verifier，预期 PASS。不能只检查文件存在。

- [ ] **步骤 5：提交脱敏证据**

每份文档记录日期、OS、客户端版本、WSSpecKit commit、Work Item 脱敏 ID、调用序列、verifier 摘要、
GO/NO-GO 和失败原因。禁止粘贴完整对话或用户目录。

```bash
git add scripts/acceptance docs/acceptance/codex-live.md docs/acceptance/claude-live.md docs/acceptance/cursor-live.md docs/acceptance/agent-live-matrix.yaml
git commit -m "test: record live agent acceptance"
```

### Task 4：真实 GitHub 与 GitLab Issue 验收

**文件：**
- 创建：`scripts/acceptance/issue-live.mjs`
- 创建：`docs/acceptance/{github,gitlab}-live.md`
- 创建：`docs/acceptance/external-live-matrix.yaml`

**接口：**
- 输入：专用测试 Issue URL、对应 CLI 已认证状态和明确写入授权。
- 输出：读取快照、更新、关闭/恢复原状态与回读 Evidence。

- [ ] **步骤 1：实现只读预检**

运行 `wspec doctor connectors`，随后 `issue-live.mjs --provider github|gitlab --issue <url> --read-only`。
脚本输出稳定 ID、正文摘要和状态，不输出正文。未安装 `glab` 时 GitLab 必须为 `not_run`。

- [ ] **步骤 2：执行 GitHub 写入验收**

在专用 Issue 写入唯一验收标记、完成知识发布后关闭并回读 Issue 状态，再按单独授权恢复测试目标。
重复相同幂等键，断言没有第二条写入；尝试在知识发布前 Close 必须被本地顺序 Gate 拒绝。
记录 `gh --version` 和脱敏目标。

- [ ] **步骤 3：执行 GitLab 写入验收**

安装并认证 `glab` 后在专用 Issue 执行同样的更新、知识发布、Close、回读和越序拒绝矩阵，
额外断言 `iid` 与全局 `id` 映射正确。
本机未满足前置条件时保持 NO-GO，不切换成未设计的 HTTP Token Provider。

- [ ] **步骤 4：提交脱敏结果**

```bash
git add scripts/acceptance/issue-live.mjs docs/acceptance/github-live.md docs/acceptance/gitlab-live.md docs/acceptance/external-live-matrix.yaml
git commit -m "test: record live issue acceptance"
```

### Task 5：真实飞书来源与知识发布验收

**文件：**
- 创建：`scripts/acceptance/feishu-live.mjs`
- 创建：`docs/acceptance/feishu-live.md`
- 修改：`docs/acceptance/external-live-matrix.yaml`

**接口：**
- 输入：专用需求文档 URL、专用 folder/wiki target、`user|bot` 身份和明确写入授权。
- 输出：需求 Source Artifact、发布文档 token/URL、标题与正文摘要回读 Evidence。

- [ ] **步骤 1：执行认证与只读预检**

运行 `lark-cli auth status`、`wspec doctor connectors` 和
`feishu-live.mjs --source <url> --read-only`。只记录 CLI 版本、身份类型、脱敏 token 和摘要。

- [ ] **步骤 2：执行创建、更新和回读**

从固定规格/设计/验证 Fixture 生成中文知识文档，分别验证 `+create`、`+update`、`+fetch`；比较
title、doc token 和规范化正文摘要。重复幂等键不得创建第二份文档。

- [ ] **步骤 3：验证失败路径**

对无权限目标做只读或 dry-run 探测，断言错误脱敏且不形成成功 Evidence；人为制造回读摘要不一致，
断言 Work Item 进入 reconciliation 或 blocked，而非 Close。

- [ ] **步骤 4：提交脱敏结果**

```bash
git add scripts/acceptance/feishu-live.mjs docs/acceptance/feishu-live.md docs/acceptance/external-live-matrix.yaml
git commit -m "test: record live Feishu acceptance"
```

### Task 6：中文文档与可安装发布包

**文件：**
- 创建：`README.md`
- 创建：`docs/guide/{getting-started,workflow,skills,profiles,connectors,recovery}.md`
- 修改：`package.json`
- 修改：`tests/contract/chinese-content.test.ts`
- 创建：`tests/e2e/packed-install.test.ts`

**接口：**
- 输入：前述实现、参考文档和验收矩阵。
- 输出：只含正式 WSSpecKit v1 内容的 npm tarball。

- [ ] **步骤 1：扩展中文与发布清单失败测试**

扫描 README、指南、模板、CLI 和内置 Skill；允许英文协议字段、命令、URI、Schema ID 和错误码，
其他用户文案必须中文。Tarball 只允许 `dist`、`schemas`、`resources`、中文 README、LICENSE、package manifest。

- [ ] **步骤 2：运行测试确认文档缺失**

运行：`node --import tsx --test tests/contract/chinese-content.test.ts tests/e2e/packed-install.test.ts`

预期：FAIL，列出缺失指南或发布清单差异。

- [ ] **步骤 3：完成指南和 tarball 安装 E2E**

指南覆盖安装、初始化、五操作协议、功能/文档两个内置 Workflow、三 Profile、自定义 Workflow、Workflow Package 信任、四类 Skill、四个 Provider、审批、恢复和故障诊断。从 `npm pack` 产物安装到全新临时项目，分别执行功能 Quick Fixture、文档 Quick Fixture 和 Driver dry-run；文档 Fixture 必须有 trusted 文档 Gate 且不存在 TDD Evidence。

- [ ] **步骤 4：运行并提交**

运行：`npm pack --dry-run && node --import tsx --test tests/e2e/packed-install.test.ts tests/contract/chinese-content.test.ts`

预期：PASS。

```bash
git add README.md docs/guide package.json tests/contract/chinese-content.test.ts tests/e2e/packed-install.test.ts
git commit -m "docs: publish the Chinese WSSpecKit guide"
```

### Task 7：最终发布门禁与分层报告

**文件：**
- 创建：`scripts/run-release-gate.sh`
- 创建：`scripts/check-release-baseline.mjs`
- 创建：`docs/acceptance/release-report.md`
- 创建：`docs/acceptance/requirements-traceability.yaml`

**接口：**
- 输入：当前 commit、干净工作树要求和全部验收矩阵。
- 输出：本地自动化结果与各真实层级独立 GO/NO-GO。

- [ ] **步骤 1：编写失败的发布基线检查**

检查旧产品名、旧 Schema、旧命令、`WSK-`、`WSPEC_`、旧文档、占位符、未预期 tarball 文件、
未提交生成物和矩阵字段缺失。逐项校验设计中的 `REQ-01` 至 `REQ-20` 均绑定真实 Task 和 Evidence；
负例 Fixture 必须通过显式 allowlist，不得全局忽略。

- [ ] **步骤 2：实现确定性门禁脚本**

脚本使用 `set -euo pipefail`，依次运行文档基线、Schema 漂移、中文扫描、lint、typecheck、全部测试、
build、pack、干净安装 E2E；任何检查不得用 `|| true` 掩盖失败。

- [ ] **步骤 3：运行最终门禁**

运行：`bash scripts/run-release-gate.sh`

预期：本地自动化全部 PASS；真实客户端和平台状态从 YAML 矩阵读取，`not_run` 不导致脚本伪失败，
但报告对应发布层级必须 NO-GO。

- [ ] **步骤 4：生成并审阅报告**

报告分别列出：静态/单元、Fixture 集成、tarball 干净安装、Generic Adapter 契约、Codex、Claude、Cursor、GitHub、GitLab、飞书。Generic 只代表显式目标目录下的安装和统一协议契约，不得报告为真实客户端；只有声明为首版发布必需的层级全部 `passed` 才给总体 GO，不得把未运行写成“待补但可发布”。

- [ ] **步骤 5：提交**

```bash
git add scripts/run-release-gate.sh scripts/check-release-baseline.mjs docs/acceptance/release-report.md docs/acceptance/requirements-traceability.yaml
git commit -m "build: add the WSSpecKit release gate"
```

## 完成定义

四份计划的自动门禁全部通过；功能/文档两个内置 Workflow、Quick/Standard/Governed 和项目自定义 Workflow 均完成 E2E；
Codex、Claude、Cursor 的真实发现与跨会话恢复有可重复证据；GitHub、GitLab、飞书真实验收各自
独立报告；Generic Adapter 的安装和协议契约独立通过；`REQ-01` 至 `REQ-20` 的追踪矩阵不存在未绑定或必需证据缺失项。任何 `not_run`
或失败都明确降低对应发布结论，发布脚本不执行外部发布动作。
