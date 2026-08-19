import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

import { createApplication } from "../../src/application/application.js";
import { initializeControlPlane, readControlPlane, recoverControlPlane } from "../../src/storage/control-plane.js";
import { sha256 } from "../../src/domain/digests.js";
import { ControlPlaneError, transitionRuntime } from "../../src/engine/scheduler.js";
import { captureRequirement, sourceArtifactReference } from "../../src/registry/connectors/requirement-source.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "./helpers/git.js";

const workflow = "version: 1\nactiveWorkflow: { ref: builtin://workflows/feature-delivery, version: 1 }\nprofile: standard\n";

const config = `version: 1
trigger:
  mode: suggest
git:
  worktrees:
    enabled: true
    root: .worktrees
    branchPrefix: wspec/
runtime:
  claimTtlSeconds: 1800
  maxStageRetries: 3
quality:
  gates:
    test:
      command: [npm, test]
      cwd: worktree
      timeoutSeconds: 900
      required: true
      evidence: trusted
`;

async function prepare(): Promise<{ root: string; worktree: string; workItemId: string }> {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "workflow.yaml"), workflow, "utf8");
  await writeFile(path.join(root, ".wsspec", "config.yaml"), config, "utf8");
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "chore: configure recovery fixture");
  const app = createApplication({ provider: "codex", terminal: { isTTY: true }, now: () => new Date("2026-08-16T04:00:00.000Z") });
  const started = await app.start({ root, source: { type: "prompt", text: "验证事件恢复" }, profile: "standard" });
  const projection = await readControlPlane(root, started.workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  return { root, worktree: path.join(root, locator.worktree), workItemId: started.workItemId };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as Error & { code: string }).code === code;
}

test("replays an appended event when projection persistence fails", async () => {
  const fixture = await prepare();
  await assert.rejects(
    transitionRuntime({
      cwd: fixture.root,
      workItemId: fixture.workItemId,
      scope: "work-item",
      to: "verifying",
      idempotencyKey: "activate-after-create",
      simulateProjectionFailure: true,
    }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === "WSSPEC_PROJECTION_WRITE_FAILED",
  );
  assert.equal((await readControlPlane(fixture.root, fixture.workItemId)).workItem.status, "active");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.workItem.status, "verifying");
  assert.equal(recovered.lastSequence, 2);
});

test("repeated idempotency keys return the original transition without another event", async () => {
  const fixture = await prepare();
  const input = {
    cwd: fixture.root,
    workItemId: fixture.workItemId,
    scope: "work-item" as const,
    to: "verifying" as const,
    idempotencyKey: "activate-once",
  };
  const first = await transitionRuntime(input);
  const second = await transitionRuntime(input);
  assert.deepEqual(second, first);
  assert.equal(second.lastSequence, 2);
});

test("idempotent retry after later events returns the original operation result", async () => {
  const fixture = await prepare();
  const activation = {
    cwd: fixture.root,
    workItemId: fixture.workItemId,
    scope: "work-item" as const,
    to: "verifying" as const,
    idempotencyKey: "activation-result",
  };
  const first = await transitionRuntime(activation);
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "intake", to: "running", idempotencyKey: "intake-running" });

  const retried = await transitionRuntime(activation);

  assert.deepEqual(retried, first);
  assert.equal((await readControlPlane(fixture.root, fixture.workItemId)).lastSequence, 3);
});

test("reusing an idempotency key with different input fails closed", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "shared-key" });

  await assert.rejects(
    transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verified", idempotencyKey: "shared-key" }),
    (error: unknown) => hasCode(error, "WSSPEC_IDEMPOTENCY_CONFLICT"),
  );
});

test("separate real worktrees share one locked control plane", async () => {
  const fixture = await prepare();
  const [fromRoot, fromWorktree] = await Promise.all([
    transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "shared-activation" }),
    transitionRuntime({ cwd: fixture.worktree, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "shared-activation" }),
  ]);
  assert.deepEqual(fromWorktree, fromRoot);
  assert.deepEqual(await readControlPlane(fixture.worktree, fixture.workItemId), fromRoot);
  assert.equal(fromRoot.lastSequence, 2);
});

