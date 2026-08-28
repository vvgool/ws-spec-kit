import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplication } from "../../src/application/application.js";
import { sha256 } from "../../src/domain/digests.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { readControlPlane, recoverControlPlane, writeProjection } from "../../src/storage/control-plane.js";
import { readEvents } from "../../src/storage/events.js";
import { initRepository } from "../../src/storage/repository.js";
import { createGitRepository, git } from "./helpers/git.js";

test("条件为 false 时原子写入 step.skipped 并可从事件回放", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "test: initialize conditional workflow");
  const app = createApplication({ provider: "codex", home: os.homedir(), terminal: { isTTY: true }, now: () => new Date("2026-08-18T00:00:00.000Z") });
  const started = await app.start({ root, source: { type: "prompt", text: "条件跳过" }, profile: "standard" });
  const initial = await readControlPlane(root, started.workItemId);
  const itemRoot = path.join(path.dirname(initial.controlPlane), "authority");
  const applicationPath = path.join(itemRoot, "snapshot", "application.json");
  const snapshot = JSON.parse(await readFile(applicationPath, "utf8")) as { profiles: { standard: { steps: Array<{ id: string; when?: string }> } } };
  snapshot.profiles.standard.steps.find(({ id }) => id === "intake")!.when = "false";
  const applicationText = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(applicationPath, applicationText, "utf8");
  const manifestPath = path.join(itemRoot, "work-item.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  const updatedManifest = manifest.replace(/workflowDigest: sha256:[a-f0-9]+/u, `workflowDigest: ${sha256(applicationText)}`);
  await writeFile(manifestPath, updatedManifest, "utf8");
  const anchorPath = path.join(initial.controlPlane, "application-anchor.json");
  const anchor = JSON.parse(await readFile(anchorPath, "utf8")) as Record<string, unknown>;
  anchor.manifestDigest = sha256(updatedManifest);
  await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`, "utf8");
  await writeProjection({ ...initial, stages: { ...initial.stages, intake: { status: "pending" } } });

  const action = await app.acquire({ root, workItemId: started.workItemId, actor: "codex" });

  assert.equal(action.action, "execute");
  assert.equal(action.action === "execute" ? action.workPackage.stepId : undefined, "explore");
  const events = await readEvents(initial.controlPlane);
  assert.equal(events.at(-1)?.eventType, "step.skipped");
  assert.equal(events.at(-1)?.stageId, "intake");
  assert.equal((events.at(-1)?.result as { skippedStepIds?: string[] }).skippedStepIds?.[0], "intake");
  await writeFile(path.join(initial.controlPlane, "runtime.json"), "not-json\n", "utf8");
  const recovered = await recoverControlPlane({ cwd: root, workItemId: started.workItemId });
  assert.equal(recovered.stages.intake?.status, "skipped");
});

test("Source 捕获与投影失效事件恢复后条件根 Step 仍在 acquire 时跳过", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "test: initialize zero-event recovery workflow");
  const app = createApplication({ provider: "codex", home: os.homedir(), terminal: { isTTY: true }, now: () => new Date("2026-08-18T00:00:00.000Z") });
  const started = await app.start({ root, source: { type: "prompt", text: "零事件条件恢复" }, profile: "standard" });
  const initial = await readControlPlane(root, started.workItemId);
  const itemRoot = path.join(path.dirname(initial.controlPlane), "authority");
  const applicationPath = path.join(itemRoot, "snapshot", "application.json");
  const snapshot = JSON.parse(await readFile(applicationPath, "utf8")) as { profiles: { standard: { steps: Array<{ id: string; when?: string }> } } };
  snapshot.profiles.standard.steps.find(({ id }) => id === "intake")!.when = "false";
  const applicationText = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(applicationPath, applicationText, "utf8");
  const manifestPath = path.join(itemRoot, "work-item.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  const updatedManifest = manifest.replace(/workflowDigest: sha256:[a-f0-9]+/u, `workflowDigest: ${sha256(applicationText)}`);
  await writeFile(manifestPath, updatedManifest, "utf8");
  const anchorPath = path.join(initial.controlPlane, "application-anchor.json");
  const anchor = JSON.parse(await readFile(anchorPath, "utf8")) as Record<string, unknown>;
  anchor.manifestDigest = sha256(updatedManifest);
  await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`, "utf8");
  await mutateControlPlane({
    cwd: root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: "test:conditional-snapshot-invalidated",
    operationInput: { stageId: "intake" },
    mutate: (current) => ({
      projection: { ...current, stages: { ...current.stages, intake: { status: "pending" } } },
      value: { stageId: "intake" },
    }),
  });
  await writeFile(path.join(initial.controlPlane, "runtime.json"), "not-json\n", "utf8");

  const recovered = await recoverControlPlane({ cwd: root, workItemId: started.workItemId });
  const action = await app.acquire({ root, workItemId: started.workItemId, actor: "codex" });

  assert.equal(recovered.stages.intake?.status, "pending");
  assert.equal(recovered.lastSequence, 2);
  assert.equal(action.action, "execute");
  assert.equal(action.action === "execute" ? action.workPackage.stepId : undefined, "explore");
  const events = await readEvents(initial.controlPlane);
  assert.equal(events[0]?.eventType, "source.captured");
  assert.equal(events.at(-1)?.eventType, "step.skipped");
});
