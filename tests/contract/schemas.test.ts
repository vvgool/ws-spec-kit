import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  SchemaValidationError,
  generatePublicSchemas,
  getSchema,
  validate,
  type SchemaId,
} from "../../src/schemas/index.js";
import { portableProjectConfigText } from "../../src/storage/project-config.js";

const validValues: Record<string, Record<string, unknown>> = {
  "builtin.workflow-selection.v1": {
    version: 1,
    activeWorkflow: { ref: "builtin://workflows/feature-delivery", version: 1 },
    profile: "auto",
  },
  "builtin.application-project-config.v1": { version: 1 },
  "builtin.application-project-config-snapshot.v1": {
    version: 1,
    skills: { additionalGlobalRoots: [{ id: "team-skills" }] },
  },
  "builtin.work-item.v1": {
    version: 1,
    workItemId: "WSS-20260816-001",
    repositoryId: "repo-01J5V8Q4Y7M6F3K2N1P0ABCDER",
    title: "支付重试",
    createdAt: "2026-08-16T10:00:00+08:00",
    status: "active",
    execution: {
      worktree: ".worktrees/WSS-20260816-001",
      branch: "wspec/WSS-20260816-001",
      baselineRevision: "abc123",
      baselineTreeDigest: "sha256:baseline",
      workflowDigest: "sha256:workflow",
      configDigest: "sha256:config",
      schemaDigest: "sha256:schema",
    },
    source: { type: "file", snapshot: "source/source.json", contentDigest: "sha256:source" },
    bindings: { issue: null, knowledge: null },
  },
  "builtin.application-start-input.v1": {
    root: "/workspace",
    source: { type: "prompt", text: "增加登录功能" },
    workflowRef: "builtin://workflows/feature-delivery",
    profile: "standard",
  },
  "builtin.application-acquire-input.v1": {
    root: "/workspace", workItemId: "WSS-20260816-001", actor: "codex",
  },
  "builtin.application-submit-input.v1": {
    root: "/workspace", workItemId: "WSS-20260816-001", stepId: "build",
    attemptId: "attempt-3", leaseToken: "opaque-token",
    result: {
      version: 1, status: "completed", summary: "实现完成", modifiedFiles: ["src/login.ts"],
      artifacts: [], commands: [], evidence: [], externalWrites: [], remainingRisks: [],
    },
  },
  "builtin.application-decision-input.v1": {
    kind: "workflow_trust", root: "/workspace", requestId: "trust-1", decision: "trusted",
    expectedPackageDigest: "sha256:package", expectedCapabilityDigest: "sha256:capability", actor: "user",
  },
  "builtin.application-inspect-input.v1": {
    root: "/workspace", workItemId: "WSS-20260816-001",
  },
  "builtin.agent-action.v1": {
    action: "blocked",
    problems: [{ code: "WSSPEC_SKILL_NOT_FOUND", message: "找不到 Skill", retryable: false }],
  },
  "builtin.work-package.v1": {
    version: 1, workItemId: "WSS-20260816-001", stepId: "build", attemptId: "attempt-3",
    lease: { token: "opaque-token", expiresAt: "2026-08-16T18:00:00+08:00" },
    objective: "实现批准的计划",
    skills: [{ ref: "builtin://skills/tdd-implementation", version: "1.0.0", digest: "sha256:skill", description: "执行 TDD" }],
    artifacts: [], constraints: { allowedPaths: ["src/**"], forbiddenActions: ["push"] },
    requiredOutputs: [], gates: [{ id: "test", evidence: "trusted", required: true }],
    resultSchema: "builtin.submit-result.v1",
  },
  "builtin.submit-result.v1": {
    version: 1,
    status: "completed",
    summary: "Implemented retry policy",
    modifiedFiles: ["src/retry.ts"],
    artifacts: [],
    commands: [],
    evidence: [],
    externalWrites: [],
    remainingRisks: [],
  },
  "builtin.evidence.v1": {
    evidenceId: "evidence-01",
    level: "trusted",
    gateId: "test",
    codeRevision: "abc123",
    baselineTreeDigest: "sha256:baseline",
    workspaceTreeDigest: "sha256:output",
    configDigest: "sha256:config",
    attemptId: "attempt-3",
    result: "passed",
    recordHash: "sha256:record",
  },
  "builtin.tdd-trusted-evidence.v1": {
    evidenceId: `evidence-${"a".repeat(64)}`,
    level: "trusted",
    phase: "red",
    taskId: "WSS-20260816-001",
    stepId: "verify-red",
    commandId: "test",
    commandDigest: "sha256:command",
    exitCode: 1,
    failedTests: ["login rejects invalid password"],
    testPaths: ["tests/login.test.ts"],
    testFiles: [{ path: "tests/login.test.ts", digest: "sha256:test-file" }],
    testPathsDigest: "sha256:test-paths",
    testPathRules: ["node"],
    testAssets: [{ path: "tests/login.test.ts", digest: "sha256:test-file" }],
    testAssetsDigest: "sha256:test-assets",
    testAssetPaths: ["tests/**"],
    testAssetRoots: ["tests"],
    productPaths: ["src/**"],
    workspaceDigest: "sha256:red-workspace",
    summary: "login rejects invalid password",
  },
  "builtin.tdd-cycle-evidence.v1": {
    taskId: "WSS-20260816-001",
    testPaths: ["tests/login.test.ts"],
    testPathRules: ["node"],
    testAssets: [{ path: "tests/login.test.ts", digest: "sha256:test-file" }],
    testAssetsDigest: "sha256:test-assets",
    testAssetPaths: ["tests/**"],
    testAssetRoots: ["tests"],
    productPaths: ["src/**"],
    commandId: "test",
    redEvidenceId: `evidence-${"a".repeat(64)}`,
    greenEvidenceId: `evidence-${"b".repeat(64)}`,
  },
  "builtin.tdd-node-test-report.v1": {
    version: 1,
    adapter: "node-test",
    summary: { success: false, tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 },
    failureTotal: 1,
    truncated: false,
    failures: [{ name: "login rejects invalid password", file: "/workspace/tests/login.test.ts", kind: "assertion" }],
  },
  "builtin.external-receipt.v1": {
    version: 1,
    kind: "external-receipt",
    target: "issue",
    stableId: "issue-01",
    externalWorkItemId: "WSS-20260816-001",
    publishStepId: "update-issue",
    publishAttemptId: "attempt-update-issue",
    publishInputDigest: "sha256:publish-input",
    publishedContentDigest: "sha256:published",
    readBackContentDigest: "sha256:published",
    status: "confirmed",
    readBackStatus: "confirmed",
  },
  "builtin.external-binding.v1": {
    version: 1,
    kind: "external-binding",
    target: "issue",
    exists: true,
    stableId: "issue-01",
    externalWorkItemId: "WSS-20260816-001",
    publishStepId: "update-issue",
    publishAttemptId: "attempt-update-issue",
    publishInputDigest: "sha256:publish-input",
    expectedPublishedContentDigest: "sha256:published",
  },
  "builtin.artifact.v1": {
    artifactType: "design",
    schemaVersion: 1,
    workItemId: "WSS-20260816-001",
    stageId: "design",
    attemptId: "attempt-2",
    revision: 3,
    contentHash: "sha256:content",
  },
};

