# 08: 形成发布候选与最终门禁

**What to build:** 用户能够从干净安装的 npm tarball 使用中文文档完成首版工作流；发布维护者获得一份区分自动化、真实宿主和真实平台证据的最终报告，并只在必需验收全部通过时得到 GO 结论。

**Blocked by:** 06: 取得真实 Agent 宿主验收证据; 07: 取得真实 Connector 平台验收证据.

**Status:** blocked-no-go

- [x] clean consumer 安装、功能与文档 Workflow、Driver dry-run 和中文指南在发布产物上得到验证。**本地证据：** `tests/e2e/package-install.test.ts`、`tests/e2e/driver-install.test.ts` 与中文指南契约通过；2026-08-23 的门禁末段 clean consumer E2E 为 3/3 passed。这不是任何真实宿主或平台验收。
- [x] 发布门禁验证协议基线、Schema、文档、测试、构建、打包和需求追踪矩阵，不掩盖失败或未运行的必需项。**本地证据：** 2026-08-23 执行的 `bash scripts/run-release-gate.sh` 串行通过：全量 Node 测试 944/944、构建、`npm pack --dry-run` 和 clean consumer E2E 均通过；脚本只读取矩阵、从不调用宿主或 Provider CLI。
- [x] 发布报告分别呈现实现、宿主与平台证据；只有所有首版必需层级均通过时，整体状态才标记为 GO。**结论：** local RC gate 已通过，但 Ticket 06/07 的 real-host 与 real-platform 必需行仍为 `no-go`，所以总体保持 `blocked-no-go`，不得发布。
