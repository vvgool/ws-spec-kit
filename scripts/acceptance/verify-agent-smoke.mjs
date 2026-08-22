#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const runtimeDirectory = process.env.WSSPECKIT_ACCEPTANCE_RUNTIME === "source" ? "../../src" : "../../dist";
const [{ loadApplicationState }, { computeArtifactContentHash, readArtifact }, { parseTddCycleEvidence, parseTrustedEvidence }, { readEvents }] = await Promise.all([
  import(`${runtimeDirectory}/application/state.js`),
  import(`${runtimeDirectory}/domain/artifacts.js`),
  import(`${runtimeDirectory}/engine/tdd/red-gate.js`),
  import(`${runtimeDirectory}/storage/events.js`),
]);

const execFileAsync = promisify(execFile);
const clients = new Set(["codex", "claude", "cursor"]);

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--client", "--repo"].includes(name) || value === undefined || value.startsWith("--")) {
      throw new Error("用法：verify-agent-smoke.mjs --client <codex|claude|cursor> --repo <目录>");
    }
    if (values[name] !== undefined) throw new Error(`重复参数：${name}`);
    values[name] = value;
  }
  if (!clients.has(values["--client"]) || values["--repo"] === undefined) {
    throw new Error("必须提供有效的 --client 和 --repo");
  }
  return { client: values["--client"], repo: path.resolve(values["--repo"]) };
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function artifactReferences(projection) {
  const references = [];
  for (const context of Object.values(projection.contexts)) {
    const result = record(record(context)?.result);
    if (!Array.isArray(result?.artifacts)) continue;
    for (const artifact of result.artifacts) {
      const candidate = record(artifact);
      if (typeof candidate?.artifactType === "string" && typeof candidate.path === "string") references.push(candidate);
    }
  }
  return references;
}

function structuredYaml(body, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const section = new RegExp(`^#{1,6}\\s+${escaped}\\s*$([\\s\\S]*?)(?=^#{1,6}\\s+|$)`, "mu").exec(body)?.[1] ?? "";
  const fenced = /```yaml\s*\n([\s\S]*?)\n```/u.exec(section)?.[1];
  return fenced === undefined ? undefined : parseYaml(fenced);
}

export async function checkedArtifact(worktree, reference) {
  const root = await realpath(worktree);
  const filename = await realpath(path.resolve(worktree, reference.path));
  if (path.relative(root, filename).startsWith("..") || path.isAbsolute(path.relative(root, filename))) {
    throw new Error("Artifact 越出 Worktree");
  }
  const artifact = await readArtifact(filename);
  const { contentHash, ...unsignedMetadata } = artifact.metadata;
  if (artifact.metadata.artifactType !== reference.artifactType
    || artifact.metadata.revision !== reference.revision && reference.revision !== undefined
    || contentHash !== reference.contentHash
    || computeArtifactContentHash(unsignedMetadata, artifact.body) !== contentHash) {
    throw new Error("Artifact 引用与正文不匹配");
  }
  return artifact;
}

async function git(repo, ...args) {
  return execFileAsync("git", args, { cwd: repo, maxBuffer: 2 * 1024 * 1024 });
}

