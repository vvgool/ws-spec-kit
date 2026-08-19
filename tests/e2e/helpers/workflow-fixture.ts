import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApplication, type ApplicationDependencies } from "../../../src/application/application.js";
import { loadApplicationState } from "../../../src/application/state.js";
import { runWorkflowCommand } from "../../../src/adapters/cli/workflow.js";
import { computeArtifactContentHash } from "../../../src/domain/artifacts.js";
import { computeWorkspaceTreeDigest } from "../../../src/domain/digests.js";
import { checkDocumentationIntegrity } from "../../../src/engine/docs-integrity.js";
import { parseTrustedEvidence } from "../../../src/engine/tdd/red-gate.js";
import { evidenceProjectionKey, evidenceRecordHash } from "../../../src/engine/verification.js";
import type { AgentAction, StartResult, SubmitResult } from "../../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../../src/protocol/work-package.js";
import { ExecutorRegistry, type StepExecutor } from "../../../src/registry/executors/registry.js";
import type { ExternalActionExecutor } from "../../../src/application/external-action.js";
import { readControlPlane, type RuntimeProjection } from "../../../src/storage/control-plane.js";
import { readEvents, type StoredEvent } from "../../../src/storage/events.js";
import { initRepository } from "../../../src/storage/repository.js";
import { createGitRepository, git } from "../../integration/helpers/git.js";

type App = ReturnType<typeof createApplication>;
type ProfileId = "quick" | "standard" | "governed";

export interface WorkflowFixture {
  root: string;
  externalRoot: string;
  app: App;
  recovery: {
    intakeAttemptsUsed?: number;
    loopStep?: string;
    loopAttemptsUsed?: number;
    upgradeStep?: string;
    upgradeAttemptsUsed?: number;
    governedStep?: string;
    governedAttemptChanged?: boolean;
    governedAttemptsUsed?: number;
    governedLoopMaxIterations?: number;
    governedProfile?: string;
    governedApprovalCount?: number;
  };
  acquire(workItemId: StartResult["workItemId"], actor: string): Promise<WorkPackage>;
  advance(seconds: number): void;
  restart(): void;
}

interface FeatureOptions {
  first: WorkPackage;
  implementationActor: string;
  reviewActors: string[];
  reviewApprovals: boolean[];
  interruptAfterLoopSubmit?: boolean;
  externalTargets?: boolean;
  upgradeAtStep?: string;
  interruptAfterProfileUpgrade?: boolean;
  interruptAfterApprovalStep?: string;
  addIgnoredTestAssetDuringFix?: boolean;
  tamperPublishArtifactAtStep?: "update-issue" | "update-wiki";
}

interface FeatureArtifacts {
  specification: ArtifactReference;
  design?: ArtifactReference;
  tasks: ArtifactReference;
}

export interface FeatureWorkflowResult {
  snapshot: {
    profiles: Record<ProfileId, { order: string[]; audit: { level: string; retention?: string } }>;
  };
  projection: RuntimeProjection;
  recovered: RuntimeProjection;
  events: StoredEvent[];
  artifacts: FeatureArtifacts;
  recoveryEvidence: WorkflowFixture["recovery"];
}

interface DocumentationOptions {
  first: WorkPackage;
  actor: string;
  interruptAfterLoopSubmit?: boolean;
}

export interface DocumentationWorkflowResult {
  projection: RuntimeProjection;
  recovered: RuntimeProjection;
  scopeViolations: Record<"production" | "script" | "dependency" | "build", string>;
  workflowAfterProjectSwitch: string;
  recoveryEvidence: WorkflowFixture["recovery"];
}

function attemptPackage(runtime: RuntimeProjection, stageId: string): WorkPackage {
  const context = runtime.contexts[stageId] as { workPackage?: WorkPackage } | undefined;
  assert.ok(context?.workPackage);
  return context.workPackage;
}

function attemptsUsed(runtime: RuntimeProjection, stepId: string): number {
  const attempts = runtime.retries[stepId]?.attemptsUsed;
  if (attempts === undefined) throw new Error(`missing retry evidence for ${stepId}`);
  return attempts;
}

function executor(
  id: string,
  securityClass: StepExecutor["securityClass"],
  validateHook?: (result: SubmitResult, runtime: RuntimeProjection) => Promise<void>,
): StepExecutor {
  return {
    id,
    securityClass,
    async acquire(step, runtime) {
      return { action: "execute", workPackage: attemptPackage(runtime, step.id) };
    },
    async validate(_step, result, runtime) {
      await validateHook?.(result, runtime);
      return result.status === "failed"
        ? { status: "failed", artifacts: result.artifacts, failureCode: "WSSPEC_STEP_FAILED" }
        : { status: "completed", artifacts: result.artifacts };
    },
  };
}

