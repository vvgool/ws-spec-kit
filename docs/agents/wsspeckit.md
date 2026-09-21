# 工作流接入指引

## 何时使用

项目根目录存在 `.wsspec/repository.yaml` 和 `.wsspec/config.yaml` 是接入线索；这些文件存在不代表配置有效，实际 CLI 校验为准。用户要求实现功能、修复错误或新增/修改文档时，使用当前 Host 可用技能列表中的 `wsspeckit-driver`。

会话已有相关 Work Item，或用户要求“继续”时，先用原 Work Item ID 执行 `wspec continue <workItemId> --actor <执行者>`，按返回的 action 或 view.nextAction 恢复。仅在明确为独立新需求时创建新任务。多个候选或无法确认关联时询问，不根据目录名猜 ID。

咨询、解释、只读 review 和评估直接完成，不创建 Work Item。用户明确要求用 WSSpecKit 做只读评估时，使用 `wspec start --intent assessment`，生成评估记录但不创建业务 Worktree、不提交发布。

## Driver 未加载时

先说明当前 Host 未提供 Driver，不能假装调用。可用 `wspec agent status --client codex` 检查磁盘安装；Claude/Cursor 使用对应 client。普通开发请求不是修改全局安装或初始化项目的授权，报告缺失后按用户已授权的任务范围继续，不将接入问题变成重复确认关卡。

用户要求安装或配置接入时，执行 `wspec agent setup --client <客户端>`。如当前已发布 CLI 不支持 setup，先报告 CLI 版本与可用命令；本仓库源码可 `npm run build` 后使用 `node dist/cli/main.js`。

setup 只安装 Driver，项目初始化使用 `wspec init`。旧版或自定义文件冲突按诊断处理，不能删除用户文件。安装完成后需要 Host 重新加载技能或开启新会话；磁盘 current 不证明当前会话已加载。

## 项目指引维护

本仓库 AGENTS.md 的 `wsspeckit:begin` 到 `wsspeckit:end` 是工作流接入指引区块，其他内容保持独立。需要移除项目接入提示时，只移除这个区块；不删除其他 Agent 协作约定。

当前已初始化项目可通过 `wspec agent project setup` 安装受管区块，`remove` 移除；`--dry-run` 预演。自定义或损坏区块需要人工确认，不覆盖。已有文件修改后返回 recoveryFile 保留旧 inode，确认编辑器停止写入后可清理。
