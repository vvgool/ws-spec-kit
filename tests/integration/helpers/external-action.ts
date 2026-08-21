import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  prepareExternalAction,
  type ExternalActionExecutor,
  type ExternalActionPrepareInput,
} from "../../../src/application/external-action.js";
import { computeArtifactContentHash } from "../../../src/domain/artifacts.js";
import { sha256 } from "../../../src/domain/digests.js";
import { createExternalBinding } from "../../../src/domain/external-receipt.js";
import { mutateControlPlane } from "../../../src/engine/scheduler.js";
import { canonicalDigest } from "../../../src/engine/external-effects/idempotency.js";
import type { SubmitResult } from "../../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../../src/protocol/work-package.js";
import { controlRuntimeFixture, requireExecute, retainOnlyReadyStage, rewriteSelectedSnapshot, worktreeFor } from "./control-runtime.js";
import { git } from "./git.js";

export const digest = (value: string): `sha256:${string}` => sha256(value) as `sha256:${string}`;

export async function externalActionFixture() {
  const fixture = await controlRuntimeFixture();
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "外部动作测试" }, profile: "standard" });
  const workPackage = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  return { ...fixture, workItemId: started.workItemId, workPackage };
}

export function prepareInput(
  root: string,
  workPackage: WorkPackage,
  overrides: Partial<ExternalActionPrepareInput> = {},
): ExternalActionPrepareInput {
  return {
    root,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    provider: "github",
    action: "issue.update",
    securityClass: "external-write",
    target: { kind: "issue", stableId: "github:example/project#42" },
    payload: { body: "approved release summary" },
    expectedContentDigest: canonicalDigest({ body: "approved release summary" }),
    bindingDigest: digest("b"),
    inputDigest: digest("i"),
    artifactDigests: [digest("a")],
    sideEffects: ["更新 Issue 正文"],
    createdAt: "2026-08-18T04:00:00.000Z",
    expiresAt: "2026-08-18T04:30:00.000Z",
    actor: "codex",
    ...overrides,
  };
}

export async function preparedAction() {
  const fixture = await externalActionFixture();
  const input = prepareInput(fixture.root, fixture.workPackage);
  const prepared = await prepareExternalAction(input);
  assert.equal(prepared.status, "prepared");
  return { ...fixture, input, prepared };
}

export async function applicationExternalActionFixture(
  executor: ExternalActionExecutor,
  options: { action?: "issue.update" | "knowledge.publish"; profile?: "standard" | "governed"; now?: () => Date } = {},
) {
  const profile = options.profile ?? "governed";
  const action = options.action ?? "issue.update";
  const stepId = action === "knowledge.publish" ? "update-wiki" : "update-issue";
  const targetKind = action === "knowledge.publish" ? "knowledge" : "issue";
  const provider = action === "knowledge.publish" ? "feishu" : "github";
  const stableId = action === "knowledge.publish" ? "feishu:existingDocumentToken123" : "github:example/project#42";
  const fixture = await controlRuntimeFixture({
    externalExecutor: executor,
    knowledgeTarget: profile === "governed",
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "应用协议外部动作测试" }, profile });
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    profile.order = [stepId];
    profile.steps = [{
      id: stepId,
      uses: "connector.execute",
      action,
      securityClass: "external-write",
      needs: [],
      enabled: true,
      skills: [],
      inputs: [
        { artifact: "requirement-source", required: true },
        ...(action === "knowledge.publish" ? [{ artifact: "knowledge-entry", required: false }] : []),
      ],
      outputs: [],
      gates: [],
      approval: false,
      authorizationRequired: true,
      steps: [],
    }];
  });
  await retainOnlyReadyStage(fixture, started.workItemId, stepId);
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId: started.workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: `test:external-binding:${targetKind}`,
    operationInput: { target: targetKind },
    mutate: (projection) => ({
      projection: {
        ...projection,
        evidence: {
          ...projection.evidence,
          bindings: {
            [targetKind]: { exists: true, stableId, externalWorkItemId: started.workItemId },
          },
        },
      },
      value: null,
    }),
  });
  let workPackage = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  let knowledgePayload: Record<string, unknown> | undefined;
  if (action === "knowledge.publish") {
    const body = "# Approved release summary\n\nFixture knowledge content.\n";
    const metadata = {
      artifactType: "knowledge-entry",
      schemaVersion: 1 as const,
      workItemId: started.workItemId,
      stageId: workPackage.stepId,
      attemptId: workPackage.attemptId,
      revision: 1,
    };
    const contentHash = computeArtifactContentHash(metadata, body);
    const reference: ArtifactReference = {
      artifactType: metadata.artifactType,
      schemaVersion: 1,
      path: `.wsspec/work-items/${started.workItemId}/artifacts/knowledge-entry.md`,
      revision: metadata.revision,
      contentHash,
      mediaType: "text/markdown",
    };
    const worktree = await worktreeFor(fixture.root, started.workItemId);
    await mkdir(path.dirname(path.join(worktree, reference.path!)), { recursive: true });
    await writeFile(path.join(worktree, reference.path!), [
      "---",
      `artifactType: ${metadata.artifactType}`,
      `schemaVersion: ${metadata.schemaVersion}`,
      `workItemId: ${metadata.workItemId}`,
      `stageId: ${metadata.stageId}`,
      `attemptId: ${metadata.attemptId}`,
      `revision: ${metadata.revision}`,
      `contentHash: ${contentHash}`,
      "---",
      body,
    ].join("\n"), "utf8");
    workPackage = await mutateControlPlane({
      cwd: fixture.root,
      workItemId: started.workItemId,
      eventType: "projection.invalidated",
      idempotencyKey: `test:publication-artifact:${workPackage.attemptId}`,
      operationInput: { stepId, attemptId: workPackage.attemptId, contentHash },
      mutate: (projection) => {
        const context = projection.contexts[stepId] as { workPackage?: WorkPackage } | undefined;
        assert.ok(context?.workPackage);
        const updated = { ...context.workPackage, artifacts: [...context.workPackage.artifacts, reference] };
        return {
          projection: {
            ...projection,
            contexts: { ...projection.contexts, [stepId]: { ...context, workPackage: updated } },
          },
          value: updated,
        };
      },
    });
    const binding = createExternalBinding({
      target: "knowledge",
      workPackage,
      discoveryBinding: { exists: true, stableId, externalWorkItemId: started.workItemId },
      expectedPublishedContentDigest: sha256(body),
    });
    knowledgePayload = {
      target: { documentToken: "existingDocumentToken123", title: "Approved release summary", markdown: body },
      binding,
    };
  }
  const result: SubmitResult = {
    version: 1,
    status: "completed",
    summary: "update issue",
    modifiedFiles: [],
    artifacts: [],
    commands: [],
    evidence: [],
    externalWrites: [{
      kind: "external-action",
      provider,
      action,
      target: { kind: targetKind, stableId },
      payload: knowledgePayload ?? {
        target: { host: "github.example.com", owner: "example", repo: "project", number: 42 },
        action: { type: "body", body: "approved release summary" },
        authorization: "fixture-secret",
      },
      sideEffects: [action === "knowledge.publish" ? "发布知识文档" : "更新 Issue 正文"],
    }],
    remainingRisks: [],
  };
  return { ...fixture, workItemId: started.workItemId, workPackage, result };
}