function fixtureExecutors(input: { root: string; externalTargets: boolean; documentation: boolean }): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  for (const [id, securityClass] of [
    ["agent.execute", "agent"],
    ["connector.execute/requirement.capture", "external-read"],
    ["command.execute/quality.test", "local-write"],
    ["command.execute/quality.verify", "local-write"],
    ["connector.execute/git.commit", "local-write"],
    ["connector.execute/issue.update", "external-write"],
    ["connector.execute/knowledge.publish", "external-write"],
    ["connector.execute/issue.close", "external-write"],
    ["command.execute/quality.docs.integrity", "local-read"],
    ["control.loop", "control"],
    ["control.close", "control"],
  ] as const) {
    if (id === "command.execute/quality.docs.integrity" && input.documentation) {
      registry.register(documentationExecutor(input.root));
      continue;
    }
    registry.register(executor(id, securityClass, async (_result, runtime) => {
      if (id === "connector.execute/requirement.capture" && input.externalTargets) {
        runtime.evidence = {
          ...runtime.evidence,
          bindings: {
            issue: { exists: true, stableId: "local:issue", externalWorkItemId: runtime.workItemId },
            knowledge: { exists: true, stableId: "local:knowledge", externalWorkItemId: runtime.workItemId },
          },
        };
      }
    }));
  }
  return registry;
}

function fixtureExternalExecutor(externalRoot: string, now: () => Date): ExternalActionExecutor {
  const recordFor = (request: Parameters<ExternalActionExecutor["execute"]>[0]["request"], grantDigest: string) => ({
    workItemId: request.workItemId,
    target: request.target.kind,
    stableId: request.target.stableId,
    status: "confirmed",
    action: request.action,
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    grantDigest,
    attemptId: request.attemptId,
    payloadDigest: request.payloadDigest,
    bindingDigest: request.bindingDigest,
    inputDigest: request.inputDigest,
    artifactDigests: request.artifactDigests,
  });
  return {
    async execute({ request, grant, markDispatched }) {
      await markDispatched();
      const expected = recordFor(request, grant.grantDigest);
      const targetPath = path.join(externalRoot, `${request.target.kind}.json`);
      await writeFile(targetPath, `${JSON.stringify(expected, null, 2)}\n`, "utf8");
      const stored = JSON.parse(await readFile(targetPath, "utf8")) as unknown;
      assert.deepEqual(stored, expected);
      return {
        targetStableId: request.target.stableId,
        contentDigest: request.payloadDigest,
        verifiedAt: now().toISOString(),
      };
    },
    async reconcile({ request, grant }) {
      try {
        const stored = JSON.parse(await readFile(path.join(externalRoot, `${request.target.kind}.json`), "utf8")) as unknown;
        if (JSON.stringify(stored) !== JSON.stringify(recordFor(request, grant.grantDigest))) {
          return { outcome: "failed", checkedAt: now().toISOString(), reason: "local fixture read-back mismatch" };
        }
        return {
          outcome: "verified",
          targetStableId: request.target.stableId,
          contentDigest: request.payloadDigest,
          checkedAt: now().toISOString(),
        };
      } catch {
        return { outcome: "unknown", checkedAt: now().toISOString(), reason: "local fixture unavailable" };
      }
    },
  };
}

function projectConfig(documentation: boolean): Record<string, unknown> {
  const gate = {
    test: {
      command: [process.execPath, "--test", "tests/workflow-feature.test.mjs"],
      cwd: "worktree",
      timeoutSeconds: 5,
      required: true,
      evidence: "trusted",
      inheritEnv: [],
      env: {},
      reporter: { type: "node-test", version: 1 },
    },
  };
  return {
    version: 1,
    testing: { pathRules: ["node", "java", "ruby", "dotnet"], testAssetPaths: ["tests/**"], productPaths: ["src/**"] },
    ...(documentation ? {} : { quality: { gates: gate } }),
    ...(documentation ? { documentation: { allowedPaths: ["README*.md", "CHANGELOG*.md", "docs/**/*.md", "docs/**/*.mdx", "docs/**/*.txt"] } } : {}),
  };
}

