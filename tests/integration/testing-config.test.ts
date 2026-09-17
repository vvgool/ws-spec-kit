import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { parse } from "yaml";
import { initRepository } from "../../src/storage/repository.js";
import { git } from "./helpers/git.js";

test("init identifies a single workspace Vitest script and monorepo product paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-detect-"));
  await git(root, "init");
  await mkdir(path.join(root, "apps/web"), { recursive: true });
  await mkdir(path.join(root, "packages"));
  await writeFile(path.join(root, "package.json"), '{"devDependencies":{"vitest":"4.1.10"}}');
  await writeFile(path.join(root, "apps/web/package.json"), '{"scripts":{"test":"vitest run"}}');
  await initRepository(root);
  const config = parse(await readFile(path.join(root, ".wsspec/config.yaml"), "utf8"));
  assert.equal(config.quality.gates.test.reporter.type, "vitest");
  assert.deepEqual(config.quality.gates.test.command, ["node", "node_modules/vitest/vitest.mjs", "run", "--root", "apps/web"]);
  assert.deepEqual(config.testing.productPaths, ["apps/**", "packages/**"]);
});

import { createApplication } from "../../src/application/application.js";
import { createApplicationArtifact } from "../../src/application/artifact.js";
import { loadApplicationState } from "../../src/application/state.js";
import { migrateTestingConfig } from "../../src/application/testing-config.js";
import { fixedTestGateForState } from "../../src/engine/verification.js";
import { readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { defaultProjectConfig } from "../../src/storage/repository.js";
import { runCommand } from "../../src/cli/commands/core.js";
import type { AgentAction } from "../../src/protocol/application.js";

async function readyForTests() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-migrate-"));
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "Test");
  await initRepository(root);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const app = createApplication({ provider: "generic", terminal: { isTTY: false } });
  const started = await app.start({ root, source: { type: "prompt", text: "测试迁移" }, profile: "standard" });
  let action: AgentAction = await app.acquire({ root, workItemId: started.workItemId, actor: "test" });
  for (let i = 0; i < 16; i++) {
    if (action.action === "await_approval") {
      action = await app.decide({ kind: "approval", root, workItemId: started.workItemId, actor: "test", requestId: action.approval.requestId, expectedDigest: action.approval.digest, decision: "approved", confirmation: { source: "conversation", userMessage: "同意当前版本" } });
      continue;
    }
    assert.equal(action.action, "execute");
    if (action.action !== "execute") throw new Error(JSON.stringify(action));
    const pkg = action.workPackage;
    if (pkg.stepId === "write-tests") return { root, app, pkg };
    const artifacts = pkg.artifacts.filter(a => a.artifactType === "requirement-source" && pkg.requiredOutputs.some(o => o.artifactType === "requirement-source"));
    for (const output of pkg.requiredOutputs) {
      if (output.artifactType === "requirement-source") continue;
      const body = output.artifactType === "specification"
        ? "# 目标与背景\n测试\n# 范围\n测试\n# 需求\n测试\n# 验收条件\n测试\n# 约束\n测试\n# 排除项\n无\n# 开放问题\n无\n"
        : output.artifactType === "tasks" ? "# 任务\n```yaml\ntasks:\n  - id: task-1\n    status: pending\n    dependencies: []\n    completion: 测试通过\n```\n" : output.artifactType === "design" ? ["上下文与架构", "组件职责和边界", "接口与数据契约", "安全与权限", "失败与恢复", "兼容或迁移", "测试策略", "已知权衡"].map(title => `# ${title}\n测试配置迁移\n`).join("\n") : "# 探索\n测试配置迁移\n";
      const file = `.wsspec/work-items/${pkg.workItemId}/drafts/${output.outputId}.md`;
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), body);
      artifacts.push(await createApplicationArtifact({ root, workItemId: pkg.workItemId, stepId: pkg.stepId, attemptId: pkg.attemptId, leaseToken: pkg.lease.token, artifactType: output.artifactType, outputId: output.outputId!, contentFile: file }, { now: () => new Date() }));
    }
    action = await app.submit({ root, workItemId: pkg.workItemId, stepId: pkg.stepId, attemptId: pkg.attemptId, leaseToken: pkg.lease.token,
      result: { version: 1, status: "completed", summary: "完成", modifiedFiles: [], artifacts, commands: [], evidence: [], externalWrites: [], remainingRisks: [] } });
  }
  throw new Error("did not reach write-tests");
}

