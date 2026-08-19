# Task 1 Fix Round 1 报告：加固 Connector 进程诊断

## 状态

完成。修复基线为 `62c2e51 feat: add connector provider boundary`，范围严格限定在 Task 1 的 Provider Manifest、进程边界、脱敏和 Doctor；未开始 Task 2，未调用真实外部 CLI 或真实账号。

独立复核最终结论：Task 1 GO，剩余 Critical 0、Important 0。

## 原 Review 关闭情况

### Critical

1. **超限输出的凭据前缀泄漏：已关闭。** timeout/output-limit 错误固定返回空 diagnostic；普通错误仅在完整的有界原始输出上先脱敏、再做最终字节限界。短秘密、重叠秘密、替换标记碰撞或残留检测均 fail closed。
2. **文本和结构化脱敏不完整：已关闭。** 动态选择不与显式秘密冲突的标记；显式秘密按长度降序处理；结构化 key 统一规范化并覆盖 camelCase、Authorization、Cookie 和常见 token/password/secret/api-key。Authorization、Cookie、Set-Cookie 整行清空，覆盖 Basic、Digest、自定义 scheme 和多段 Cookie。
3. **Doctor 盲用业务 argv：已关闭。** Manifest 增加独立的 discriminated Doctor version/auth contract，四个 executable 的 argv、parser、field 和 outcome mapping 全部固定审核；业务 `argvTemplates` 不参与 Doctor。外部 Provider 不能省略 auth probe，只有本地 git 可显式使用 `none`。

### Important

1. **可执行文件替换窗口：按本轮约定加固。** canonical path 的每个组件必须由 root 或当前 UID 拥有且不可 group/world writable；执行前记录 `dev`、`ino`、`size`、`mtimeNs` 和 SHA-256，执行后重新比较，变化时返回 `WSSPEC_PROCESS_EXECUTABLE_CHANGED`。
2. **环境不足或过宽：已关闭。** 子进程使用确定性 `PATH=${dirname(process.execPath)}:/usr/bin:/bin`；只接受 `HOME`、`XDG_CONFIG_HOME`、`GH_CONFIG_DIR`、`GLAB_CONFIG_DIR`、`LARK_CONFIG_DIR` 的无 NUL 绝对路径。Doctor 仅传递当前 Manifest `envPolicy.allow` 声明的键，不继承 token、Cookie、Authorization 或 Keychain 环境。
3. **原生文本版本不可诊断：已关闭。** 增加 bounded `spawnText`，git、gh、glab、lark-cli 的固定版本探针使用受限文本 SemVer 提取，不要求 CLI 返回 JSON。
4. **SemVer precedence 错误：已关闭。** core 和数字 prerelease 使用 `BigInt`；正确处理 prerelease 优先级、build metadata、任意大整数和 prerelease 内多个连字符。
5. **Manifest 校验不完整：已关闭。** 完整校验顶层和嵌套 exact shape、固定枚举、字符串、整数、argv、env policy、parser 和 outcomes；所有非法输入统一映射到 `WSSPEC_CONNECTOR_MANIFEST_INVALID`，规范化结果深冻结。
6. **进程组清理未以消失为条件：已关闭。** POSIX 超时/超限依次发送 SIGTERM、SIGKILL，并轮询 `kill(-pid, 0)` 直到 `ESRCH`；独立 cleanup deadline 失败返回无 diagnostic 的 `WSSPEC_PROCESS_CLEANUP_FAILED`。
7. **locator 异常中止所有 Provider：已关闭。** 每个 Provider 单独捕获 locator 异常，输出固定 `missing_binary` diagnostic 并继续后续 Provider，不公开原始 Error/cause。

### Minor

1. **缺少进程边界分支测试：已关闭。** 增加 stderr overflow、signal exit、Unicode 字节边界、进程组消失、可执行文件权限/身份变化、环境策略和 cleanup 行为覆盖。
2. **标签脱敏吞掉同一行普通字段：已关闭。** 普通 token/password/secret 标签只替换单值并保留后续字段；Authorization/Cookie/Set-Cookie 作为安全优先的 header 特例整行清空。

## TDD 与独立复核证据

实施中逐组先观察失败，再写生产修复：

- secret 跨 capture boundary、短/重叠 secret、camelCase 结构化字段、同一行普通字段；
- Doctor 业务写 argv、原生文本版本、prerelease/超大 SemVer、完整 Manifest 负例；
- 确定性 PATH、绝对配置路径、可写 executable/目录、执行中身份变化、进程组 cleanup；
- Doctor Manifest 环境筛选和 locator 异常后继续；
- 多连字符 prerelease；
- 独立 reviewer 发现的 Basic/多段 Cookie diagnostic 残留和 auth outcome 反转；
- reviewer 复核发现的 Digest/未知 Authorization scheme 残留。

最后一组未知 Authorization scheme 用例先得到 2 个失败，再改为完整 header 脱敏并得到 3/3 通过。独立 reviewer 最终 spot re-review 确认 Critical 0、Important 0，Task 1 GO。

## 实现摘要

- `redaction.ts` 对文本、嵌套 JSON 和显式秘密采用 fail-closed 脱敏，公开错误不保留无法证明安全的内容。
- `spawn-json.ts` 统一 JSON/text 进程执行，保留 shell-free argv、spawn 前 JSON 序列化、严格输出限界，并补齐环境、可执行文件身份和 POSIX cleanup 边界。
- `types.ts`、`manifest.ts` 将 Doctor 与环境策略纳入强类型且运行时完整验证的 Manifest。
- `doctor-connectors.ts` 仅执行固定审核 probe，支持正确 SemVer、显式 auth outcome、逐 Provider 异常隔离和 Manifest 环境筛选。

## 最终验证

- 聚焦命令：`node --import tsx --test tests/unit/redaction.test.ts tests/unit/spawn-json.test.ts tests/unit/connector-registry.test.ts tests/integration/connector-doctor.test.ts && npm run typecheck`
  - 33/33 tests PASS；typecheck PASS。
- `npm test`
  - 502/502 tests PASS，0 fail，退出码 0。
- `npm run lint`
  - PASS，退出码 0。
- `npm run typecheck`
  - PASS，退出码 0。
- `npm run build`
  - PASS，退出码 0。
- `npm run schemas:generate`
  - PASS，退出码 0。
- `git diff --exit-code -- schemas`
  - PASS，无 schema drift。
- `git diff --check`
  - PASS。

## 剩余关注点

- 本轮只在 macOS 以本地 Node fixture 验证；POSIX Linux 分支未在 Linux 主机执行。
- 未调用真实 git、gh、glab、lark-cli，也未读取真实账号配置；因此不证明真实 CLI 安装布局、版本输出、认证状态或外部账号可用。
- Node 按路径 spawn 无法彻底消除同 UID 攻击者在检查后替换并在执行后恢复同一文件的 TOCTOU；locator 和安装目录仍属于宿主信任边界。
- 进程组清理不承诺处理恶意 Provider 主动 `setsid` 逃逸；固定 Manifest probe 审计与宿主可执行文件信任仍是前置边界。
- 本报告只证明 Task 1 本地实现与自动化门禁，不外推为 Connectors、真实集成或生产发布就绪。
