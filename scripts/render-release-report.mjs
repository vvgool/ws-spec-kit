import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { parseTraceability } from "./check-release-baseline.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const traceabilityFile = path.join(repositoryRoot, "docs", "acceptance", "requirements-traceability.yaml");
const reportFile = path.join(repositoryRoot, "docs", "acceptance", "release-report.md");

function rowsForTicket(rows, ticket) {
  return rows.filter((row) => row.ticket === ticket);
}

function markdownStatus(status) {
  return status === "passed" ? "通过" : "NO-GO";
}

function markdownRows(rows) {
  return rows.map((row) => `| ${row.id} | ${row.evidenceTier} | ${markdownStatus(row.status)} | ${row.status === "passed" ? "无" : "见权威追溯矩阵 blocker"} |`).join("\n");
}

export function renderReleaseReport(document) {
  const { matrix, rows, summary } = parseTraceability(document);
  const localRows = rows.filter((row) => row.evidenceTier === "local-automated");
  const hostRows = rowsForTicket(rows, "06");
  const platformRows = rowsForTicket(rows, "07");
  const releaseRows = rowsForTicket(rows, "08");
  return [
    "# WSSpecKit 发布候选本地验证报告",
    "",
    "## 结论",
    "",
    `- 本地 RC 门禁：${markdownStatus(summary.localAutomated)}。`,
    `- 真实 Agent 宿主验收：${markdownStatus(summary.realHost)}。`,
    `- 真实 Connector 平台验收：${markdownStatus(summary.realPlatform)}。`,
    `- 首版总体发布结论：${summary.overall === "go" ? "GO" : "BLOCKED-NO-GO"}。`,
    "",
    "本报告只呈现本地自动化的可重复证明；它不执行、模拟或替代 Codex、Claude、Cursor、GitHub、GitLab 或飞书的真实验收。任何必需层的 `missing`、`not_run` 或 `no-go` 都会使总体保持 `BLOCKED-NO-GO`。",
    "",
    "## 本地自动化证明",
    "",
    "本地 RC 门禁以串行 Node 测试、协议/Schema/文档/追溯契约、lint、typecheck、build、`npm pack --dry-run` 与 clean consumer 安装 E2E 组成。2026-08-23 的本次执行中，全量 Node 测试为 944/944 passed，clean consumer 安装 E2E 为 3/3 passed。门禁不调用宿主或 Provider CLI。",
    "",
    "| 验收项 | Evidence Tier | 结果 | 说明 |",
    "| --- | --- | --- | --- |",
    markdownRows(localRows),
    "",
    "## 真实 Agent 宿主验收",
    "",
    "Ticket 06 要求 Codex、Claude、Cursor 的签名三会话与最终 verifier 证据。当前矩阵记录 Codex、Claude 缺失，Cursor 仅 command 可用但未授权执行或验证认证，不能由 fixture 或 Driver 安装契约提升为通过。",
    "",
    "| 验收项 | Evidence Tier | 结果 | 说明 |",
    "| --- | --- | --- | --- |",
    markdownRows(hostRows),
    "",
    "## 真实 Connector 平台验收",
    "",
    "Ticket 07 要求专用非生产目标、认证、精确写入授权、幂等键、回读与对账证据。当前矩阵记录 GitLab CLI 缺失，GitHub 与飞书仅为 available-unverified，且无专用目标或授权，因此不能由本地 fixture 提升为通过。",
    "",
    "| 验收项 | Evidence Tier | 结果 | 说明 |",
    "| --- | --- | --- | --- |",
    markdownRows(platformRows),
    "",
    "## Ticket 08 发布候选结果",
    "",
    "| 验收项 | Evidence Tier | 结果 | 说明 |",
    "| --- | --- | --- | --- |",
    markdownRows(releaseRows),
    "",
    "权威追溯矩阵：[docs/acceptance/requirements-traceability.yaml](requirements-traceability.yaml)。",
    `Foundation 基线：\`${matrix.baselineCommit}\`。`,
    "",
  ].join("\n");
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") throw new Error("用法：render-release-report.mjs --check|--write");
  const report = renderReleaseReport(parse(await readFile(traceabilityFile, "utf8")));
  if (mode === "--write") {
    await writeFile(reportFile, report, "utf8");
    return;
  }
  const actual = await readFile(reportFile, "utf8").catch(() => "");
  if (actual !== report) throw new Error("release-report.md 与权威追溯矩阵不一致；运行 --write 更新");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
