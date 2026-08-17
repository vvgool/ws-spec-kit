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
  },
  "builtin.work-item.v1": {
    version: 1,
    workItemId: "WSK-20260816-001",
    repositoryId: "repo-01J5V8Q4Y7M6F3K2N1P0ABCDER",
    title: "支付重试",
    createdAt: "2026-08-16T10:00:00+08:00",
    status: "active",
    execution: {
      worktree: ".worktrees/WSK-20260816-001",
      branch: "wspec/WSK-20260816-001",
      baselineRevision: "abc123",
      baselineTreeDigest: "sha256:baseline",
      workflowDigest: "sha256:workflow",
      configDigest: "sha256:config",
      schemaDigest: "sha256:schema",
    },
    source: { type: "file", snapshot: "source/source.json", contentDigest: "sha256:source" },
    bindings: { issue: null, knowledge: null },
  },
  "builtin.stage-context.v1": {
    version: 1,
    workItemId: "WSK-20260816-001",
    stageId: "build",
    attemptId: "attempt-3",
    claimToken: "opaque-token",
    claimExpiresAt: "2026-08-16T18:00:00+08:00",
    workflowDigest: "sha256:workflow",
    configDigest: "sha256:config",
    baselineTreeDigest: "sha256:baseline",
    inputWorkspaceTreeDigest: "sha256:input",
    contextDigest: "sha256:context",
    objective: "Implement approved plan",
    inputs: [],
    expectedOutputs: [],
    allowedPaths: ["src/**"],
    gates: ["test"],
    resultSchema: "builtin.stage-result.v1",
  },
  "builtin.stage-result.v1": {
    version: 1,
    workItemId: "WSK-20260816-001",
    stageId: "build",
    attemptId: "attempt-3",
    workflowDigest: "sha256:workflow",
    contextDigest: "sha256:context",
    baselineTreeDigest: "sha256:baseline",
    inputWorkspaceTreeDigest: "sha256:input",
    outputWorkspaceTreeDigest: "sha256:output",
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
    workItemId: "WSK-20260816-001",
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
      assert.equal(error.code, "WSPEC_SCHEMA_UNKNOWN_FIELD");
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
      assert.equal(error.code, "WSPEC_SCHEMA_REQUIRED_FIELD");
      assert.equal(error.path, "/contentHash");
      return true;
    },
  );
});

test("unsupported schema IDs fail closed", () => {
  assert.throws(
    () => getSchema("builtin.artifact.v2" as SchemaId),
    (error: unknown) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.code, "WSPEC_SCHEMA_UNSUPPORTED_VERSION");
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
