# WSSpecKit

Agent 驱动的软件交付工作流引擎。控制面把需求、Workflow、Skill 和执行状态绑到 Work Item。

## Language

**Test Gate**:
Project Config 里声明的、用于产生可信 TDD Evidence 的固定测试命令与 `node-test` reporter。
_Avoid_: test command, npm test, quality gate

**Application Snapshot**:
Work Item 创建时冻结的 Workflow、Skill、配置和来源权威副本。
_Avoid_: live config, current config
