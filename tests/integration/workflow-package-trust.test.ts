import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";
import { recoverStaleWorkflowTrustLock, workflowTrustPath } from "../../src/storage/workflow-trust.js";
import { evaluateWorkflowTrust, recordWorkflowTrust, workflowCapabilityDigest } from "../../src/workflow-package/trust.js";
import { git, createGitRepository } from "./helpers/git.js";

async function packageFixture(root: string, id = "team-feature"): Promise<string> {
  const directory = path.join(root, ".wsspec", "workflows", id);
  await mkdir(path.join(directory, "skills", "review"), { recursive: true });
  await writeFile(path.join(directory, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: []\ncapabilities: [external-read]\nskills: [review]\n");
  await writeFile(path.join(directory, "workflow.yaml"), `version: 1\nworkflow: { id: ${id}, version: 1 }\ninputs: {}\nsteps:\n  - id: review\n    uses: agent.execute\n    skills: [{ ref: package://skills/review, required: true }]\ngates: []\nchangePolicy: { kind: feature, allowedPaths: ['**'] }\n`);
  await writeFile(path.join(directory, "skills", "review", "SKILL.md"), "# Review\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", `test: add ${id}`);
  return directory;
}

const execute = promisify(execFile);

function evaluateInteractive(root: string, pkg: Awaited<ReturnType<typeof loadWorkflowPackage>>, actor = "tester") {
  return evaluateWorkflowTrust({ root, pkg, interactive: true, actor, channel: "interactive" });
}

test("项目 Package 首次使用要求交互信任，确认后相同摘要可复用", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });

  const pending = await evaluateInteractive(root, pkg);
  assert.equal(pending.status, "approval_required");
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  assert.equal(pending.summary.packageRef, "project://workflows/team-feature");
  assert.deepEqual(pending.summary.capabilities, ["external-read"]);
  assert.ok(pending.summary.fileDigests.every((entry) => !path.isAbsolute(entry.path)));
  assert.ok(pending.summary.skillDigests.every((entry) => entry.ref === "package://skills/review"));

  const recorded = await recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest });
  assert.equal(recorded.decision, "trusted");
  assert.equal(recorded.requestId, pending.summary.requestId);
  const trusted = await evaluateInteractive(root, pkg);
  assert.equal(trusted.status, "trusted");
  const records = await readFile(path.join(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "wsspec", "trust", "workflow-packages.ndjson"), "utf8");
  assert.match(records, /"packageRef":"project:\/\/workflows\/team-feature"/);
  assert.doesNotMatch(records, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(records, /# Review/);
  assert.deepEqual(records.trimEnd().split("\n").map((line) => JSON.parse(line) as { event: string }).map((event) => event.event), ["requested", "decided"]);
  await assert.rejects(readFile(`${await workflowTrustPath(root)}.pending.ndjson`, "utf8"), /ENOENT/);
});

test("非交互评估不创建可消费的信任请求", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  await assert.rejects(evaluateWorkflowTrust({ root, pkg, interactive: false }), /WSSPEC_WORKFLOW_TRUST_REQUIRED/);
  await assert.rejects(readFile(await workflowTrustPath(root), "utf8"), /ENOENT/);
  await assert.rejects(recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId: crypto.randomUUID(), expectedPackageDigest: pkg.contentDigest, expectedCapabilityDigest: workflowCapabilityDigest(pkg) }), /WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID/);
});

test("拒绝记录保持 Package blocked，非交互不会默认接受", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  await assert.rejects(evaluateWorkflowTrust({ root, pkg, interactive: false }), /WSSPEC_WORKFLOW_TRUST_REQUIRED/);
  const pending = await evaluateInteractive(root, pkg);
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  await recordWorkflowTrust({ root, pkg, decision: "rejected", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest });

  const rejected = await evaluateInteractive(root, pkg);
  assert.equal(rejected.status, "rejected");
  assert.equal((await evaluateWorkflowTrust({ root, pkg, interactive: false })).status, "rejected");
});