test("recovery rejects a broken event hash chain", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "activate" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const eventLog = path.join(projection.controlPlane, "events.jsonl");
  const events = (await readFile(eventLog, "utf8")).replace('"to":"active"', '"to":"verified"');
  await writeFile(eventLog, events, "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_EVENT_CHAIN_INVALID"),
  );
});

test("recovery discards only an incomplete final event line", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "activate" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const eventLog = path.join(projection.controlPlane, "events.jsonl");
  await writeFile(eventLog, `${await readFile(eventLog, "utf8")}{\"eventId\":\"partial`, "utf8");
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });

  assert.equal(recovered.workItem.status, "verifying");
  assert.equal(recovered.lastSequence, 2);
  assert.match(await readFile(eventLog, "utf8"), /\n$/);
});

test("recovery rejects a valid event prefix truncated behind the durable projection", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "activate" });
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verified", idempotencyKey: "verify" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const eventLog = path.join(projection.controlPlane, "events.jsonl");
  const [first] = (await readFile(eventLog, "utf8")).trimEnd().split("\n");
  await writeFile(eventLog, `${first}\n`, "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_EVENT_CHAIN_INVALID"),
  );
});

test("recovery rejects repository identity mismatch", async () => {
  const fixture = await prepare();
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const runtimePath = path.join(projection.controlPlane, "runtime.json");
  await writeFile(runtimePath, `${JSON.stringify({ ...projection, repositoryId: "repo-00000000000000000000000000" }, null, 2)}\n`, "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_REPOSITORY_ID_MISMATCH"),
  );
});

test("recovery cancels an unfinished approval state instead of inheriting it", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "intake", to: "running", idempotencyKey: "run" });
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "intake", to: "validating", idempotencyKey: "validate" });
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "stage", stageId: "intake", to: "awaiting_approval", idempotencyKey: "approval" });

  const recovered = await recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId });
  assert.equal(recovered.workItem.status, "active");
  assert.equal(recovered.stages.intake?.status, "ready");
  assert.ok(recovered.lastSequence > 4);
});

test("recovery rebuilds a damaged projection from immutable metadata and the complete event chain", async () => {
  const fixture = await prepare();
  await transitionRuntime({ cwd: fixture.root, workItemId: fixture.workItemId, scope: "work-item", to: "verifying", idempotencyKey: "activate" });
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: fixture.worktree, workItemId: fixture.workItemId });
  assert.equal(recovered.workItem.status, "verifying");
  assert.equal(recovered.lastSequence, 2);
});

test("recovery rejects legacy Source manifests without an Application anchor and source event", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "workflow.yaml"), workflow, "utf8");
  await writeFile(path.join(root, ".wsspec", "config.yaml"), config, "utf8");
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "chore: configure legacy recovery fixture");
  const workItemId = "WSS-20260816-LEGACY";
  await createWorkItem({ root, workItemId, title: "旧来源", source: { type: "prompt", content: "旧格式" } });
  await initializeControlPlane({ cwd: root, workItemId, stages: ["define"] });

  await assert.rejects(
    recoverControlPlane({ cwd: root, workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_SNAPSHOT_CHANGED"),
  );
});