test("all public v1 schemas accept their canonical example", () => {
  for (const [schemaId, value] of Object.entries(validValues)) {
    assert.deepEqual(validate(schemaId as SchemaId, value), value);
  }
});

test("public schemas reject unknown fields with a stable diagnostic", () => {
  const value = { ...validValues["builtin.artifact.v1"], unexpected: true };

  assert.throws(
    () => validate("builtin.artifact.v1", value),
    (error: unknown) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, "WSSPEC_SCHEMA_UNKNOWN_FIELD");
      assert.equal(error.path, "/unexpected");
      assert.match(error.suggestion, /unexpected/);
      return true;
    },
  );
});

test("public schemas reject missing required fields with a field path", () => {
  const value = { ...validValues["builtin.artifact.v1"] } as Record<string, unknown>;
  delete value.contentHash;

  assert.throws(
    () => validate("builtin.artifact.v1", value),
    (error: unknown) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, "WSSPEC_SCHEMA_REQUIRED_FIELD");
      assert.equal(error.path, "/contentHash");
      return true;
    },
  );
});

test("portable Project Config snapshot accepts logical root IDs only while host config still requires paths", () => {
  const hostConfig = {
    version: 1,
    skills: { additionalGlobalRoots: [{ id: "team-skills", path: "/host/team/skills" }] },
  };
  assert.deepEqual(validate("builtin.application-project-config.v1", hostConfig), hostConfig);
  const snapshot = parse(portableProjectConfigText(hostConfig)) as Record<string, unknown>;
  assert.deepEqual(snapshot, {
    version: 1,
    skills: { additionalGlobalRoots: [{ id: "team-skills" }] },
  });
  assert.deepEqual(validate("builtin.application-project-config-snapshot.v1" as SchemaId, snapshot), snapshot);

  for (const current of [
    {
      name: "host path",
      value: { version: 1, skills: { additionalGlobalRoots: [{ id: "team-skills", path: "/secret/root" }] } },
      code: "WSSPEC_SCHEMA_UNKNOWN_FIELD",
      fieldPath: "/skills/additionalGlobalRoots/0/path",
    },
    {
      name: "unknown root field",
      value: { version: 1, skills: { additionalGlobalRoots: [{ id: "team-skills", label: "secret" }] } },
      code: "WSSPEC_SCHEMA_UNKNOWN_FIELD",
      fieldPath: "/skills/additionalGlobalRoots/0/label",
    },
    {
      name: "missing root id",
      value: { version: 1, skills: { additionalGlobalRoots: [{}] } },
      code: "WSSPEC_SCHEMA_REQUIRED_FIELD",
      fieldPath: "/skills/additionalGlobalRoots/0/id",
    },
    {
      name: "duplicate root id",
      value: { version: 1, skills: { additionalGlobalRoots: [{ id: "team-skills" }, { id: "team-skills" }] } },
      code: "WSSPEC_SCHEMA_INVALID_VALUE",
      fieldPath: "/skills/additionalGlobalRoots",
    },
  ]) {
    assert.throws(
      () => validate("builtin.application-project-config-snapshot.v1" as SchemaId, current.value),
      (error: unknown) => error instanceof SchemaValidationError && error.code === current.code && error.path === current.fieldPath,
      current.name,
    );
  }

  assert.throws(
    () => validate("builtin.application-project-config.v1", {
      version: 1,
      skills: { additionalGlobalRoots: [{ id: "team-skills" }] },
    }),
    (error: unknown) => error instanceof SchemaValidationError
      && error.code === "WSSPEC_SCHEMA_REQUIRED_FIELD"
      && error.path === "/skills/additionalGlobalRoots/0/path",
  );
});

