# ADR 0004：Vitest 门禁与测试前配置迁移

状态：已采纳（2026-09-17，用户确认修复）

## 背景

项目使用 Vitest，默认初始化配置却生成 node --test，并仅识别 src/**。正在 write-tests 的任务冻结了错误配置，修改项目配置不能更新它；直接篡改快照会破坏 Application 身份校验。

## 决定

支持 Vitest 3.2.4+（3.x）及 4.x 公共 reporter API，由引擎直接启动当前 Node 和项目 Vitest 入口，注入专用 reporter。Node、Vitest 及已解析的运行依赖内容、参数、环境及 reporter 参与命令摘要；报告通过受限临时文件读取校验。Vitest 报告验证 adapter 后规范化为内部统计，不改变 node-test v1 报告 Schema。工具故障不得冒充断言 Red。

init 只识别唯一简单的 Vitest test 脚本，支持根目录及 apps/packages 一级子包。多候选必须显式选定测试根目录；不执行 package scripts，不覆盖已有配置。

config migrate 以 testingConfigDigest 做并发检查，在控制面锁内记录测试配置覆盖。原始快照和 Manifest 字节保持不变。仅改变 testing 和 test Gate 执行设置，required/evidence 策略不变，其他配置必须相同。原 configDigest 保留含义；迁移配置由独立 testingConfigDigest 及命令摘要绑定。

仅允许 active 且测试提交前迁移，无待审批、TDD Evidence 或外部动作。有 write-tests Claim 时必须同 actor，工作区与领取时一致（当前任务 drafts 除外）；回收 Claim/context，重置该未执行 Attempt 的重试计数。保留历史事件，重新 acquire 新 Attempt。已有测试提交或副作用必须重新建项，不做通用中途迁移。

## 验证边界

覆盖真实 Vitest 红绿、失败分类、报告覆盖拒绝、范围与命令绑定；迁移测试覆盖公开命令、Claim 轮换、事件恢复、策略改变和脏工作区拒绝。真实用户项目迁移与发行安装需另外执行。
