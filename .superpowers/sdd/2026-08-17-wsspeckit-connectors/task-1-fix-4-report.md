# Task 1 Fix Round 4 报告：Unavailable Provider 惰性 Doctor 与 PID-ready 测试

## 状态

完成。修复基线为 `7ccc060 fix: make connector doctor side effect free`，范围严格限定在 Task 1 的 Doctor 返回合同、Connector 参考文档和对应测试；未进入 Task 2，未合并、推送、发布，也未执行真实 lark-cli 的 auth、version 或 fetch 命令。

本轮关闭 `task-1-fix-3-review.md` 剩余的 1 个 Important 和 1 个 Minor：`auth.kind: unavailable` Provider 的 version probe 仍有副作用，以及 timeout PID 文件依赖 80ms 调度的测试抖动。

## Finding 关闭情况

1. **Unavailable Provider 完全不执行 CLI：已关闭。** Doctor 仍先调用 executable locator；未找到时返回 `missing_binary`。定位成功后，若认证合同为 `unavailable`，立即返回 `unauthenticated`、固定 `WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE` 和固定 diagnostic，不构造 Provider environment，不执行 version/auth 或任何其他 CLI，不返回 `version`，也不能返回 `available`。
2. **返回类型收紧：已关闭。** `ConnectorHealth` 改为判别联合。携带 `DoctorAuthUnavailableReasonCode` 的 `unauthenticated` 分支类型上禁止 `version`；受审计认证失败仍保留已安全探测到的 version。
3. **既有分支未被放宽：已验证。** unavailable Provider 的 locator 缺失仍返回 `missing_binary`；外部 Provider 使用 `auth.kind: none` 仍由 Manifest fail closed；本地 git 的 `none` 仍执行受审计 `--version`，满足最低版本后返回 `available`。
4. **PID-ready 时序抖动：已关闭。** 测试 fixture 进程先同步写入自身 PID，再进入长等待。测试先启动真实 `spawnJson` Promise，轮询并确认有效 PID ready，然后等待原生产 timeout，最后验证负 PGID 已返回 `ESRCH`。生产代码未增加 test hook，测试 timeout 从脆弱的 80ms 调整为 3s，没有缩短、替换或旁路生产 timeout。

## TDD 与对抗证据

- RED 第一次：新 unavailable fixture 在旧实现上得到额外 `version: "2.2.0"`，证明 version probe 已执行。
- RED 第二次：将 provider invocation 断言前置后，旧实现失败为 `Missing expected rejection`；invocation log 已创建，直接证明发生了 provider spawn。
- GREEN：最小生产修改仅把 `unavailable` 分支移动到 locator 成功之后、environment/version probe 之前。相同 fixture 下 locator 恰好调用一次，invocation log 不存在，恶意 `--version` 分支的 HOME marker 不存在，隔离 HOME 的目录清单前后完全一致，结果不含 `version`。
- timeout ready 用例在并行负载下重复 3 次均通过；每次约 3.08s 后由真实生产 timeout 返回，再验证进程组不存在。
- 本轮未读取真实认证文件，未访问真实外部账号或服务，未运行真实 lark-cli 命令。零文件与零网络副作用由 locator 后零 provider spawn 的 fixture 边界保证。

## 文档与后续边界

参考文档明确：无法安全探测认证的 Provider 不提供 version 或 available；省略 version 不代表二进制缺失。Task 4 必须在正式工作流中通过与当前请求、Provider 和外部对象绑定的实际只读 fetch 另行验证认证与可用性，不能复用 Doctor locator 或本地 fixture 作为真实集成证据。

## 最终验证

- 聚焦：`node --import tsx --test tests/unit/connector-registry.test.ts tests/unit/spawn-json.test.ts tests/unit/redaction.test.ts tests/integration/connector-doctor.test.ts`
  - 55/55 tests PASS，0 fail，退出码 0。
- timeout PID-ready 用例并行重复 3 次：3/3 PASS，退出码均为 0。
- 文档契约聚焦：`node --import tsx --test tests/contract/documentation-baseline.test.ts`
  - 12/12 tests PASS，0 fail，退出码 0。
- `npm test`
  - 524/524 tests PASS，0 fail，退出码 0。
- `npm run lint`：PASS，退出码 0。
- `npm run typecheck`：PASS，退出码 0。
- `npm run build`：PASS，退出码 0。
- `npm run schemas:generate`：PASS，退出码 0。
- `git diff --exit-code -- schemas`：PASS，无 schema drift。
- `git diff --check`：PASS。

## 剩余关注点

- 本轮证明的是本地 Doctor/fixture 合同，不是 GitHub、GitLab、飞书真实账号、网络、授权或只读 fetch 验收；Task 4 仍需单独完成。
- executable locator 和定位到的安装路径仍属于宿主信任边界；本轮只保证 locator 成功后的 unavailable 分支不启动 Provider。
- POSIX process-group cleanup 与 PID-ready fixture 在本机 macOS 验证，尚未在 Linux 主机执行。
- 同组 cleanup 不覆盖 Provider 主动创建新 session 的逃逸，也不是 OS 级沙箱。