test("legacy Workflow 和 Project Config Schema 已从公开注册表移除", () => {
  for (const legacy of ["builtin.workflow.v1", "builtin.project-config.v1"]) {
    assert.throws(
      () => getSchema(legacy as SchemaId),
      (error: unknown) => error instanceof SchemaValidationError && error.code === "WSSPEC_SCHEMA_UNSUPPORTED_VERSION",
      legacy,
    );
  }
});

test("unsupported schema IDs fail closed", () => {
  assert.throws(
    () => getSchema("builtin.artifact.v2" as SchemaId),
    (error: unknown) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, "WSSPEC_SCHEMA_UNSUPPORTED_VERSION");
      assert.equal(error.path, "/schemaId");
      return true;
    },
  );
});

test("public schema generation is deterministic", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "wspec-schema-a-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "wspec-schema-b-"));

  await generatePublicSchemas(first);
  await generatePublicSchemas(second);

  const names = await readdir(first);
  assert.deepEqual(names, await readdir(second));
  for (const name of names) {
    assert.equal(await readFile(path.join(first, name), "utf8"), await readFile(path.join(second, name), "utf8"));
  }
});

test("checked-in public schemas match generated definitions", async () => {
  const generated = await mkdtemp(path.join(os.tmpdir(), "wspec-schema-drift-"));
  const checkedIn = path.resolve("schemas");
  await generatePublicSchemas(generated);

  const names = await readdir(generated);
  assert.deepEqual(await readdir(checkedIn), names);
  for (const name of names) {
    assert.equal(await readFile(path.join(checkedIn, name), "utf8"), await readFile(path.join(generated, name), "utf8"));
  }
});