test("recovery rejects a Source reference that differs from the trusted source.captured event", async () => {
  const fixture = await prepare();
  const itemRoot = path.join(fixture.worktree, ".wsspec", "work-items", fixture.workItemId);
  const manifestPath = path.join(itemRoot, "work-item.yaml");
  const applicationPath = path.join(itemRoot, "snapshot", "application.json");
  const replacement = await captureRequirement({
    repositoryRoot: fixture.root,
    artifactRoot: fixture.worktree,
    workItemId: fixture.workItemId,
    source: { type: "user.prompt", text: "attacker-selected" },
  });
  const replacementReference = sourceArtifactReference(fixture.workItemId, replacement);
  const application = JSON.parse(await readFile(applicationPath, "utf8")) as Record<string, unknown>;
  application.source = replacementReference;
  const applicationText = `${JSON.stringify(application, null, 2)}\n`;
  await writeFile(applicationPath, applicationText, "utf8");
  const manifest = parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & {
    execution: Record<string, unknown>;
    source: Record<string, unknown>;
  };
  manifest.execution.workflowDigest = sha256(applicationText);
  manifest.source = {
    ...manifest.source,
    type: replacement.type,
    artifactId: replacement.artifactId,
    snapshot: path.posix.relative(`.wsspec/work-items/${fixture.workItemId}`, replacementReference.path),
    contentDigest: replacement.contentDigest,
    artifactDigest: replacementReference.contentHash,
  };
  const manifestText = stringify(manifest, { lineWidth: 0 });
  await writeFile(manifestPath, manifestText, "utf8");
  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const anchorPath = path.join(projection.controlPlane, "application-anchor.json");
  const anchor = JSON.parse(await readFile(anchorPath, "utf8")) as Record<string, unknown>;
  anchor.manifestDigest = sha256(manifestText);
  await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`, "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_SNAPSHOT_CHANGED"),
  );
});

test("recovery rejects a changed or schema-invalid requirement SourceArtifact", async () => {
  const fixture = await prepare();
  const manifest = parse(await readFile(path.join(fixture.worktree, ".wsspec", "work-items", fixture.workItemId, "work-item.yaml"), "utf8")) as {
    source: { snapshot: string };
  };
  const sourcePath = path.join(fixture.worktree, ".wsspec", "work-items", fixture.workItemId, manifest.source.snapshot);
  await writeFile(sourcePath, "{}\n", "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_SNAPSHOT_CHANGED"),
  );
});

test("recovery authenticates the Work Item manifest before following its Source Artifact reference", async () => {
  const fixture = await prepare();
  const manifestPath = path.join(fixture.worktree, ".wsspec", "work-items", fixture.workItemId, "work-item.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifest.replace(/snapshot: source\/[a-f0-9]{64}\.json/u, `snapshot: source/${"f".repeat(64)}.json`),
    "utf8",
  );

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_WORK_ITEM_MANIFEST_CHANGED"),
  );
});

test("recovery authenticates Application before touching a missing Source Artifact", async () => {
  const fixture = await prepare();
  const itemRoot = path.join(fixture.worktree, ".wsspec", "work-items", fixture.workItemId);
  const manifest = parse(await readFile(path.join(itemRoot, "work-item.yaml"), "utf8")) as {
    source: { snapshot: string };
  };
  const applicationPath = path.join(itemRoot, "snapshot", "application.json");
  await writeFile(applicationPath, `${await readFile(applicationPath, "utf8")} `, "utf8");
  await unlink(path.join(itemRoot, manifest.source.snapshot));

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_APPLICATION_SNAPSHOT_CHANGED"),
  );
});

test("recovery authenticates Application before interpreting an anchored malicious Source path", async () => {
  const fixture = await prepare();
  const itemRoot = path.join(fixture.worktree, ".wsspec", "work-items", fixture.workItemId);
  const manifestPath = path.join(itemRoot, "work-item.yaml");
  const applicationPath = path.join(itemRoot, "snapshot", "application.json");
  const manifest = parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & {
    source: Record<string, unknown>;
  };
  manifest.source.snapshot = `source/${"f".repeat(64)}.json`;
  const manifestText = stringify(manifest, { lineWidth: 0 });
  await writeFile(manifestPath, manifestText, "utf8");
  await writeFile(applicationPath, `${await readFile(applicationPath, "utf8")} `, "utf8");

  const projection = await readControlPlane(fixture.root, fixture.workItemId);
  const anchorPath = path.join(projection.controlPlane, "application-anchor.json");
  const anchor = JSON.parse(await readFile(anchorPath, "utf8")) as Record<string, unknown>;
  anchor.manifestDigest = sha256(manifestText);
  await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`, "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: fixture.root, workItemId: fixture.workItemId }),
    (error: unknown) => hasCode(error, "WSSPEC_APPLICATION_SNAPSHOT_CHANGED"),
  );
});
