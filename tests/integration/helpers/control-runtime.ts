import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApplication, type ApplicationDependencies } from "../../../src/application/application.js";
import { createApplicationArtifact } from "../../../src/application/artifact.js";
import type { ExternalActionExecutor } from "../../../src/application/external-action.js";
import { sha256 } from "../../../src/domain/digests.js";
import { mutateControlPlane } from "../../../src/engine/scheduler.js";
import type { AgentAction, SubmitResult } from "../../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../../src/protocol/work-package.js";
import { createDefaultExecutorRegistry } from "../../../src/registry/executors/registry.js";
import { readControlPlane } from "../../../src/storage/control-plane.js";
import { materializeWorkItem } from "../../../src/storage/work-items.js";
import { defaultProjectConfig, initRepository } from "../../../src/storage/repository.js";
import { parse, stringify } from "yaml";
import { createGitRepository, git } from "./git.js";

export interface ControlRuntimeFixture {
  root: string;
  app: ReturnType<typeof createApplication>;
  now(): Date;
  restart(): void;
}

type TestFailureCode =
  | "WSSPEC_STEP_FAILED"
  | "WSSPEC_STEP_INPUT_INVALID"
  | "WSSPEC_STEP_CONFIGURATION_INVALID";

interface ControlRuntimeFixtureOptions {
  validatedFailureCode?: TestFailureCode;
  externalExecutor?: ExternalActionExecutor;
  knowledgeTarget?: boolean;
  now?: () => Date;
}

function executorContext(runtime: Awaited<ReturnType<typeof readControlPlane>>, stepId: string): WorkPackage {
  const context = runtime.contexts[stepId] as { workPackage?: WorkPackage } | undefined;
  assert.ok(context?.workPackage);
  return context.workPackage;
}

function runtimeExecutors(options: ControlRuntimeFixtureOptions) {
  return createDefaultExecutorRegistry().register({
    id: "command.execute/quality.verify",
    securityClass: "local-write",
    async acquire(step, runtime) {
      return { action: "execute", workPackage: executorContext(runtime, step.id) };
    },
    async validate(_step, result) {
      return result.status === "failed"
        ? { status: "failed", artifacts: result.artifacts, failureCode: options.validatedFailureCode ?? "WSSPEC_STEP_FAILED" }
        : { status: "completed", artifacts: result.artifacts };
    },
  });
}

export async function controlRuntimeFixture(options: ControlRuntimeFixtureOptions = {}): Promise<ControlRuntimeFixture> {
  const root = await createGitRepository();
  await initRepository(root);
  if (options.knowledgeTarget === true) {
    await writeFile(path.join(root, ".wsspec", "config.yaml"), stringify({
      ...defaultProjectConfig(),
      publishing: { targets: { knowledge: { provider: "feishu", document: "existingDocumentToken123" } } },
    }, { lineWidth: 0 }), "utf8");
  }
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "test: initialize control runtime");
  const now = options.now ?? (() => new Date("2026-08-18T04:00:00.000Z"));
  const dependencies = {
    provider: "codex",
    home: os.homedir(),
    terminal: { isTTY: true },
    now,
    executors: runtimeExecutors(options),
    ...(options.knowledgeTarget !== true ? {} : {
      connectorRuntime: {
        executables: {
          git: "/usr/bin/git",
          gh: "/usr/bin/gh",
          glab: "/usr/bin/glab",
          "lark-cli": await realpath(path.resolve(import.meta.dirname, "../../fixtures/bin/lark-cli")),
        },
        larkIdentity: "user" as const,
      },
    }),
    ...(options.externalExecutor === undefined ? {} : { externalExecutor: () => options.externalExecutor! }),
  } as ApplicationDependencies;
  const fixture: ControlRuntimeFixture = {
    root,
    app: createApplication(dependencies),
    now,
    restart() {
      fixture.app = createApplication({ ...dependencies, executors: runtimeExecutors(options) });
    },
  };
  return fixture;
}

export function requireExecute(action: AgentAction): WorkPackage {
  assert.equal(action.action, "execute");
  if (action.action !== "execute") throw new Error("expected execute action");
  return action.workPackage;
}

export function completedResult(workPackage: WorkPackage, artifacts?: ArtifactReference[]): SubmitResult {
  const resultArtifacts = artifacts ?? workPackage.requiredOutputs.map((output) => {
    if (output.artifactType !== "requirement-source") return output;
    const source = workPackage.artifacts.find((artifact) => artifact.artifactType === "requirement-source");
    assert.ok(source, "requirement-source output requires an authorized input Artifact");
    return source;
  });
  return {
    version: 1,
    status: "completed",
    summary: `${workPackage.stepId} 完成`,
    modifiedFiles: [],
    artifacts: resultArtifacts,
    commands: [],
    evidence: [],
    externalWrites: [],
    remainingRisks: [],
  };
}

export function failedResult(workPackage: WorkPackage): SubmitResult {
  return {
    ...completedResult(workPackage, []),
    status: "failed",
    summary: `${workPackage.stepId} 执行失败`,
  };
}