test("public config migration preserves snapshots, rotates Claim and survives event recovery", async () => {
  const { root, app, pkg } = await readyForTests();
  const before = await loadApplicationState(root, pkg.workItemId);
  const snapshot = await readFile(path.join(before.itemRoot, "snapshot/config.yaml"), "utf8");
  const config = defaultProjectConfig() as any;
  config.quality.gates.test.command = ["node", "node_modules/vitest/vitest.mjs", "run"];
  config.quality.gates.test.reporter.type = "vitest";
  config.testing.productPaths = ["apps/**", "packages/**"];
  const file = path.join(root, `.wsspec/work-items/${pkg.workItemId}/drafts/migrate.json`);
  await writeFile(file, JSON.stringify(config));
  const input = { root, workItemId: pkg.workItemId, config, expectedDigest: before.item.execution.configDigest, actor: "test" };
  await assert.rejects(migrateTestingConfig({ ...input, expectedDigest: "sha256:stale" }), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
  const result = await runCommand(root, ["config", "migrate", pkg.workItemId, "--file", file, "--expected-digest", input.expectedDigest, "--actor", "test"]);
  assert.deepEqual(await migrateTestingConfig(input), result);
  assert.equal(await readFile(path.join(before.itemRoot, "snapshot/config.yaml"), "utf8"), snapshot);
  await recoverControlPlane({ cwd: root, workItemId: pkg.workItemId });
  const after = await loadApplicationState(root, pkg.workItemId);
  assert.equal((await fixedTestGateForState(after)).reporter.type, "vitest");
  assert.equal(after.projection.claims["write-tests"], undefined);
  const next = await app.acquire({ root, workItemId: pkg.workItemId, actor: "test" });
  assert.equal(next.action, "execute");
  if (next.action !== "execute") throw new Error("missing claim");
  assert.notEqual(next.workPackage.attemptId, pkg.attemptId);
  assert.equal(next.workPackage.stepId, "write-tests");
  const bad = structuredClone(config); bad.quality.gates.test.required = false;
  await assert.rejects(migrateTestingConfig({ ...input, config: bad, expectedDigest: (result as { configDigest: string }).configDigest }), { code: "WSSPEC_TDD_GATE_CONFIGURATION_INVALID" });
  assert.equal((await readControlPlane(root, pkg.workItemId)).claims["write-tests"]?.attemptId, next.workPackage.attemptId);
  const changed = structuredClone(config); changed.quality.gates.test.timeoutSeconds = 90;
  const expectedDigest = (result as { configDigest: string }).configDigest;
  await assert.rejects(migrateTestingConfig({ ...input, config: changed, expectedDigest, actor: "other" }), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
  await mkdir(path.join(after.worktree, "tests"), { recursive: true });
  await writeFile(path.join(after.worktree, "tests/partial.test.js"), "// partial test work");
  await assert.rejects(migrateTestingConfig({ ...input, config: changed, expectedDigest }), { code: "WSSPEC_TDD_EVIDENCE_INVALIDATED" });
  assert.equal((await readControlPlane(root, pkg.workItemId)).claims["write-tests"]?.attemptId, next.workPackage.attemptId);
});


test("ambiguous Vitest scopes fail init without leaving an initialized identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-ambiguous-"));
  await git(root, "init");
  for (const app of ["web", "admin"]) {
    await mkdir(path.join(root, "apps", app), { recursive: true });
    await writeFile(path.join(root, "apps", app, "package.json"), '{"scripts":{"test":"vitest run"}}');
  }
  await assert.rejects(initRepository(root), { code: "WSSPEC_TDD_GATE_CONFIGURATION_INVALID" });
  await assert.rejects(readFile(path.join(root, ".wsspec/repository.yaml")), { code: "ENOENT" });
});

import { suggestTestingConfig } from "../../src/storage/testing-config.js";

test("suggest resolves child-only Vitest and requires explicit scope for mixed scripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-child-vitest-"));
  for (const app of ["web", "admin"]) await mkdir(path.join(root, "apps", app), { recursive: true });
  await writeFile(path.join(root, "apps/web/package.json"), '{"scripts":{"test":"vitest run"},"devDependencies":{"vitest":"4.1.10"}}');
  const one = await suggestTestingConfig(root) as any;
  assert.equal(one.quality.gates.test.command[1], "apps/web/node_modules/vitest/vitest.mjs");
  await writeFile(path.join(root, "apps/admin/package.json"), '{"scripts":{"test":"vitest run --config custom.ts"},"devDependencies":{"vitest":"4.1.10"}}');
  await assert.rejects(suggestTestingConfig(root), { code: "WSSPEC_TDD_GATE_CONFIGURATION_INVALID" });
  assert.equal(((await suggestTestingConfig(root, "apps/web")) as any).quality.gates.test.command[1], "apps/web/node_modules/vitest/vitest.mjs");
});

test("suggest falls back to the installed hoisted Vitest entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-hoisted-vitest-"));
  await mkdir(path.join(root, "apps/web"), { recursive: true });
  await mkdir(path.join(root, "node_modules/vitest"), { recursive: true });
  await writeFile(path.join(root, "apps/web/package.json"), '{"scripts":{"test":"vitest run"},"devDependencies":{"vitest":"4.1.10"}}');
  await writeFile(path.join(root, "node_modules/vitest/vitest.mjs"), "// installed entry fixture");
  assert.equal(((await suggestTestingConfig(root)) as any).quality.gates.test.command[1], "node_modules/vitest/vitest.mjs");
});