test("内容或能力变化使信任失效，但仅搬迁相同内容不失效", async () => {
  const root = await createGitRepository();
  const source = await packageFixture(root, "team-feature");
  const trusted = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const pending = await evaluateInteractive(root, trusted);
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  await recordWorkflowTrust({ root, pkg: trusted, decision: "trusted", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest });

  const moved = path.join(root, ".wsspec", "workflows", "moved-feature");
  await mkdir(path.dirname(moved), { recursive: true });
  await writeFile(path.join(source, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: []\ncapabilities: [external-read]\nskills: [review]\n");
  await git(root, "mv", ".wsspec/workflows/team-feature", ".wsspec/workflows/moved-feature");
  const movedPackage = await loadWorkflowPackage({ root, ref: "project://workflows/moved-feature" });
  assert.equal((await evaluateInteractive(root, movedPackage)).status, "trusted");

  await writeFile(path.join(moved, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: []\ncapabilities: [external-read, external-write]\nskills: [review]\n");
  const changed = await loadWorkflowPackage({ root, ref: "project://workflows/moved-feature" });
  assert.equal((await evaluateInteractive(root, changed)).status, "approval_required");
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
  assert.throws(() => builtin.workflow.steps[1]!.skills!.push({ ref: "package://skills/forged" }), /TypeError/);
  assert.equal((await evaluateWorkflowTrust({ root, pkg: builtin, interactive: false })).status, "trusted");
});

test("Builtin Package 的 Map 原型改写使 provenance 失效", async () => {
  const root = await createGitRepository();
  const builtin = await loadWorkflowPackage({ root, ref: "builtin://workflows/feature-delivery" });
  Map.prototype.set.call(builtin.packageSkills, "package://skills/forged", { entrypoint: "/forged/SKILL.md", digest: "sha256:forged" });
  await assert.rejects(evaluateWorkflowTrust({ root, pkg: builtin, interactive: false }), /WSSPEC_WORKFLOW_PACKAGE_BUILTIN_PROVENANCE_INVALID/);
});

test("没有 pending request 不能直接写入 trusted", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  await assert.rejects(recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId: "missing", expectedPackageDigest: pkg.contentDigest, expectedCapabilityDigest: workflowCapabilityDigest(pkg) }), /WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID/);
});

test("信任请求严格绑定 interactive channel 和 actor", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  await assert.rejects(evaluateWorkflowTrust({ root, pkg, interactive: true, actor: "tester", channel: "batch" } as never), /WSSPEC_WORKFLOW_TRUST_CHANNEL_INVALID/);
  const pending = await evaluateInteractive(root, pkg, "requester");
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  await assert.rejects(recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "other", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest }), /WSSPEC_WORKFLOW_TRUST_ACTOR_INVALID/);
});

test("信任 journal 严格校验 ISO 时间、先后关系和过期状态", async () => {
  for (const mutation of ["invalid-iso", "reversed", "expired"] as const) {
    const root = await createGitRepository();
    await packageFixture(root);
    const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
    const pending = await evaluateInteractive(root, pkg);
    if (pending.status !== "approval_required") throw new Error("expected approval summary");
    const target = await workflowTrustPath(root);
    const request = JSON.parse((await readFile(target, "utf8")).trim()) as Record<string, unknown>;
    if (mutation === "invalid-iso") request.expiresAt = "not-a-timestamp";
    if (mutation === "reversed") request.expiresAt = request.createdAt;
    if (mutation === "expired") {
      request.createdAt = "2020-01-01T00:00:00.000Z";
      request.expiresAt = "2020-01-01T00:10:00.000Z";
    }
    await writeFile(target, `${JSON.stringify(request)}\n`);
    await assert.rejects(
      recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest }),
      mutation === "expired" ? /WSSPEC_WORKFLOW_TRUST_REQUEST_INVALID/ : /WSSPEC_WORKFLOW_TRUST_JOURNAL_INVALID/,
      mutation,
    );
  }
});

test("同一信任决定跨调用幂等，冲突决定 fail closed", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const pending = await evaluateInteractive(root, pkg);
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  const input = { root, pkg, decision: "trusted" as const, actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest };
  const first = await recordWorkflowTrust(input);
  const second = await recordWorkflowTrust(input);
  assert.deepEqual(second, first);
  assert.equal((await readFile(await workflowTrustPath(root), "utf8")).trimEnd().split("\n").length, 2);
  await assert.rejects(recordWorkflowTrust({ ...input, decision: "rejected" }), /WSSPEC_WORKFLOW_TRUST_DECISION_CONFLICT/);
});