export async function submitPackage(
  fixture: ControlRuntimeFixture,
  workPackage: WorkPackage,
  result = completedResult(workPackage),
): Promise<AgentAction> {
  return fixture.app.submit({
    root: fixture.root,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    leaseToken: workPackage.lease.token,
    result,
  });
}

export async function authorArtifact(input: {
  fixture: ControlRuntimeFixture;
  worktree: string;
  workPackage: WorkPackage;
  artifactType: string;
  body: string;
  filename?: string;
  outputId?: string;
}): Promise<ArtifactReference> {
  const matches = input.workPackage.requiredOutputs.filter((output) => output.artifactType === input.artifactType
    && (input.outputId === undefined || output.outputId === input.outputId));
  assert.equal(matches.length, 1, "test Artifact author requires one exact Work Package output");
  const outputId = matches[0]!.outputId;
  assert.ok(outputId);
  const contentFile = `.wsspec/work-items/${input.workPackage.workItemId}/drafts/${input.filename ?? `${outputId}.md`}`;
  await mkdir(path.dirname(path.join(input.worktree, contentFile)), { recursive: true, mode: 0o700 });
  await writeFile(path.join(input.worktree, contentFile), input.body, { encoding: "utf8", mode: 0o600 });
  return createApplicationArtifact({
    root: input.worktree,
    workItemId: input.workPackage.workItemId,
    stepId: input.workPackage.stepId,
    attemptId: input.workPackage.attemptId,
    leaseToken: input.workPackage.lease.token,
    artifactType: input.artifactType,
    outputId,
    contentFile,
  }, { now: input.fixture.now });
}

export async function worktreeFor(root: string, workItemId: string): Promise<string> {
  const projection = await readControlPlane(root, workItemId);
  const workItemRoot = path.dirname(projection.controlPlane);
  const locator = JSON.parse(await readFile(path.join(workItemRoot, "locator.json"), "utf8")) as { worktree: string; materialized?: boolean };
  if (locator.materialized === false) {
    const item = parse(await readFile(path.join(workItemRoot, "authority", "work-item.yaml"), "utf8")) as import("../../../src/storage/work-items.js").WorkItem;
    await materializeWorkItem({ root, item });
  }
  return path.join(root, locator.worktree);
}

export async function rewriteSelectedSnapshot(
  fixture: ControlRuntimeFixture,
  workItemId: string,
  mutate: (profile: { order: string[]; steps: Array<Record<string, unknown>> }) => void,
): Promise<void> {
  const worktree = await worktreeFor(fixture.root, workItemId);
  const itemRoot = path.join(path.dirname((await readControlPlane(fixture.root, workItemId)).controlPlane), "authority");
  const applicationPath = path.join(itemRoot, "snapshot", "application.json");
  const manifestPath = path.join(itemRoot, "work-item.yaml");
  const snapshot = JSON.parse(await readFile(applicationPath, "utf8")) as {
    selectedProfile: string;
    profiles: Record<string, { order: string[]; steps: Array<Record<string, unknown>> }>;
  };
  mutate(snapshot.profiles[snapshot.selectedProfile]!);
  const applicationText = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(applicationPath, applicationText, "utf8");
  const manifest = await readFile(manifestPath, "utf8");
  const updatedManifest = manifest.replace(/workflowDigest: sha256:[a-f0-9]+/u, `workflowDigest: ${sha256(applicationText)}`);
  assert.notEqual(updatedManifest, manifest);
  await writeFile(manifestPath, updatedManifest, "utf8");
  const projection = await readControlPlane(fixture.root, workItemId);
  const anchorPath = path.join(projection.controlPlane, "application-anchor.json");
  const anchor = JSON.parse(await readFile(anchorPath, "utf8")) as Record<string, unknown>;
  anchor.manifestDigest = sha256(updatedManifest);
  await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`, "utf8");
}

export async function retainOnlyReadyStage(fixture: ControlRuntimeFixture, workItemId: string, stageId: string): Promise<void> {
  await mutateControlPlane({
    cwd: fixture.root,
    workItemId,
    eventType: "projection.invalidated",
    idempotencyKey: `test:retain:${stageId}`,
    operationInput: { stageId },
    mutate: (projection) => ({
      projection: {
        ...projection,
        stages: { [stageId]: { status: "ready" } },
        claims: {},
        contexts: {},
        approvals: {},
      },
      value: null,
    }),
  });
}

export async function writeReviewArtifact(input: {
  fixture: ControlRuntimeFixture;
  worktree: string;
  workPackage: WorkPackage;
  approved: boolean;
  filename: string;
}): Promise<ArtifactReference> {
  const findings = input.approved
    ? "findings: []"
    : [
        "findings:",
        "  - id: finding-1",
        "    severity: P1",
        "    description: 仍需修复",
        "    evidence: 聚焦测试失败",
        "    path: src/example.ts",
        "    disposition: open",
      ].join("\n");
  const body = `# Findings\n\n\`\`\`yaml\n${findings}\n\`\`\`\n`;
  return authorArtifact({
    fixture: input.fixture,
    worktree: input.worktree,
    workPackage: input.workPackage,
    artifactType: "review-result",
    body,
    filename: input.filename,
  });
}
