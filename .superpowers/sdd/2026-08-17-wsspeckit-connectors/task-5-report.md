# Task 5 外部动作授权、幂等与协调恢复报告

## 状态

DONE（本地协议、Fixture 与恢复门禁）。

真实 GitHub、GitLab、飞书 Provider 尚未接入本 Task 的 `ExternalActionExecutor` 做账号级验收，
因此真实外部平台与生产 readiness 仍为 NO-GO。

## 实现范围

- 新增 `ExternalActionRequest -> ExternalActionGrant -> ExternalWriteReceipt` 三段式合同和生成 Schema。
- 外部动作状态限定为 `prepared -> approved -> executing -> verified`；发送后结果不确定时进入
  `reconciliation_required`，只允许只读回查，不自动重发。
- `submit` 只接受 `external-write` Step 的单一结构化 Intent；非外部 Step 携带 `externalWrites`
  或成功的外部 Step 缺少治理后 Receipt 均 fail closed。
- Request 绑定 Work Item、Step、Attempt、Provider、动作、稳定目标、payload 摘要、Binding、输入、
  Artifact、Profile、工作区、Config、副作用和规范幂等键；Grant 与 Receipt 逐字段及摘要回绑。
- payload 不进入 Request、Grant、事件、投影、审批摘要或 Receipt；持久化的 Provider、稳定目标和
  side effects 复用递归凭据探测，拒绝 Authorization、Cookie、Token 等凭据样式内容。
- 批准在控制面锁内重新核对活动 Attempt/Lease 和当前工作区、Profile、Config；执行在
  `approved -> executing` 锁内及 Provider 调用前再次核对，漂移后必须重新准备和审批。
- Provider 必须先调用 `markDispatched()` 持久化发送边界，再执行写入；发送前故障可继续，发送后
  故障必须协调恢复。进程恢复会把 `sent_or_unknown` 转为 `reconciliation_required`。
- 重复 Submit 复用同一逻辑 Request；时钟推进不会制造新请求。已验证动作直接复用原 Receipt，
  不产生第二次 Provider 调用；同一 Attempt 的 payload 或绑定变化返回幂等冲突。
- 外部拒绝决定持久化为绑定 Request 摘要的 `external-action.rejected` 证据，重启后继续阻塞。
- Issue Close 必须位于已验证 Issue Update 之后；必需 Knowledge 失败阻塞，Profile 声明可选时转为
  `succeeded_with_warnings` 并保留显式风险。
- Close checklist 仅把同一 Attempt 的 verified External Grant/Receipt 视为 external-write 审批证据。
- `inspect` 仅返回无 payload 的外部动作身份与状态；事件重放、投影读取和 archive 均校验完整绑定。
- Governed E2E 改为注入本地 `ExternalActionExecutor`，本地文件模拟写入和回读，全程无网络调用。

## TDD 与回归证据

初始 RED 覆盖审批前零写入、错误/过期 Grant、幂等重复、发送前后崩溃、协调回查、发布顺序、
必需/可选 Knowledge 以及事件恢复，随后聚焦 Task 5、恢复和类型门禁通过。

收口阶段另外复现并修复以下回归与安全缺口：

- 完整套件首次为 `689/690`：历史 Review-Fix 循环的旧 Submit 在幂等回放前被外部治理前置校验
  拒绝。修复为零外部写入先进入原锁内幂等路径，同时在真实 mutation 中保留 external-write
  Receipt 强制检查。
- 新增防绕过测试证明成功 external-write Step 不能提交空 `externalWrites`。
- 三条新增 RED 分别证明准备后工作区变化仍可批准、批准后工作区变化仍进入 Executor、凭据样式
  side effect 可进入 Request。实现当前上下文复检和凭据探测后全部转为 GREEN。

最终外部授权、幂等、协调与旧循环聚焦回归：`41/41` passed。

## 最终验证

以下命令均在 Node.js `v22.16.0` 的当前 checkout 上执行：

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run schemas:generate
node --import tsx --test tests/contract/schemas.test.ts
git diff --check
```

- `npm test`：694 passed，0 failed，0 skipped。
- `npm run lint`：passed。
- `npm run typecheck`：passed。
- `npm run build`：passed。
- Schema 生成：passed；checked-in Schema 合同 `9/9` passed。
- 公共文档基线 targeted：`12/12` passed。
- E2E targeted：`66/66` passed；同一批 E2E 也包含在最终 `npm test` 中。
- `git diff --check`：passed（无输出）。

## 证据边界与剩余风险

- 已验证：内存/文件 Fixture、Application 协议、TTY 决策边界、事件持久化与重放、投影恢复、
  本地 Provider 写入模拟、回读摘要、幂等和 Close 约束。
- 未验证：真实 `gh`、`glab`、`lark-cli` 写账号，真实平台限流/权限/并发语义，真实 Issue/文档状态
  协调，生产部署和故障恢复。
- 本 Task 未执行任何网络请求或真实外部副作用，未开始 Task 6。

## Commit

独立提交信息：`feat: govern external connector effects`。
