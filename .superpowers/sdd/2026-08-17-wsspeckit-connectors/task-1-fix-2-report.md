# Task 1 Fix Round 2 报告：关闭 Connector 进程残余缺口

## 状态

完成。修复基线为 `8c2bde2 fix: harden connector process diagnostics`，范围严格限定在 Task 1 的进程适配器、脱敏、Connector Manifest、Doctor 和对应测试；未开始 Task 2，未合并、推送、发布或执行真实账号认证。

独立 reviewer 首轮发现 1 个 Important 和 1 个 Minor；完成对应 RED-GREEN 后 spot re-review 结论为 **GO / Ready to commit**，剩余 Critical 0、Important 0。

## Fix Round 1 Review 关闭情况

1. **结构化 secret key：已关闭。** 对象分支只要存在 credential key 或包含任一显式 secret 的 key，整个分支 fail closed 为 `{}`，避免 key 本身泄漏及脱敏后 key collision。覆盖嵌套 key、短 secret `R`、Unicode secret `密钥` 和普通分支保留。
2. **Doctor CLI 合同：已关闭。** git 固定 `--version` 且不做 auth；gh 固定 `auth status --active`；glab 固定 `auth status`；lark-cli 固定 `auth status --verify`。外部 Provider 统一使用有界文本和 exit code `[0]`/`[1]`，删除 JSON-field Doctor 合同。
3. **Manifest/SemVer 双实现：已关闭。** 新增共享严格 SemVer parser/extractor/comparator，由 Manifest 注册校验和 Doctor 版本比较共同复用。拒绝 core/numeric prerelease leading zero、空 prerelease/build identifier 和 malformed metadata；core 与 numeric prerelease 使用 `BigInt`。
4. **环境路径 diagnostic 泄漏：已关闭。** 只有调用方显式传入的 HOME/config 绝对路径加入有效 secret 集合；成功 JSON/stdout 和失败 diagnostic 均脱敏。继承的安全 locale 和内部固定 PATH 不作为 secret，避免正常版本文本被过度脱敏。
5. **所有失败出口的进程组清理：已关闭。** timeout、output limit、nonzero、signal、executable identity failure、spawn error、invalid JSON 以及 Doctor 文本 SemVer 语义失败均复用 memoized cleanup：探测进程组、SIGTERM、有限 grace、SIGKILL、轮询到 `ESRCH`。deadline 未清理完成时以无 diagnostic 的 `WSSPEC_PROCESS_CLEANUP_FAILED` fail closed。
6. **清理错误优先级：已固定。** cleanup failure 优先级最高；主动 timeout/output-limit 在 executable identity 复检前稳定返回。成功 JSON/text/SemVer 路径不调用失败清理。
7. **可执行文件无界读取：已关闭。** SHA-256 改为 `createReadStream`，执行前拒绝超过 128 MiB 的文件，并在流式 hash 前后比较 dev/ino/size/mtime，运行后继续复检完整 identity/digest。
8. **M1 测试缺口：已关闭。** 新增 cleanup deadline、nonzero/signal/invalid-JSON 同组后代、spawn failure、Doctor invalid-version 后代、oversized executable、环境 diagnostic 和 timeout/identity 冲突覆盖。

## TDD 与独立复核

本轮新增或强化的用例均先观察失败再修改生产代码，包括：secret JSON key、严格 SemVer、真实 lark argv、显式 env path、oversized executable、nonzero/signal/invalid-JSON 后代、cleanup deadline、Doctor invalid-version 后代和 timeout/identity 错误优先级。

实施中还由完整聚焦回归发现并修复一次过度脱敏：继承的 `LANG` 和固定 `PATH` 被误纳入 secret 后造成 8 个 Doctor/spawn 测试失败；收窄为仅显式配置值后，同一聚焦命令恢复通过。

独立 reviewer 首轮确认原 fix-1 残余项均已关闭，但复现 Doctor 版本文本退出 0、无合法 SemVer 时同组后代仍存活；新增 `spawnParsedText` 后该语义解析失败也由进程适配器持有 cleanup ownership。spot re-review 最终确认无剩余 Critical/Important。

## 只读 CLI 合同证据

- 本机 `git --version`：`git version 2.50.1 (Apple Git-155)`。
- 本机 `gh --version`：`2.86.0`；`gh auth status --help` 确认 `--active`，并说明认证问题时退出 1。未执行 `gh auth status`。
- 本机 `lark-cli --version`：`1.0.0`；`lark-cli auth status --help` 确认 `--verify`，未提供 `--json`。help 明确 `--verify` 会访问网络；本轮未实际执行。
- 本机未安装 glab。仅依据 GitLab 官方 CLI 文档确认 `glab auth status` 是查看/验证认证状态的命令；未验证本机版本、真实 exit code 或账号行为。
- 所有自动化 auth 结果均来自本地受控 fixture；没有读取真实 token、Cookie、配置内容或账号状态。

## 最终验证

- 聚焦：`node --import tsx --test tests/unit/redaction.test.ts tests/unit/spawn-json.test.ts tests/unit/connector-registry.test.ts tests/integration/connector-doctor.test.ts`
  - 47/47 tests PASS，0 fail，退出码 0。
- `npm test`
  - 516/516 tests PASS，0 fail，退出码 0。
- `npm run lint`：PASS，退出码 0。
- `npm run typecheck`：PASS，退出码 0。
- `npm run build`：PASS，退出码 0。
- `npm run schemas:generate`：PASS，退出码 0。
- `git diff --exit-code -- schemas`：PASS，无 schema drift。
- `git diff --check`：PASS。

## 剩余关注点

- POSIX 进程组行为只在本机 macOS fixture 验证，未在 Linux 主机执行。
- glab 本机缺失，合同只有官方文档证据；gh/lark-cli 只查看版本/help。未执行任何真实 auth probe、真实账号或外部服务验收。
- Node 按路径 spawn 无法消除同 UID 攻击者在检查后替换、执行后恢复文件的 TOCTOU；locator 与安装目录仍属于宿主信任边界。
- 进程组清理只覆盖同组后代，不承诺处理恶意 Provider 主动 `setsid`/新 session 逃逸。
- 128 MiB 上限约束静态 executable；同 UID 并发修改仍由 hash 前后 metadata 和运行后 identity 复检 fail closed，而非内核级不可变句柄执行。
- 本报告仅证明 Task 1 本地实现、只读命令合同和自动化门禁，不代表 Connectors 真实集成或生产发布 GO。
