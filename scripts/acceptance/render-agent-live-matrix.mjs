#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const historyFile = path.join(repositoryRoot, "docs", "acceptance", "agent-live-history.json");
const matrixFile = path.join(repositoryRoot, "docs", "acceptance", "agent-live-matrix.yaml");
const clientNames = ["codex", "claude", "cursor"];
const observationNames = [
  "authentication",
  "modelCall",
  "driverInstall",
  "automaticTrigger",
  "explicitDriver",
  "freshSessionRecovery",
  "protocolAcquireSubmit",
  "compactPlan",
  "trustedRedGreen",
  "review",
  "externalClose",
  "workItemClose",
];
const releaseGateChecks = [
  "signed-fixture-and-run-binding",
  "bound-fixture-bin-wspec",
  "three-distinct-fresh-client-sessions",
  "chained-before-after-checkpoints",
  "meaningful-auto-explicit-recovery-deltas",
  "final-verifier-pass",
];
const realHostEvidenceChecks = [
  "auto-session",
  "explicit-session",
  "recovery-session",
  "final-verifier-pass",
];

function parseMode(argv) {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0])) {
    throw new Error("用法：render-agent-live-matrix.mjs --check|--write");
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

function validateHistory(value) {
  const history = record(value, "history");
  if (history.version !== 1 || history.kind !== "wsspeckit-agent-live-history" || history.overall !== "no-go") {
    throw new Error("历史 manifest 版本、类型或 overall 无效");
  }
  const releaseGate = record(history.releaseGate, "releaseGate");
  if (releaseGate.status !== "no-go" || JSON.stringify(releaseGate.requiredChecks) !== JSON.stringify(releaseGateChecks)
    || !Array.isArray(releaseGate.satisfiedChecks) || releaseGate.satisfiedChecks.length !== 0) {
    throw new Error("legacy history 缺少完整 release PASS 前置条件或错误声明已满足");
  }
  const clients = record(history.clients, "clients");
  const evidenceTiers = record(history.evidenceTiers, "evidenceTiers");
  if (evidenceTiers.localFixtures !== "local-automated-only"
    || evidenceTiers.historicalLegacyObservations !== "legacy-unbound-not-real-host-evidence"
    || evidenceTiers.realHostEvidence !== "signed-observer-three-session-and-verifier-required") {
    throw new Error("证据层级必须明确区分 local fixture、legacy observation 与 real-host evidence");
  }
  const currentProbe = record(history.currentProbe, "currentProbe");
  if (currentProbe.method !== "command-v-only" || currentProbe.realHostExecution !== "not-authorized-not-run") {
    throw new Error("当前宿主探测只能记录 command -v 可用性，且不得声称运行过真实 Host");
  }
  const currentClients = record(currentProbe.clients, "currentProbe.clients");
  for (const name of clientNames) {
    const client = record(clients[name], `clients.${name}`);
    if (client.authorityStatus !== "legacy-unbound") throw new Error(`${name} 必须标记 legacy-unbound`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(text(client.runIdHash, `${name}.runIdHash`))) {
      throw new Error(`${name}.runIdHash 无效`);
    }
    if (!text(client.status, `${name}.status`).endsWith("no-go")) throw new Error(`${name}.status 必须保持 NO-GO`);
    if (JSON.stringify(client).includes('"pass"')) throw new Error(`${name} 不能把 legacy observation 标记为 PASS`);
    const hostEvidence = record(client.hostInvocationEvidence, `${name}.hostInvocationEvidence`);
    const phases = Array.isArray(hostEvidence.phases) ? hostEvidence.phases : undefined;
    if (hostEvidence.status !== "not-run-legacy-unbound" || hostEvidence.receiptCount !== 0 || phases?.length !== 0
      || /partial|pass/iu.test(client.status)) {
      throw new Error(`${name} 缺少 observer receipts 时只能是 not-run/observed-unverified NO-GO`);
    }
    const observations = record(client.observations, `${name}.observations`);
    for (const observation of observationNames) text(observations[observation], `${name}.observations.${observation}`);
    const currentClient = record(currentClients[name], `currentProbe.clients.${name}`);
    const availability = text(currentClient.availability, `currentProbe.clients.${name}.availability`);
    if (!(["missing", "available-unverified"].includes(availability))) {
      throw new Error(`${name} 当前可用性必须是 missing 或 available-unverified`);
    }
    const realHostEvidence = record(currentClient.realHostEvidence, `currentProbe.clients.${name}.realHostEvidence`);
    if (realHostEvidence.status !== "not-run-no-go" || realHostEvidence.receiptCount !== 0
      || JSON.stringify(realHostEvidence.phases) !== JSON.stringify([]) || realHostEvidence.verifier !== "not-run"
      || JSON.stringify(realHostEvidence.requiredChecks) !== JSON.stringify(realHostEvidenceChecks)) {
      throw new Error(`${name} 没有 signed 三会话和 verifier 证据时必须保持 not-run NO-GO`);
    }
  }
  return history;
}

function renderClient(value) {
  const observations = value.observations;
  return {
    recordedDate: value.recordedDate,
    authorityStatus: value.authorityStatus,
    runIdHash: value.runIdHash,
    runIdBasis: value.runIdBasis,
    hostInvocations: value.hostInvocationEvidence.status,
    version: value.version,
    executable: value.executable,
    ...Object.fromEntries(observationNames.map((name) => [name, observations[name]])),
    verifier: value.verifier === null ? "not-run" : "failed-observed-unverified",
    status: value.status,
    blocker: value.blocker,
  };
}

export function renderAgentLiveMatrix(value) {
  const history = validateHistory(value);
  const clients = history.clients;
  const matrix = {
    version: 1,
    generatedFrom: "docs/acceptance/agent-live-history.json",
    recordedDate: history.recordedDate,
    platform: history.platform,
    wsspeckitCommit: history.wsspeckitCommit,
    evidenceTiers: history.evidenceTiers,
    currentProbe: history.currentProbe,
    authorityStatus: "legacy-unbound",
    overall: "no-go",
    releaseGate: history.releaseGate,
    clients: Object.fromEntries(clientNames.map((name) => [name, renderClient(clients[name])])),
  };
  const header = [
    "# Generated by scripts/acceptance/render-agent-live-matrix.mjs. Do not edit manually.",
    "# Local fixtures and legacy-unbound observations are not real-host or release PASS evidence.",
  ].join("\n");
  return `${header}\n${stringifyYaml(matrix, { lineWidth: 0 })}`;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const history = JSON.parse(await readFile(historyFile, "utf8"));
  const expected = renderAgentLiveMatrix(history);
  if (mode === "--write") {
    await writeFile(matrixFile, expected, "utf8");
    return;
  }
  const actual = await readFile(matrixFile, "utf8").catch(() => "");
  if (actual !== expected) throw new Error("agent-live-matrix.yaml 与历史 manifest 不一致；运行 --write 更新");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