function documentationExecutor(root: string): StepExecutor {
  return {
    id: "command.execute/quality.docs.integrity",
    securityClass: "local-read",
    async acquire(step, runtime) {
      return { action: "execute", workPackage: attemptPackage(runtime, step.id) };
    },
    async validate(step, result, runtime) {
      if (result.status === "failed") return { status: "failed", artifacts: result.artifacts, failureCode: "WSSPEC_STEP_FAILED" };
      const state = await loadApplicationState(root, runtime.workItemId);
      const edited = runtime.contexts["edit-document"] as { result?: { modifiedFiles?: string[] } } | undefined;
      const files = edited?.result?.modifiedFiles ?? [];
      const checked = await checkDocumentationIntegrity({ root: state.worktree, files, allowedPaths: state.snapshot.changePolicy.allowedPaths });
      if (!checked.ok) throw new Error(`documentation integrity failed: ${JSON.stringify(checked.problems)}`);
      const pkg = attemptPackage(runtime, step.id);
      const unsigned = {
        evidenceId: `evidence-docs-${pkg.attemptId}`,
        level: "trusted" as const,
        gateId: "docs.integrity",
        codeRevision: await git(state.worktree, "rev-parse", "HEAD"),
        baselineTreeDigest: state.item.execution.baselineTreeDigest,
        workspaceTreeDigest: await computeWorkspaceTreeDigest(state.worktree),
        configDigest: state.item.execution.configDigest,
        attemptId: pkg.attemptId,
        result: "passed" as const,
      };
      runtime.evidence = {
        ...runtime.evidence,
        [evidenceProjectionKey(pkg.stepId, "docs.integrity")]: { ...unsigned, recordHash: evidenceRecordHash(unsigned) },
      };
      return { status: "completed", artifacts: result.artifacts };
    },
  };
}

export async function createWorkflowFixture(options: { externalTargets?: boolean; documentation?: boolean } = {}): Promise<WorkflowFixture> {
  const root = await createGitRepository();
  const externalRoot = path.join(os.tmpdir(), `wspec-external-${crypto.randomUUID()}`);
  await mkdir(externalRoot, { recursive: true });
  await initRepository(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "feature.mjs"), "export const value = 0;\n", "utf8");
  await writeFile(path.join(root, "package.json"), "{\"name\":\"fixture\",\"version\":\"1.0.0\"}\n", "utf8");
  await writeFile(path.join(root, "tsconfig.json"), "{\"compilerOptions\":{\"strict\":true}}\n", "utf8");
  await writeFile(path.join(root, ".wsspec", "config.yaml"), `${JSON.stringify(projectConfig(options.documentation === true), null, 2)}\n`, "utf8");
  const ignored = await readFile(path.join(root, ".gitignore"), "utf8");
  await writeFile(path.join(root, ".gitignore"), `${ignored}tests/ignored-late.json\n`, "utf8");
  await git(root, "add", ".wsspec", "src/feature.mjs", "package.json", "tsconfig.json", ".gitignore");
  await git(root, "commit", "-m", "test: seed local workflow fixture");

  let now = Date.parse("2020-01-01T00:00:00.000Z");
  const dependencies = (): ApplicationDependencies => ({
    provider: "codex",
    home: os.homedir(),
    terminal: { isTTY: true },
    now: () => new Date(now),
    executors: fixtureExecutors({ root, externalTargets: options.externalTargets === true, documentation: options.documentation === true }),
    externalExecutor: () => fixtureExternalExecutor(externalRoot, () => new Date(now)),
  });
  const fixture: WorkflowFixture = {
    root,
    externalRoot,
    app: createApplication(dependencies()),
    recovery: {},
    acquire: async (workItemId, actor) => requireExecute(await fixture.app.acquire({ root, workItemId, actor })),
    advance(seconds) { now += seconds * 1_000; },
    restart() { fixture.app = createApplication(dependencies()); },
  };
  return fixture;
}

function requireExecute(action: AgentAction): WorkPackage {
  const actionName = action.action;
  if (actionName !== "execute") {
    const details = actionName === "blocked" ? `: ${action.problems.map(({ code }) => code).join(",")}` : "";
    throw new Error(`expected execute, received ${actionName}${details}`);
  }
  return action.workPackage;
}

function bodyFor(type: string, approved = true): string {
  if (type === "specification") return [
    "# 目标与背景", "本地 fixture 功能交付。", "# 范围", "仅修改 fixture。", "# 需求", "value 应为 1。",
    "# 验收条件", "固定测试通过。", "# 约束", "不得访问网络。", "# 排除项", "无。", "# 开放问题", "无。", "",
  ].join("\n");
  if (type === "design") return [
    "# 上下文与架构", "单文件 fixture。", "# 组件职责和边界", "测试与实现分离。", "# 接口与数据契约", "导出 value。",
    "# 安全与权限", "仅本地文件。", "# 失败与恢复", "事件链恢复。", "# 兼容或迁移", "无需迁移。", "# 测试策略", "node:test。", "# 已知权衡", "仅证明本地合同。", "",
  ].join("\n");
  if (type === "tasks") return "# 任务\n\n```yaml\ntasks:\n  - id: task-1\n    status: pending\n    dependencies: []\n    completion: 固定测试由 Red 转 Green\n```\n";
  if (type === "implementation-result") return [
    "# 实际改动", "value 更新为 1。", "# 修改文件", "src/feature.mjs。", "# 计划偏差", "无。", "# 验证摘要", "由引擎运行。",
    "# 未完成项", "无。", "# 残余风险", "仅本地 fixture。", "",
  ].join("\n");
  if (type === "review-result") return approved
    ? "# Findings\n\n```yaml\nfindings: []\n```\n"
    : "# Findings\n\n```yaml\nfindings:\n  - id: finding-1\n    severity: P1\n    description: 需要一次本地修复\n    evidence: fixture review\n    path: src/feature.mjs\n    disposition: open\n```\n";
  return `# ${type}\n\n本地 E2E 产物。\n`;
}

