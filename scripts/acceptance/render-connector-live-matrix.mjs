#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const historyFile = path.join(repositoryRoot, "docs", "acceptance", "connector-live-history.yaml");
const matrixFile = path.join(repositoryRoot, "docs", "acceptance", "connector-live-matrix.yaml");
const requiredChecks = [
  "verified-authentication",
  "dedicated-non-production-target",
  "explicit-exact-write-authorization",
  "idempotency-key",
  "readback-summary",
  "reconciliation-before-retry",
  "redacted-audit-receipt",
];
const gitlabSatisfiedChecks = [
  "verified-authentication",
  "explicit-exact-write-authorization",
  "reconciliation-before-retry",
];
const forbiddenGovernedRunFields = new Set([
  "body",
  "commentBody",
  "credentials",
  "effectId",
  "payload",
  "rawCommentBody",
  "rawPayload",
  "token",
]);
const expectedGitlabGovernedRun = {
  workItemId: "WSS-01M0S8S3CXJ1Q7M9TWMG3WE03A",
  requestId: "external-request-9c05777fdc6844ab58698afe49db4e40aba632c32e5f8e5f42deaaf3122d10aa",
  target: "gitlab:892",
  requestedEffectKind: "issue.comment",
  contentDigest: "sha256:2b3123f714d6cec7092fa66136b74333e9d1945a812b7f4557c7260a67715fef",
  hostAuthentication: "verified-host-scoped-glab-auth-status",
  doctorAuthentication: "false-negative-default-gitlab-com-unauthenticated",
  firstSubmit: "await_approval",
  approval: "exact-approved",
  secondSubmit: "reconciliation_required",
  publicReconcile: "remains-reconciliation-required",
  receipt: "absent-unverified",
};

function parseMode(argv) {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0])) {
    throw new Error("用法：render-connector-live-matrix.mjs --check|--write");
  }
  return argv[0];
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} 必须是非空字符串`);
  return value;
}

function rejectForbiddenFields(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenFields(item, `${label}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenGovernedRunFields.has(key)) throw new Error(`${label}.${key} 禁止记录原始外部动作数据`);
    rejectForbiddenFields(child, `${label}.${key}`);
  }
}

function validateNotRunProvider(provider, providerName) {
  const availability = text(provider.availability, `${providerName}.availability`);
  if (availability !== "available-unverified") throw new Error(`${providerName} command -v 可用性记录不正确`);
  const evidence = record(provider.realPlatformEvidence, `${providerName}.realPlatformEvidence`);
  if (evidence.status !== "not-run-no-go" || evidence.receiptCount !== 0
    || JSON.stringify(evidence.requiredChecks) !== JSON.stringify(requiredChecks)
    || !Array.isArray(evidence.satisfiedChecks) || evidence.satisfiedChecks.length !== 0
    || provider.governedRun !== undefined) {
    throw new Error(`${providerName} 未运行时必须保持 not-run NO-GO`);
  }
}

function validateGitlabGovernedRun(provider) {
  if (text(provider.availability, "gitlab.availability") !== "available-verified") {
    throw new Error("GitLab host-scoped auth 已验证时必须记录 available-verified");
  }
  const evidence = record(provider.realPlatformEvidence, "gitlab.realPlatformEvidence");
  if (evidence.status !== "reconciliation-required-no-go" || evidence.receiptCount !== 0
    || JSON.stringify(evidence.requiredChecks) !== JSON.stringify(requiredChecks)
    || JSON.stringify(evidence.satisfiedChecks) !== JSON.stringify(gitlabSatisfiedChecks)) {
    throw new Error("GitLab 未知效果必须保持 reconciliation-required NO-GO，且不得伪造回执");
  }
  const governedRun = record(provider.governedRun, "gitlab.governedRun");
  rejectForbiddenFields(governedRun, "gitlab.governedRun");
  if (JSON.stringify(governedRun) !== JSON.stringify(expectedGitlabGovernedRun)) {
    throw new Error("GitLab 受治理运行记录必须是完整的脱敏事实，且不得包含 effect ID 或原始字段");
  }
}

function validateHistory(value) {
  const history = record(value, "history");
  if (history.version !== 1 || history.kind !== "wsspeckit-connector-live-history" || history.overall !== "no-go") {
    throw new Error("Connector 历史 manifest 版本、类型或 overall 无效");
  }
  const tiers = record(history.evidenceTiers, "evidenceTiers");
  if (tiers.localFixtures !== "local-automated-only"
    || tiers.realPlatformEvidence !== "authorized-dedicated-target-write-idempotency-readback-reconciliation-required") {
    throw new Error("Connector 证据层级必须区分 local fixture 与真实平台验收");
  }
  const probe = record(history.currentProbe, "currentProbe");
  if (probe.method !== "command-v-plus-governed-run" || probe.realPlatformExecution !== "gitlab-governed-run-reconciliation-required") {
    throw new Error("当前 Connector 历史必须区分 command -v 探测与 GitLab 受治理运行");
  }
  const providers = record(probe.providers, "currentProbe.providers");
  validateNotRunProvider(record(providers.github, "currentProbe.providers.github"), "github");
  validateGitlabGovernedRun(record(providers.gitlab, "currentProbe.providers.gitlab"));
  validateNotRunProvider(record(providers.feishu, "currentProbe.providers.feishu"), "feishu");
  return history;
}

export function renderConnectorLiveMatrix(value) {
  const history = validateHistory(value);
  const matrix = {
    version: 1,
    generatedFrom: "docs/acceptance/connector-live-history.yaml",
    recordedDate: history.recordedDate,
    evidenceTiers: history.evidenceTiers,
    currentProbe: history.currentProbe,
    overall: "no-go",
  };
  const header = [
    "# Generated by scripts/acceptance/render-connector-live-matrix.mjs. Do not edit manually.",
    "# Local fixtures and command -v availability are not real-platform or release PASS evidence.",
  ].join("\n");
  return `${header}\n${stringifyYaml(matrix, { lineWidth: 0 })}`;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const history = parseYaml(await readFile(historyFile, "utf8"));
  const expected = renderConnectorLiveMatrix(history);
  if (mode === "--write") {
    await writeFile(matrixFile, expected, "utf8");
    return;
  }
  const actual = await readFile(matrixFile, "utf8").catch(() => "");
  if (actual !== expected) throw new Error("connector-live-matrix.yaml 与历史 manifest 不一致；运行 --write 更新");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