test("另一进程可从同一 Git common-dir 消费信任请求", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const pending = await evaluateInteractive(root, pkg);
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  const loaderUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../src/workflow-package/loader.ts")).href;
  const trustUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../src/workflow-package/trust.ts")).href;
  const program = `import { loadWorkflowPackage } from ${JSON.stringify(loaderUrl)}; import { recordWorkflowTrust } from ${JSON.stringify(trustUrl)}; const [root, requestId, packageDigest, capabilityDigest] = process.argv.slice(1); const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" }); const record = await recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId, expectedPackageDigest: packageDigest, expectedCapabilityDigest: capabilityDigest }); process.stdout.write(JSON.stringify(record));`;
  const result = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program, root, pending.summary.requestId, pending.summary.packageDigest, pending.summary.capabilityDigest], { cwd: path.resolve(import.meta.dirname, "../..") });
  assert.equal((JSON.parse(result.stdout) as { requestId: string }).requestId, pending.summary.requestId);
  assert.equal((await evaluateInteractive(root, pkg)).status, "trusted");
});

test("journal 的半行与未知事件一律 fail closed", async () => {
  for (const corruption of ["half-line", "unknown-event"] as const) {
    const root = await createGitRepository();
    await packageFixture(root);
    const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
    const target = await workflowTrustPath(root);
    await mkdir(path.dirname(target), { recursive: true });
    const event = { event: corruption === "half-line" ? "requested" : "unknown", requestId: "corrupt", packageRef: pkg.ref, packageDigest: pkg.contentDigest, capabilityDigest: workflowCapabilityDigest(pkg), actor: "tester", channel: "interactive", createdAt: "2026-08-17T00:00:00.000Z", expiresAt: "2026-08-17T00:10:00.000Z" };
    await writeFile(target, `${JSON.stringify(event)}${corruption === "half-line" ? "" : "\n"}`);
    await assert.rejects(evaluateInteractive(root, pkg), /WSSPEC_WORKFLOW_TRUST_JOURNAL_INVALID/, corruption);
  }
});

test("externalSideEffects 独立变化使已有信任失效", async () => {
  const root = await createGitRepository();
  const directory = await packageFixture(root);
  const first = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const pending = await evaluateInteractive(root, first);
  if (pending.status !== "approval_required") throw new Error("expected approval summary");
  await recordWorkflowTrust({ root, pkg: first, decision: "trusted", actor: "tester", requestId: pending.summary.requestId, expectedPackageDigest: pending.summary.packageDigest, expectedCapabilityDigest: pending.summary.capabilityDigest });
  await writeFile(path.join(directory, "manifest.yaml"), "version: 1\nid: team-feature\nentry: workflow.yaml\nprofiles: []\ncapabilities: [external-read]\nexternalSideEffects: [external-write]\nskills: [review]\n");
  const changed = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  assert.equal((await evaluateInteractive(root, changed)).status, "approval_required");
});