export async function worktreeFor(root: string, workItemId: string): Promise<string> {
  const projection = await readControlPlane(root, workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  return path.join(root, locator.worktree);
}

async function snapshotFor(root: string, workItemId: string): Promise<FeatureWorkflowResult["snapshot"]> {
  const worktree = await worktreeFor(root, workItemId);
  return JSON.parse(await readFile(path.join(worktree, ".wsspec", "work-items", workItemId, "snapshot", "application.json"), "utf8")) as FeatureWorkflowResult["snapshot"];
}

async function writeArtifact(worktree: string, pkg: WorkPackage, type: string, approved = true): Promise<ArtifactReference> {
  const body = bodyFor(type, approved);
  const metadata = {
    artifactType: type,
    schemaVersion: 1 as const,
    workItemId: pkg.workItemId,
    stageId: pkg.stepId,
    attemptId: pkg.attemptId,
    revision: 1,
  };
  const contentHash = computeArtifactContentHash(metadata, body);
  const relative = `.wsspec/work-items/${pkg.workItemId}/artifacts/${pkg.stepId.replaceAll(":", "-")}-${type}.md`;
  await mkdir(path.dirname(path.join(worktree, relative)), { recursive: true });
  await writeFile(path.join(worktree, relative), [
    "---", `artifactType: ${type}`, "schemaVersion: 1", `workItemId: ${pkg.workItemId}`, `stageId: ${pkg.stepId}`,
    `attemptId: ${pkg.attemptId}`, "revision: 1", `contentHash: ${contentHash}`, "---", body,
  ].join("\n"), "utf8");
  const contentLevel = pkg.requiredOutputs.find(({ artifactType }) => artifactType === type)?.contentLevel;
  return {
    artifactType: type,
    schemaVersion: 1,
    path: relative,
    revision: 1,
    contentHash,
    mediaType: "text/markdown",
    ...(contentLevel === undefined ? {} : { contentLevel }),
  };
}

function completed(
  pkg: WorkPackage,
  artifacts: ArtifactReference[],
  modifiedFiles: string[] = [],
  externalWrites: Array<Record<string, unknown>> = [],
): SubmitResult {
  return {
    version: 1,
    status: "completed",
    summary: `${pkg.stepId} completed by local E2E fixture`,
    modifiedFiles,
    artifacts,
    commands: [],
    evidence: [],
    externalWrites,
    remainingRisks: [{ risk: "low" }],
  };
}

async function submit(fixture: WorkflowFixture, pkg: WorkPackage, result: SubmitResult): Promise<AgentAction> {
  return fixture.app.submit({
    root: fixture.root,
    workItemId: pkg.workItemId,
    stepId: pkg.stepId,
    attemptId: pkg.attemptId,
    leaseToken: pkg.lease.token,
    result,
  });
}

export async function interruptAfterAcquire(
  fixture: WorkflowFixture,
  started: StartResult,
  acquired: WorkPackage,
  actor: string,
): Promise<WorkPackage> {
  const before = await readControlPlane(fixture.root, started.workItemId);
  assert.equal(before.retries[acquired.stepId]?.attemptsUsed, 1);
  await writeFile(path.join(before.controlPlane, "runtime.json"), "interrupted projection\n", "utf8");
  fixture.advance(61);
  fixture.restart();
  const inspected = await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId });
  assert.equal(inspected.workflowRef, started.workflowRef);
  assert.equal(inspected.profile, started.profile);
  const resumed = await fixture.acquire(started.workItemId, actor);
  const after = await readControlPlane(fixture.root, started.workItemId);
  fixture.recovery.intakeAttemptsUsed = attemptsUsed(after, acquired.stepId);
  return resumed;
}

