# Agent 协作说明

## Agent 技能

### Issue 追踪器

Issue 和规格使用 `.scratch/` 下的本地 Markdown 追踪器。详见 `docs/agents/issue-tracker.md`。

### 分诊状态

使用本地追踪器的标准状态词汇。详见 `docs/agents/triage-labels.md`。

### 领域文档

本仓库使用单上下文领域文档布局。详见 `docs/agents/domain.md`。

<!-- wsspeckit:begin -->
<!-- wsspeckit:managed v1 prefix=0 -->
### WSSpecKit 工作流接入

项目存在 .wsspec/repository.yaml 与 .wsspec/config.yaml 时，实现功能、修复错误、修改文档使用当前 Host 已加载的 wsspeckit-driver；配置有效性以 CLI 校验为准。
继续已有任务时先执行 wspec continue <workItemId> --actor <执行者>，按 action / view.nextAction 恢复；仅独立新需求创建任务，关联不明时先确认。
咨询、解释、只读 review 和评估直接处理，不创建交付任务。
Driver 未加载时如实说明，用 wspec agent status --client <客户端> 检查磁盘；在已授权任务范围内继续，不自行修改全局安装或初始化项目。磁盘安装成功不证明当前会话已加载。
<!-- wsspeckit:end -->