async function writeTrustLock(root: string, content: string, ageMilliseconds = 0): Promise<string> {
  const lockPath = `${await workflowTrustPath(root)}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, content);
  if (ageMilliseconds > 0) {
    const old = new Date(Date.now() - ageMilliseconds);
    await utimes(lockPath, old, old);
  }
  return lockPath;
}

test("fresh 空锁和半写 owner 锁拒绝恢复", async () => {
  for (const content of ["", '{"version":1']) {
    const root = await createGitRepository();
    const lockPath = await writeTrustLock(root, content);
    await assert.rejects(recoverStaleWorkflowTrustLock(root), /WSSPEC_WORKFLOW_TRUST_LOCKED/);
    assert.equal((await stat(lockPath)).isFile(), true);
  }
});

test("仅恢复 mtime 已过阈值且稳定的空锁和半写 owner 锁", async () => {
  for (const content of ["", '{"version":1']) {
    const root = await createGitRepository();
    const lockPath = await writeTrustLock(root, content, 120_000);
    assert.equal(await recoverStaleWorkflowTrustLock(root), true);
    await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/);
  }
});

test("完整 owner 按 fresh、dead、远端不可验证和本机 live 状态恢复", async () => {
  const localHostname = (await import("node:os")).hostname();
  const owner = (pid: number, ownerHostname = localHostname) => `${JSON.stringify({
    version: 1,
    ownerToken: crypto.randomUUID(),
    pid,
    hostname: ownerHostname,
    createdAt: new Date().toISOString(),
  })}\n`;

  const freshDeadRoot = await createGitRepository();
  const freshDeadLock = await writeTrustLock(freshDeadRoot, owner(2147483647));
  await assert.rejects(recoverStaleWorkflowTrustLock(freshDeadRoot), /WSSPEC_WORKFLOW_TRUST_LOCKED/);
  assert.equal((await stat(freshDeadLock)).isFile(), true);

  const root = await createGitRepository();
  const deadLock = await writeTrustLock(root, owner(2147483647), 120_000);
  assert.equal(await recoverStaleWorkflowTrustLock(root), true);
  await assert.rejects(readFile(deadLock, "utf8"), /ENOENT/);

  const remoteRoot = await createGitRepository();
  const remoteLock = await writeTrustLock(remoteRoot, owner(process.pid, "remote.example.invalid"), 120_000);
  assert.equal(await recoverStaleWorkflowTrustLock(remoteRoot), true);
  await assert.rejects(readFile(remoteLock, "utf8"), /ENOENT/);

  const liveRoot = await createGitRepository();
  const liveLock = await writeTrustLock(liveRoot, owner(process.pid), 120_000);
  await assert.rejects(recoverStaleWorkflowTrustLock(liveRoot), /WSSPEC_WORKFLOW_TRUST_LOCKED/);
  assert.equal((await stat(liveLock)).isFile(), true);
});

test("正常信任写入不残留发布临时文件或 final lock", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const pending = await evaluateInteractive(root, pkg);
  assert.equal(pending.status, "approval_required");
  const trustDirectory = path.dirname(await workflowTrustPath(root));
  assert.deepEqual((await readdir(trustDirectory)).filter((name) => name.includes(".lock")), []);
});

test("并发信任请求期间可见的 final lock 始终包含完整 owner metadata", async () => {
  const root = await createGitRepository();
  await packageFixture(root);
  const pkg = await loadWorkflowPackage({ root, ref: "project://workflows/team-feature" });
  const trustPath = await workflowTrustPath(root);
  const operations = Array.from({ length: 24 }, (_, index) => evaluateInteractive(root, pkg, `actor-${index}`));
  let complete = false;
  const settled = Promise.all(operations).finally(() => { complete = true; });
  while (!complete) {
    try {
      const owner = JSON.parse(await readFile(`${trustPath}.lock`, "utf8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(owner).sort(), ["createdAt", "hostname", "ownerToken", "pid", "version"]);
      assert.equal(owner.version, 1);
      assert.equal(typeof owner.ownerToken, "string");
      assert.equal(typeof owner.pid, "number");
      assert.equal(typeof owner.hostname, "string");
      assert.equal(typeof owner.createdAt, "string");
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ENOENT") throw caught;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const results = await settled;
  assert.equal(results.every((result) => result.status === "approval_required"), true);
  assert.equal((await readFile(trustPath, "utf8")).trimEnd().split("\n").length, operations.length);
  assert.deepEqual((await readdir(path.dirname(trustPath))).filter((name) => name.includes(".lock")), []);
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
    /WSSPEC_WORKFLOW_TRUST_(CHANGED|REQUEST_INVALID)/,
  );
  await assert.rejects(
    recordWorkflowTrust({ root, pkg, decision: "trusted", actor: "tester", requestId: "missing", expectedPackageDigest: "sha256:wrong", expectedCapabilityDigest: "sha256:wrong" }),
    /WSSPEC_WORKFLOW_TRUST_(CHANGED|REQUEST_INVALID)/,
  );
  const common = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const trustPath = path.join(common, "wsspec", "trust", "workflow-packages.ndjson");
  await mkdir(path.dirname(trustPath), { recursive: true });
  await writeFile(trustPath, `${JSON.stringify({ event: "requested", requestId: "corrupt", packageRef: pkg.ref, packageDigest: pkg.contentDigest, capabilityDigest: workflowCapabilityDigest(pkg), actor: "tester", channel: "interactive", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), typo: true })}\n`);
  await assert.rejects(evaluateInteractive(root, pkg), /WSSPEC_WORKFLOW_TRUST_JOURNAL_INVALID/);
});