async function approve(fixture: WorkflowFixture, workItemId: StartResult["workItemId"], action: Extract<AgentAction, { action: "await_approval" }>): Promise<AgentAction> {
  if (action.approval.kind === "external_action") {
    return fixture.app.decide({
      kind: "external_action",
      root: fixture.root,
      workItemId,
      requestId: action.approval.requestId,
      decision: "approved",
      expectedDigest: action.approval.digest,
      actor: "fixture-owner",
    });
  }
  return fixture.app.decide({
    kind: "approval",
    root: fixture.root,
    workItemId,
    requestId: action.approval.requestId,
    decision: "approved",
    expectedDigest: action.approval.digest,
    actor: "fixture-owner",
  });
}

export async function executeFeatureWorkflow(
  fixture: WorkflowFixture,
  started: StartResult,
  options: FeatureOptions,
): Promise<FeatureWorkflowResult> {
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  const artifacts = {} as FeatureArtifacts;
  let action: AgentAction = { action: "execute", workPackage: options.first };
  let reviewIndex = 0;
  let loopInterrupted = false;
  let profileInterrupted = false;
  let approvalInterrupted = false;
  let highRiskInjected = false;
  let ignoredTestAssetAdded = false;
  let writeTestsCount = 0;
  let safety = 0;
  while (action.action !== "completed") {
    if (safety++ > 80) throw new Error(`feature workflow exceeded bounded E2E steps at ${action.action === "execute" ? action.workPackage.stepId : action.action}; reviews=${reviewIndex}; writeTests=${writeTestsCount}`);
    if (action.action === "await_approval") {
      const beforeDecision = await readControlPlane(fixture.root, started.workItemId);
      const approval = beforeDecision.approvals[action.approval.requestId];
      action = await approve(fixture, started.workItemId, action);
      if (!approvalInterrupted && options.interruptAfterApprovalStep !== undefined
        && approval?.stageId === options.interruptAfterApprovalStep) {
        assert.equal(action.action, "execute");
        if (action.action !== "execute") throw new Error("expected active Attempt after governed approval");
        const interrupted = action.workPackage;
        const before = await readControlPlane(fixture.root, started.workItemId);
        const loopBefore = before.loops["review-fix"];
        assert.ok(loopBefore);
        const approvalsBefore = structuredClone(before.approvals);
        await writeFile(path.join(before.controlPlane, "runtime.json"), "interrupted after governed approval\n", "utf8");
        fixture.restart();
        const view = await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId });
        assert.equal(view.workflowRef, started.workflowRef);
        assert.equal(view.profile, "governed");
        const resumed = await fixture.acquire(started.workItemId, options.implementationActor);
        const after = await readControlPlane(fixture.root, started.workItemId);
        assert.equal(resumed.stepId, interrupted.stepId);
        assert.notEqual(resumed.attemptId, interrupted.attemptId);
        assert.deepEqual(after.loops["review-fix"], loopBefore);
        assert.deepEqual(after.approvals, approvalsBefore);
        assert.equal(after.profile.selected, before.profile.selected);
        fixture.recovery.governedStep = resumed.stepId;
        fixture.recovery.governedAttemptChanged = resumed.attemptId !== interrupted.attemptId;
        fixture.recovery.governedAttemptsUsed = attemptsUsed(after, resumed.stepId);
        fixture.recovery.governedLoopMaxIterations = after.loops["review-fix"]?.maxIterations;
        fixture.recovery.governedProfile = after.profile.selected;
        fixture.recovery.governedApprovalCount = Object.keys(after.approvals).length;
        action = { action: "execute", workPackage: resumed };
        approvalInterrupted = true;
      }
      continue;
    }
    if (action.action === "blocked") {
      if (action.problems.some(({ code }) => code === "WSSPEC_INDEPENDENT_REVIEW_REQUIRED")) {
        const reviewer = options.reviewActors[reviewIndex];
        assert.ok(reviewer);
        action = await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: reviewer });
        continue;
      }
      throw new Error(`workflow blocked: ${action.problems.map(({ code, message }) => `${code}:${message}`).join(",")}`);
    }
    let pkg = action.workPackage;
    const required = pkg.requiredOutputs.map(({ artifactType }) => artifactType);
    let refs: ArtifactReference[] = [];
    let modifiedFiles: string[] = [];
    let externalWrites: Array<Record<string, unknown>> = [];
    if (pkg.stepId === "write-tests") {
      writeTestsCount += 1;
      await mkdir(path.join(worktree, "tests"), { recursive: true });
      await writeFile(path.join(worktree, "tests", "workflow-feature.test.mjs"), [
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        "import test from 'node:test';",
        "test('feature delivery reaches value 1', () => assert.match(readFileSync('src/feature.mjs', 'utf8'), /value = 1/));",
        ...(options.addIgnoredTestAssetDuringFix === true && writeTestsCount > 1
          ? ["test('review regression is fixed', () => assert.match(readFileSync('src/feature.mjs', 'utf8'), /regression fixed/));"]
          : []),
        ...(writeTestsCount === 1 ? [] : [`// governed revision ${writeTestsCount}`]),
        "",
      ].join("\n"), "utf8");
      modifiedFiles = ["tests/workflow-feature.test.mjs"];
    } else if (pkg.stepId === "implement") {
      await writeFile(path.join(worktree, "src", "feature.mjs"), `export const value = 1;\n${options.addIgnoredTestAssetDuringFix === true && writeTestsCount > 1 ? "// regression fixed\n" : ""}`, "utf8");
      modifiedFiles = ["src/feature.mjs"];
    } else if (pkg.stepId.endsWith(":fix")) {
      await writeFile(path.join(worktree, "src", "feature.mjs"), "export const value = 1;\n// reviewed fix\n", "utf8");
      if (options.addIgnoredTestAssetDuringFix === true && !ignoredTestAssetAdded) {
        await writeFile(path.join(worktree, "tests", "ignored-late.json"), "{}\n", "utf8");
        ignoredTestAssetAdded = true;
      }
      modifiedFiles = ["src/feature.mjs"];
    } else if (pkg.stepId === "commit") {
      await git(worktree, "add", "src/feature.mjs", "tests/workflow-feature.test.mjs");
      await git(worktree, "commit", "-m", "fixture: complete local feature");
    } else if (options.externalTargets === true && ["update-issue", "update-wiki"].includes(pkg.stepId)) {
      const target = pkg.stepId === "update-wiki" ? "knowledge" : "issue";
      const actionName = target === "knowledge" ? "knowledge.publish" : "issue.update";
      externalWrites = [{
        kind: "external-action",
        provider: "local-fixture",
        action: actionName,
        target: { kind: target, stableId: `local:${target}` },
        payload: { summary: `${pkg.stepId} local publication`, artifactDigests: pkg.artifacts.map(({ contentHash }) => contentHash) },
        sideEffects: [target === "knowledge" ? "更新本地知识目标" : "更新本地 Issue 目标"],
      }];
    } else if (options.externalTargets === true && pkg.stepId === "close-issue") {
      externalWrites = [{
        kind: "external-action",
        provider: "local-fixture",
        action: "issue.close",
        target: { kind: "issue", stableId: "local:issue" },
        payload: { summary: "close local issue after verified delivery" },
        sideEffects: ["关闭本地 Issue 目标"],
      }];
    }
    if (pkg.stepId === options.tamperPublishArtifactAtStep) {
      const artifact = pkg.artifacts[0];
      assert.ok(artifact?.path);
      await writeFile(path.join(worktree, artifact.path), "tampered after acquire\n", "utf8");
    }
    for (const type of required) {
      if (["red-evidence", "tdd-evidence"].includes(type)) continue;
      if (type === "requirement-source") {
        const source = pkg.artifacts.find(({ artifactType }) => artifactType === type);
        assert.ok(source, "requirement-source output requires an authorized input Artifact");
        refs.push(source);
        continue;
      }
      const approved = type !== "review-result" || options.reviewApprovals[reviewIndex] === true;
      const ref = await writeArtifact(worktree, pkg, type, approved);
      refs.push(ref);
      if (type === "specification") artifacts.specification = ref;
      if (type === "design") artifacts.design = ref;
      if (type === "tasks") artifacts.tasks = ref;
      if (type === "review-result") reviewIndex += 1;
    }
    const upgradeNow = !highRiskInjected && pkg.stepId === options.upgradeAtStep;
    const stepResult = completed(pkg, refs, modifiedFiles, externalWrites);
    if (upgradeNow) {
      stepResult.remainingRisks = [{ risk: "high", affectedPaths: ["src/auth/session.ts"] }];
      highRiskInjected = true;
    }
    try {
      action = await submit(fixture, pkg, stepResult);
      if (externalWrites.length === 1 && action.action !== "await_approval") {
        assert.deepEqual(await submit(fixture, pkg, stepResult), action);
      }
    } catch (error) {
      if (error instanceof Error) error.message = `after ${pkg.stepId}: ${error.message}`;
      throw error;
    }
    if (upgradeNow && options.interruptAfterProfileUpgrade === true && !profileInterrupted) {
      assert.equal(action.action, "execute");
      if (action.action !== "execute") throw new Error("expected acquired prerequisite after profile upgrade");
      const interrupted = action.workPackage;
      const before = await readControlPlane(fixture.root, started.workItemId);
      assert.equal(before.profile.selected, "governed");
      await writeFile(path.join(before.controlPlane, "runtime.json"), "interrupted after profile upgrade\n", "utf8");
      fixture.restart();
      const view = await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId });
      assert.equal(view.workflowRef, started.workflowRef);
      assert.equal(view.profile, "governed");
      const resumed = await fixture.acquire(started.workItemId, options.implementationActor);
      const after = await readControlPlane(fixture.root, started.workItemId);
      fixture.recovery.upgradeStep = resumed.stepId;
      fixture.recovery.upgradeAttemptsUsed = attemptsUsed(after, resumed.stepId);
      action = { action: "execute", workPackage: resumed };
      profileInterrupted = true;
    }
    if (options.interruptAfterLoopSubmit === true
      && !loopInterrupted
      && pkg.stepId.endsWith(":review")
      && options.reviewApprovals[reviewIndex - 1] === false) {
      assert.equal(action.action, "execute");
      if (action.action !== "execute") throw new Error("expected acquired fix after rejected review");
      const interrupted = action.workPackage;
      assert.ok(interrupted.stepId.endsWith(":fix"));
      const before = await readControlPlane(fixture.root, started.workItemId);
      const redKey = `tdd:${started.workItemId}:red`;
      const redBefore = before.evidence[redKey];
      assert.ok(parseTrustedEvidence(redBefore));
      await writeFile(path.join(before.controlPlane, "runtime.json"), "interrupted after loop submit\n", "utf8");
      fixture.restart();
      const view = await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId });
      assert.equal(view.profile, started.profile);
      const resumed = await fixture.acquire(started.workItemId, options.reviewActors[reviewIndex - 1] ?? options.implementationActor);
      const after = await readControlPlane(fixture.root, started.workItemId);
      assert.deepEqual(after.evidence[redKey], redBefore);
      assert.ok(parseTrustedEvidence(after.evidence[redKey]));
      fixture.recovery.loopStep = resumed.stepId;
      fixture.recovery.loopAttemptsUsed = attemptsUsed(after, resumed.stepId);
      action = { action: "execute", workPackage: resumed };
      loopInterrupted = true;
    }
  }
  assert.equal(action.summary.status, "closed");
  const projection = await readControlPlane(fixture.root, started.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "interrupted after close\n", "utf8");
  fixture.restart();
  const view = await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId });
  assert.equal(view.status, "closed");
  const recovered = await readControlPlane(fixture.root, started.workItemId);
  return {
    snapshot: await snapshotFor(fixture.root, started.workItemId),
    projection,
    recovered,
    events: await readEvents(recovered.controlPlane),
    artifacts,
    recoveryEvidence: { ...fixture.recovery },
  };
}

