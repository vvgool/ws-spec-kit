import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SchemaValidationError,
  generatePublicSchemas,
  getSchema,
  validate,
  type SchemaId,
} from "../../src/schemas/index.js";

const validValues: Record<SchemaId, Record<string, unknown>> = {
  "builtin.workflow.v1": {
    version: 1,
    workflow: { id: "verified-delivery" },
    stages: [
      {
        id: "define",
        kind: "define",
        owner: "agent",
        uses: "artifact.generate",
        needs: [],
        input: ["intent"],
        output: ["specification"],
        approval: { required: true, provider: "interactive" },
        gates: [],
        publish: [],
      },
    ],
  },
  "builtin.workflow-selection.v1": {
    version: 1,
    activeWorkflow: { ref: "builtin://workflows/feature-delivery", version: 1 },
    profile: "auto",
  },
  "builtin.application-project-config.v1": { version: 1 },
  "builtin.project-config.v1": {
    version: 1,
    trigger: { mode: "suggest" },
    git: { worktrees: { enabled: true, root: ".worktrees", branchPrefix: "wspec/" } },
    runtime: { claimTtlSeconds: 1800, maxStageRetries: 3 },
    quality: {
      gates: {
        test: {
          command: ["npm", "test"],
          cwd: "worktree",
          timeoutSeconds: 900,
          required: true,
          evidence: "trusted",
          inheritEnv: ["PATH"],
          env: { NODE_ENV: "test" },
        },
      },
    },
    publishing: { targets: {} },
    documentation: { allowedPaths: ["docs/**/*.md"] },
    skills: { additionalGlobalRoots: ["/opt/wsspec/skills"] },
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

test("workflow stages accept fields that have normative defaults as omitted", () => {
  const minimalWorkflow = {
    version: 1,
    workflow: { id: "minimal" },
    stages: [{ id: "close", kind: "close", owner: "engine", uses: "work-item.close" }],
  };

  assert.deepEqual(validate("builtin.workflow.v1", minimalWorkflow), minimalWorkflow);
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

test("project config v1 preserves every normative top-level and nested required field", () => {
  const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["/version", (value) => { delete value.version; }],
    ["/trigger", (value) => { delete value.trigger; }],
    ["/git", (value) => { delete value.git; }],
    ["/runtime", (value) => { delete value.runtime; }],
    ["/quality", (value) => { delete value.quality; }],
    ["/trigger/mode", (value) => { delete (value.trigger as Record<string, unknown>).mode; }],
    ["/git/worktrees", (value) => { delete (value.git as Record<string, unknown>).worktrees; }],
    ["/git/worktrees/enabled", (value) => { delete ((value.git as Record<string, unknown>).worktrees as Record<string, unknown>).enabled; }],
    ["/git/worktrees/root", (value) => { delete ((value.git as Record<string, unknown>).worktrees as Record<string, unknown>).root; }],
    ["/git/worktrees/branchPrefix", (value) => { delete ((value.git as Record<string, unknown>).worktrees as Record<string, unknown>).branchPrefix; }],
    ["/runtime/claimTtlSeconds", (value) => { delete (value.runtime as Record<string, unknown>).claimTtlSeconds; }],
    ["/runtime/maxStageRetries", (value) => { delete (value.runtime as Record<string, unknown>).maxStageRetries; }],
    ["/quality/gates", (value) => { delete (value.quality as Record<string, unknown>).gates; }],
    ["/quality/gates/test/command", (value) => { delete (((value.quality as Record<string, unknown>).gates as Record<string, unknown>).test as Record<string, unknown>).command; }],
    ["/quality/gates/test/cwd", (value) => { delete (((value.quality as Record<string, unknown>).gates as Record<string, unknown>).test as Record<string, unknown>).cwd; }],
    ["/quality/gates/test/timeoutSeconds", (value) => { delete (((value.quality as Record<string, unknown>).gates as Record<string, unknown>).test as Record<string, unknown>).timeoutSeconds; }],
    ["/quality/gates/test/required", (value) => { delete (((value.quality as Record<string, unknown>).gates as Record<string, unknown>).test as Record<string, unknown>).required; }],
    ["/quality/gates/test/evidence", (value) => { delete (((value.quality as Record<string, unknown>).gates as Record<string, unknown>).test as Record<string, unknown>).evidence; }],
    ["/publishing/targets", (value) => { delete (value.publishing as Record<string, unknown>).targets; }],
    ["/documentation/allowedPaths", (value) => { delete (value.documentation as Record<string, unknown>).allowedPaths; }],
    ["/skills/additionalGlobalRoots", (value) => { delete (value.skills as Record<string, unknown>).additionalGlobalRoots; }],
  ];

  for (const [expectedPath, remove] of cases) {
    const value = structuredClone(validValues["builtin.project-config.v1"]);
    remove(value);
    assert.throws(
      () => validate("builtin.project-config.v1", value),
      (error: unknown) => error instanceof SchemaValidationError
        && error.code === "WSSPEC_SCHEMA_REQUIRED_FIELD"
        && error.path === expectedPath,
      expectedPath,
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
