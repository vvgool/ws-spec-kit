# Task 1 Fix Round 3 报告：Doctor 无副作用与进程组收口

## 状态

完成。修复基线为 `bdf6196 fix: close connector process residual gaps`，范围严格限定在 Task 1 的 Connector Manifest、进程适配器、Doctor 和对应测试；未进入 Task 2，未合并、推送、发布或执行真实账号认证。

本轮只关闭 `task-1-fix-2-review.md` 的两个 Important：lark-cli 认证探测具有文件系统/网络副作用，以及合法旧版本路径留下同组后代。

独立 reviewer 最终结论为 **GO**，剩余 Critical 0、Important 0、Minor 1。Minor 是既有进程测试的 80ms PID-ready 时序抖动，不属于本轮两个 Important，保留为关注点。

## Fix Round 2 Review 关闭情况

1. **lark-cli Doctor auth 副作用：已关闭。** Manifest 删除 `lark-cli auth status --verify` argv，增加显式 `unavailable` 合同和稳定 reason code `WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE`。Doctor 在版本满足最低要求后直接返回 `unauthenticated`，不会把 lark 误报为 `available`，也不会执行 auth 命令。
2. **合法旧版本留下同组后代：已关闭。** SemVer 提取、最低版本比较和 supported/unsupported 分类全部移入 `spawnParsedText` parser callback；parser 返回后统一等待同组 cleanup 完成，Doctor 才消费结果。valid-old、invalid 和 supported 三类版本结果均不再在 Doctor 返回后留下同组后代。
3. **认证成功路径 ownership：已补齐。** gh/glab auth 成功路径也改用 `spawnParsedText`，认证结果返回前完成同组 cleanup；nonzero auth 继续由 `runProcess` 的统一失败清理处理。
4. **Manifest fail-closed：已保持。** git 只接受 `auth:none`；lark-cli 只接受固定 reason code 的 `auth:unavailable`；gh/glab 接受原审计 auth probe 或显式 `unavailable`。外部 Provider 不能用 `none`，lark-cli 不能重新声明有副作用 auth argv。

## TDD 与回归证据

- lark 无副作用用例在旧实现上返回通用 `Authentication probe failed.`，缺少稳定 reason code；实现后精确返回 `unauthenticated`、reason code 和固定 diagnostic，并确认真实进程 argv 只有 `--version`、隔离临时 HOME 保持为空。
- valid-old/supported 版本 fixture 在旧实现上均能让同组后代写出 survivor marker；把版本分类移入 parser cleanup ownership 后 marker 不再出现。
- 新增 parser callback 抛错与 gh auth-success 后代测试；短暂注入“parser catch 不 cleanup”和“auth 退回 spawnText”两处历史回归时 2/2 按预期失败，恢复实现后 2/2 通过。
- 本轮没有执行任何 lark auth 命令，没有读取任何 CLI auth/config 文件，也没有访问真实外部账号。

## 可用性边界

Task 1 Doctor 只能证明二进制存在、版本满足合同，以及受审计且无副作用的认证探测结果。lark-cli 当前没有满足该约束的 auth probe，因此必须稳定返回 `unauthenticated` 和 `WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE`，不能根据版本或本地配置猜测 `available`。

只有后续 Task 4 在正式工作流中完成实际只读 fetch，并获得与当前请求、Provider 和外部对象绑定的成功结果，才能形成认证及可用证据。Task 1 的本地 fixture、版本输出或 reason code 都不能替代该证据。

## 最终验证

- 聚焦：`node --import tsx --test tests/unit/connector-registry.test.ts tests/unit/spawn-json.test.ts tests/unit/redaction.test.ts tests/integration/connector-doctor.test.ts`
  - 53/53 tests PASS，0 fail，退出码 0。
- `npm test`
  - 522/522 tests PASS，0 fail，退出码 0。
- `npm run lint`：PASS，退出码 0。
- `npm run typecheck`：PASS，退出码 0。
- `npm run build`：PASS，退出码 0。
- `npm run schemas:generate`：PASS，退出码 0。
- `git diff --exit-code -- schemas`：PASS，无 schema drift。
- `git diff --check`：PASS。

## 剩余关注点

- `tests/unit/spawn-json.test.ts` 的既有“timeout returns only after the POSIX process group no longer exists”用例使用 80ms timeout 后直接读取 PID 文件；并行负载下 reviewer 首次聚焦运行出现一次 `ENOENT`，单测与整组复跑通过。该测试应在后续范围内增加 PID-ready 同步，避免假阴性。
- POSIX 进程组行为仅在本机 macOS fixture 验证；尚未在 Linux 主机执行。
- 本轮没有调用真实 git/gh/glab/lark-cli auth 或 fetch，没有读取真实账号配置，也没有验证真实账号、外部服务或生产链路。
- Node 按路径 spawn 无法消除同 UID 攻击者在检查后替换、执行后恢复文件的 TOCTOU；locator 与安装目录仍属于宿主信任边界。
- 同组 cleanup 只约束未脱离 session/process group 的后代，不覆盖 Provider 主动 `setsid` 或创建新 session 的逃逸。
- cleanup deadline 失败会以 `WSSPEC_PROCESS_CLEANUP_FAILED` fail closed；这保证 Doctor 不在已知残留时返回健康结果，但不是 OS 级沙箱。
- 本报告只证明 Task 1 本地实现与自动化门禁，不代表 Connectors 真实集成或生产发布 GO。