export async function assertClosedFeatureWorkflow(
  fixture: WorkflowFixture,
  workItemId: StartResult["workItemId"],
  result: FeatureWorkflowResult,
): Promise<void> {
  assert.equal((await fixture.app.inspect({ root: fixture.root, workItemId })).status, "closed");
  assert.equal(result.recovered.workItem.status, "closed");
  const red = result.recovered.evidence[`tdd:${workItemId}:red`] as { level?: string; phase?: string } | undefined;
  const cycle = result.recovered.evidence[`tdd:${workItemId}:cycle`] as { redEvidenceId?: string; greenEvidenceId?: string } | undefined;
  assert.equal(red?.level, "trusted");
  assert.equal(red?.phase, "red");
  assert.equal(typeof cycle?.redEvidenceId, "string");
  assert.equal(typeof cycle?.greenEvidenceId, "string");
}

async function documentationScopeProbe(
  fixture: WorkflowFixture,
  pkg: WorkPackage,
  worktree: string,
  filename: string,
  content: string,
  restore: string | undefined,
): Promise<string> {
  await mkdir(path.dirname(path.join(worktree, filename)), { recursive: true });
  await writeFile(path.join(worktree, filename), content, "utf8");
  try {
    await submit(fixture, pkg, completed(pkg, [], [filename]));
    throw new Error(`documentation scope probe unexpectedly accepted ${filename}`);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION") throw error;
    return code;
  } finally {
    if (restore === undefined) await unlink(path.join(worktree, filename));
    else await writeFile(path.join(worktree, filename), restore, "utf8");
  }
}