export async function applicationGitActionFixture(executor: ExternalActionExecutor) {
  const fixture = await controlRuntimeFixture({ externalExecutor: executor });
  const started = await fixture.app.start({ root: fixture.root, source: { type: "prompt", text: "应用协议 Git 动作测试" }, profile: "standard" });
  const stepId = "commit";
  await rewriteSelectedSnapshot(fixture, started.workItemId, (profile) => {
    profile.order = [stepId];
    profile.steps = [{
      id: stepId,
      uses: "connector.execute",
      action: "git.commit",
      securityClass: "local-write",
      needs: [],
      enabled: true,
      skills: [],
      inputs: [{ artifact: "requirement-source", required: true }],
      outputs: [],
      gates: [],
      approval: false,
      authorizationRequired: true,
      steps: [],
    }];
  });
  await retainOnlyReadyStage(fixture, started.workItemId, stepId);
  const workPackage = requireExecute(await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "codex" }));
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  await writeFile(path.join(worktree, "README.md"), "approved git content\n", "utf8");
  const baselineRevision = await git(worktree, "rev-parse", "HEAD");
  const repositoryCommonDir = await realpath(await git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const approval = {
    repositoryRoot: await realpath(worktree),
    repositoryCommonDir,
    baselineRevision,
    files: ["README.md"],
    message: "test: approve application git action",
    diffDigest: sha256(await git(
      worktree,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      baselineRevision,
      "--",
      "README.md",
    )),
  };
  const result: SubmitResult = {
    version: 1,
    status: "completed",
    summary: "commit approved files",
    modifiedFiles: ["README.md"],
    artifacts: [],
    commands: [],
    evidence: [],
    externalWrites: [{
      kind: "external-action",
      provider: "git-native",
      action: "git.commit",
      target: { kind: "repository", stableId: repositoryCommonDir },
      payload: approval,
      sideEffects: ["提交批准文件并移动当前 Work Item worktree HEAD"],
    }],
    remainingRisks: [],
  };
  return { ...fixture, workItemId: started.workItemId, workPackage, worktree, result };
}

export async function submitExternalAction(
  fixture: Awaited<ReturnType<typeof applicationExternalActionFixture>>,
  result: SubmitResult = fixture.result,
) {
  return fixture.app.submit({
    root: fixture.root,
    workItemId: fixture.workItemId,
    stepId: fixture.workPackage.stepId,
    attemptId: fixture.workPackage.attemptId,
    leaseToken: fixture.workPackage.lease.token,
    result,
  });
}
