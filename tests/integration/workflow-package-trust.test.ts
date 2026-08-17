import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";
import { recoverStaleWorkflowTrustLock, workflowTrustPath } from "../../src/storage/workflow-trust.js";
import { evaluateWorkflowTrust, recordWorkflowTrust } from "../../src/workflow-package/trust.js";
import { git, createGitRepository } from "./helpers/git.js";

async function packageFixture(root: string, id = "team-feature"): Promise<string> {
  const directory = path.join(root, ".wsspec", "workflows", id);
  await mkdir(path.join(directory, "skills", "review"), { recursive: true });
  await writeFile(path.join(directory, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: []\ncapabilities: [external-read]\nskills: [review]\n");
  await writeFile(path.join(directory, "workflow.yaml"), "version: 1\nid: team-feature\nsteps:\n  - id: review\n    skills: [package://skills/review]\n");
  await writeFile(path.join(directory, "skills", "review", "SKILL.md"), "# Review\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", `test: add ${id}`);
  return directory;
}

test("项目 Package 首次使用要求交互信任，确认后相同摘要可复用", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  const pending = await evaluateWorkflowTrust({ root, pkg, interactive: true });
  assert.equal(pending.status, "approval_required");
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  assert.equal(pending.summary.packageRef, "project://workflows/team-feature");
  assert.deepEqual(pending.summary.capabilities, ["external-read"]);
  assert.ok(pending.summary.fileDigests.every((entry) => !path.isAbsolute(entry.path)));
  assert.ok(pending.summary.skillDigests.every((entry) => entry.ref === "package://skills/review"));

  const recorded = await recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest });
  assert.equal(recorded.decision, "trusted");
  const trusted = await evaluateWorkflowTrust({ root, pkg, interactive: true });
  assert.equal(trusted.status, "trusted");
  const records = await readFile(path.join(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "wsspec", "trust", "workflow-packages.ndjson"), "utf8");
  assert.match(records, /"packageRef":"project:\/\/workflows\/team-feature"/);
  assert.doesNotMatch(records, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(records, /# Review/);
});

test("拒绝记录保持 Package blocked，非交互不会默认接受", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  await assert.rejects(evaluateWorkflowTrust({ root, pkg, interactive: false }), /WSSPEC_WORKFLOW_TRUST_REQUIRED/);
  const pending = await evaluateWorkflowTrust({ root, pkg, interactive: true });
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  await recordWorkflowTrust({ root, pkg, decision: "rejected", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest });

  const rejected = await evaluateWorkflowTrust({ root, pkg, interactive: true });
  assert.equal(rejected.status, "rejected");
  assert.equal((await evaluateWorkflowTrust({ root, pkg, interactive: false })).status, "rejected");
});

test("内容或能力变化使信任失效，但仅搬迁相同内容不失效", async () => {
  const root = await createGitRepository();
  const source = await packageFixture(root, "team-feature");
  const trusted = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const pending = await evaluateWorkflowTrust({ root, pkg: trusted, interactive: true });
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  await recordWorkflowTrust({ root, pkg: trusted, decision: "trusted", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest });

  const moved = path.join(root, ".wsspec", "workflows", "moved-feature");
  await mkdir(path.dirname(moved), { recursive: true });
  await writeFile(path.join(source, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: []\ncapabilities: [external-read]\nskills: [review]\n");
  await git(root, "mv", ".wsspec/workflows/team-feature", ".wsspec/workflows/moved-feature");
  const movedPackage = await loadWorkflowPackage({ root, ref: "project://workflows/moved-feature" });
  assert.equal((await evaluateWorkflowTrust({ root, pkg: movedPackage, interactive: true })).status, "trusted");

  await writeFile(path.join(moved, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: []\ncapabilities: [external-read, external-write]\nskills: [review]\n");
  const changed = await loadWorkflowPackage({ root, ref: "project://workflows/moved-feature" });
  assert.equal((await evaluateWorkflowTrust({ root, pkg: changed, interactive: true })).status, "approval_required");
});

test("内置 Package 仅由内置信任来源信任", async () => {
  const root = await createGitRepository();
  const builtin = await loadWorkflowPackage({ root, ref: "builtin://workflows/feature-delivery" });
  const decision = await evaluateWorkflowTrust({ root, pkg: builtin, interactive: false });
  assert.equal(decision.status, "trusted");
  if (decision.status === "trusted") assert.equal(decision.record.actor, "builtin");
});

test("Builtin Package 的嵌套内容不可在信任前被篡改", async () => {
  const root = await createGitRepository();
  const builtin = await loadWorkflowPackage({ root, ref: "builtin://workflows/feature-delivery" });
  assert.throws(() => builtin.workflow.steps[0]!.skills.push("package://skills/forged"), /TypeError/);
  assert.equal((await evaluateWorkflowTrust({ root, pkg: builtin, interactive: false })).status, "trusted");
});

test("没有 pending request 不能直接写入 trusted", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  await assert.rejects(recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId: "missing", expectedPackageDigest: pkg.contentDigest, expectedCapabilityDigest: "sha256:ignored" } as never), /WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID/);
});

test("externalSideEffects 独立变化使已有信任失效", async () => {
  const root = await createGitRepository();
  const directory = await packageFixture(root);
  const first = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const pending = await evaluateWorkflowTrust({ root, pkg: first, interactive: true });
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  await recordWorkflowTrust({ root, pkg: first, decision: "trusted", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest });
  await writeFile(path.join(directory, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: []\ncapabilities: [external-read]\nexternalSideEffects: [external-write]\nskills: [review]\n");
  const changed = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  assert.equal((await evaluateWorkflowTrust({ root, pkg: changed, interactive: true })).status, "approval_required");
});

test("显式恢复仅清除本机已死亡拥有者的信任锁", async () => {
  const root = await createGitRepository();
  const target = await workflowTrustPath(root);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.lock`, `${JSON.stringify({ version: 1, ownerToken: "dead-owner", pid: 2147483647, hostname: (await import("node:os")).hostname(), createdAt: new Date().toISOString() })}\n`);
  assert.equal(await recoverStaleWorkflowTrustLock(root), true);
  await assert.rejects(readFile(`${target}.lock`, "utf8"), /ENOENT/);
});

test("伪造或篡改为 Builtin URI 的普通 Package 仍要求信任", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const project = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const forged = { ...project, ref: "builtin://workflows/feature-delivery" };
  await assert.rejects(evaluateWorkflowTrust({ root, pkg: forged, interactive: false }), /WSSPEC_WORKFLOW_PACKAGE_BUILTIN_PROVENANCE_INVALID/);
});

test("信任记录必须匹配用户看到的两个摘要，并拒绝未知持久化字段", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  await assert.rejects(
    recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester" } as never),
    /WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID/,
  );
  await assert.rejects(
    recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId: "missing", expectedPackageDigest: "sha256:wrong", expectedCapabilityDigest: "sha256:wrong" }),
    /WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID/,
  );
  const common = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const trustPath = path.join(common, "wsspec", "trust", "workflow-packages.ndjson");
  await mkdir(path.dirname(trustPath), { recursive: true });
  await writeFile(trustPath, `${JSON.stringify({ packageRef: pkg.ref, packageDigest: pkg.contentDigest, capabilityDigest: "sha256:test", decision: "trusted", actor: "tester", decidedAt: "now", typo: true })}\n`);
  await assert.rejects(evaluateWorkflowTrust({ root, pkg, interactive: true }), /WSSPEC_WORKFLOW_TRUST_RECORD_INVALID/);
});