export async function executeDocumentationWorkflow(
  fixture: WorkflowFixture,
  started: StartResult,
  options: DocumentationOptions,
): Promise<DocumentationWorkflowResult> {
  const worktree = await worktreeFor(fixture.root, started.workItemId);
  let action: AgentAction = { action: "execute", workPackage: options.first };
  let scopeViolations: DocumentationWorkflowResult["scopeViolations"] | undefined;
  let workflowAfterProjectSwitch = "";
  let loopInterrupted = false;
  let safety = 0;
  while (action.action !== "completed") {
    if (safety++ > 50) throw new Error("documentation workflow exceeded bounded E2E steps");
    if (action.action === "await_approval") {
      action = await approve(fixture, started.workItemId, action);
      continue;
    }
    if (action.action === "blocked") {
      throw new Error(`documentation workflow blocked: ${action.problems.map(({ code, message }) => `${code}:${message}`).join(",")}`);
    }
    let pkg = action.workPackage;
    let refs: ArtifactReference[] = [];
    let modifiedFiles: string[] = [];
    if (pkg.stepId === "edit-document") {
      assert.ok(pkg.constraints.allowedPaths.every((allowed) => allowed.includes("README") || allowed.includes("CHANGELOG") || allowed.startsWith("docs/")));
      await writeFile(path.join(fixture.root, ".wsspec", "config.yaml"), `${JSON.stringify(projectConfig(false), null, 2)}\n`, "utf8");
      await runWorkflowCommand({
        root: fixture.root,
        argv: ["use", "builtin://workflows/feature-delivery", "--profile", "quick"],
        provider: "codex",
        home: os.homedir(),
      });
      workflowAfterProjectSwitch = (await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId })).workflowRef;
      pkg = await fixture.acquire(started.workItemId, options.actor);
      assert.equal(pkg.stepId, "edit-document");
      const [source, dependency, build] = await Promise.all([
        readFile(path.join(worktree, "src", "feature.mjs"), "utf8"),
        readFile(path.join(worktree, "package.json"), "utf8"),
        readFile(path.join(worktree, "tsconfig.json"), "utf8"),
      ]);
      scopeViolations = {
        production: await documentationScopeProbe(fixture, pkg, worktree, "src/feature.mjs", "export const value = 2;\n", source),
        script: await documentationScopeProbe(fixture, pkg, worktree, "scripts/release.sh", "#!/bin/sh\nexit 0\n", undefined),
        dependency: await documentationScopeProbe(fixture, pkg, worktree, "package.json", "{\"name\":\"fixture\",\"dependencies\":{\"left-pad\":\"1.3.0\"}}\n", dependency),
        build: await documentationScopeProbe(fixture, pkg, worktree, "tsconfig.json", "{\"compilerOptions\":{\"strict\":false}}\n", build),
      };
      await mkdir(path.join(worktree, "docs"), { recursive: true });
      await writeFile(path.join(worktree, "docs", "local-guide.md"), "# Local Guide\n\nUse the local fixture.\n", "utf8");
      modifiedFiles = ["docs/local-guide.md"];
    } else if (pkg.stepId === "commit") {
      await git(worktree, "add", "docs/local-guide.md");
      await git(worktree, "commit", "-m", "docs: add local guide");
    }
    for (const { artifactType } of pkg.requiredOutputs) {
      if (artifactType === "requirement-source") {
        const source = pkg.artifacts.find(({ artifactType: type }) => type === artifactType);
        assert.ok(source, "requirement-source output requires an authorized input Artifact");
        refs.push(source);
      } else {
        refs.push(await writeArtifact(worktree, pkg, artifactType, true));
      }
    }
    action = await submit(fixture, pkg, completed(pkg, refs, modifiedFiles));
    if (options.interruptAfterLoopSubmit === true && !loopInterrupted && pkg.stepId.endsWith(":review")) {
      assert.equal(action.action, "execute");
      if (action.action !== "execute") throw new Error("expected commit after approved documentation review");
      const interrupted = action.workPackage;
      assert.equal(interrupted.stepId, "commit");
      const before = await readControlPlane(fixture.root, started.workItemId);
      await writeFile(path.join(before.controlPlane, "runtime.json"), "interrupted after documentation loop submit\n", "utf8");
      fixture.restart();
      const view = await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId });
      assert.equal(view.workflowRef, "builtin://workflows/documentation-delivery");
      const resumed = await fixture.acquire(started.workItemId, options.actor);
      const after = await readControlPlane(fixture.root, started.workItemId);
      fixture.recovery.loopStep = resumed.stepId;
      fixture.recovery.loopAttemptsUsed = attemptsUsed(after, resumed.stepId);
      action = { action: "execute", workPackage: resumed };
      loopInterrupted = true;
    }
  }
  assert.ok(scopeViolations);
  const projection = await readControlPlane(fixture.root, started.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "interrupted after documentation close\n", "utf8");
  fixture.restart();
  assert.equal((await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId })).status, "closed");
  return {
    projection,
    recovered: await readControlPlane(fixture.root, started.workItemId),
    scopeViolations,
    workflowAfterProjectSwitch,
    recoveryEvidence: { ...fixture.recovery },
  };
}