async function verifySmoke(input) {
  let metadata = {};
  try {
    metadata = JSON.parse(await readFile(path.join(input.repo, ".acceptance", "agent-smoke.json"), "utf8"));
  } catch {}
  const workItemId = typeof metadata.workItemId === "string" ? metadata.workItemId : "unknown";
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok, detail });
  check("fixture.client", metadata.kind === "wsspeckit-agent-smoke" && metadata.client === input.client, metadata.client === input.client ? "匹配" : "客户端不匹配");
  check("fixture.workflow", metadata.workflowRef === "builtin://workflows/feature-delivery" && metadata.profile === "quick", "必须是内置 Quick 功能 Workflow");

  let state;
  let events = [];
  try {
    state = await loadApplicationState(input.repo, workItemId);
    events = await readEvents(state.projection.controlPlane);
    check("state.integrity", true, `事件链 ${events.length} 条`);
  } catch (error) {
    check("state.integrity", false, error instanceof Error ? error.message : "状态不可读");
  }

  if (state !== undefined) {
    const acquired = events.filter(({ eventType }) => eventType === "attempt.acquired").length;
    const submitted = events.filter(({ eventType }) => eventType === "attempt.submitted").length;
    check("protocol.acquire-submit", acquired >= 1 && submitted >= 1, `acquire=${acquired}, submit=${submitted}`);

    const references = artifactReferences(state.projection);
    const taskReference = references.find(({ artifactType }) => artifactType === "tasks");
    let compactPlan = false;
    if (taskReference !== undefined) {
      try {
        const artifact = await checkedArtifact(state.worktree, taskReference);
        const value = record(structuredYaml(artifact.body, "任务"));
        compactPlan = artifact.metadata.stageId === "plan"
          && Array.isArray(value?.tasks) && value.tasks.length > 0 && value.tasks.length <= 3;
      } catch {}
    }
    check("artifact.compact-plan", compactPlan, taskReference === undefined ? "缺少 tasks Artifact" : "计划必须包含 1-3 个任务");

    const trusted = [];
    for (const value of Object.values(state.projection.evidence)) {
      const candidate = record(value);
      if (candidate?.level !== "trusted" || !["red", "green"].includes(candidate.phase)) continue;
      try { trusted.push(parseTrustedEvidence(candidate)); } catch {}
    }
    const cycle = parseTddCycleEvidence(state.projection.evidence[`tdd:${state.projection.workItemId}:cycle`]);
    const red = cycle === undefined ? undefined : trusted.find(({ phase, evidenceId, commandId, taskId }) => (
      phase === "red" && evidenceId === cycle.redEvidenceId && commandId === cycle.commandId && taskId === cycle.taskId
    ));
    const green = cycle === undefined ? undefined : trusted.find(({ phase, evidenceId, commandId, taskId }) => (
      phase === "green" && evidenceId === cycle.greenEvidenceId && commandId === cycle.commandId && taskId === cycle.taskId
    ));
    check(
      "tdd.trusted-red-green",
      red !== undefined && green !== undefined && red.exitCode !== 0 && green.exitCode === 0,
      red === undefined || green === undefined ? "缺少同 commandId 的可信 Red/Green" : `commandId=${red.commandId}`,
    );

    const reviewStage = Object.entries(state.projection.stages).find(([id, stage]) => /^review-fix:\d+:review$/u.test(id) && stage.status === "completed");
    const reviewReference = references.find(({ artifactType }) => artifactType === "review-result");
    let approvedReview = false;
    if (reviewStage !== undefined && reviewReference !== undefined) {
      try {
        const artifact = await checkedArtifact(state.worktree, reviewReference);
        const value = record(structuredYaml(artifact.body, "Findings"));
        approvedReview = artifact.metadata.stageId === reviewStage[0]
          && Array.isArray(value?.findings) && value.findings.every((finding) => {
          const disposition = record(finding)?.disposition;
          return disposition !== "open";
        });
      } catch {}
    }
    check("workflow.review", approvedReview, approvedReview ? "Review 已完成" : "缺少已通过的 Review Artifact");

    const issueBinding = state.item.bindings.issue !== null || Object.entries(state.projection.evidence).some(([key, value]) => {
      if (key === "external-binding:issue") return true;
      const candidate = record(value);
      return record(candidate?.issue)?.exists === true;
    });
    const issueClose = Object.values(state.projection.externalActions).some((action) => action.action === "issue.close" && action.status === "verified");
    check("workflow.external-close", !issueBinding || issueClose, issueBinding ? "Issue Binding 必须有 verified close" : "无 Issue Binding，按合同跳过");

    const closedEvent = events.some(({ eventType }) => eventType === "work-item.closed");
    check("workflow.close", state.projection.workItem.status === "closed" && closedEvent, `status=${state.projection.workItem.status}`);

    let changed = [];
    let diffClean = false;
    try {
      changed = (await git(state.worktree, "diff", "--name-only", `${metadata.baselineCommit}..HEAD`, "--")).stdout.trim().split("\n").filter(Boolean);
      const uncommitted = (await git(state.worktree, "diff", "--name-only", metadata.baselineCommit, "--")).stdout.trim().split("\n").filter(Boolean);
      changed = [...new Set([...changed, ...uncommitted])];
      await git(state.worktree, "diff", "--check", metadata.baselineCommit, "--");
      diffClean = true;
    } catch {}
    check("git.expected-diff", diffClean && changed.includes("src/labels.ts") && changed.includes("tests/labels.test.ts"), `changed=${changed.sort().join(",")}`);
  } else {
    for (const id of ["protocol.acquire-submit", "artifact.compact-plan", "tdd.trusted-red-green", "workflow.review", "workflow.external-close", "workflow.close", "git.expected-diff"]) {
      check(id, false, "控制面不可验证");
    }
  }
  return { version: 1, ok: checks.every(({ ok }) => ok), client: input.client, workItemId, checks };
}

async function main() {
  const summary = await verifySmoke(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const summary = { version: 1, ok: false, client: "unknown", workItemId: "unknown", checks: [{ id: "verifier.error", ok: false, detail: error instanceof Error ? error.message : String(error) }] };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
  });
}
