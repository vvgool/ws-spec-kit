import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplication, type ApplicationDependencies } from "../../src/application/application.js";
import { parseApplicationSnapshot } from "../../src/application/snapshot.js";
import { computeArtifactContentHash } from "../../src/domain/artifacts.js";
import { sha256 } from "../../src/domain/digests.js";
import type { AgentAction, SubmitResult } from "../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../src/protocol/work-package.js";
import { captureLocalRequirement } from "../../src/registry/connectors/local-requirement.js";
import { mutateControlPlane } from "../../src/engine/scheduler.js";
import { readControlPlane, recoverControlPlane, writeProjection } from "../../src/storage/control-plane.js";
import { withControlPlaneLock } from "../../src/storage/events.js";
import { initRepository } from "../../src/storage/repository.js";
import { createWorkItem } from "../../src/storage/work-items.js";
import { createGitRepository, git } from "./helpers/git.js";

interface Fixture {
  root: string;
  app: ReturnType<typeof createApplication>;
  setNow(value: string): void;
}

async function fixture(overrides: Partial<ApplicationDependencies> = {}): Promise<Fixture> {
  const root = await createGitRepository();
  await initRepository(root);
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "test: initialize WSSpecKit");
  let currentTime = "2026-08-17T04:00:00.000Z";
  const app = createApplication({
    provider: "codex",
    home: os.homedir(),
    terminal: { isTTY: true },
    now: () => new Date(currentTime),
    ...overrides,
  });
  return { root, app, setNow: (value) => { currentTime = value; } };
}

async function worktreeFor(root: string, workItemId: string): Promise<string> {
  const projection = await readControlPlane(root, workItemId);
  const locator = JSON.parse(await readFile(path.join(path.dirname(projection.controlPlane), "locator.json"), "utf8")) as { worktree: string };
  return path.join(root, locator.worktree);
}

async function rewriteApplicationSnapshot(
  current: Fixture,
  workItemId: string,
  mutate: (snapshot: Record<string, unknown>) => void,
): Promise<{ controlPlane: string; snapshot: Record<string, unknown> }> {
  const worktree = await worktreeFor(current.root, workItemId);
  const itemRoot = path.join(worktree, ".wsspec", "work-items", workItemId);
  const applicationPath = path.join(itemRoot, "snapshot", "application.json");
  const manifestPath = path.join(itemRoot, "work-item.yaml");
  const snapshot = JSON.parse(await readFile(applicationPath, "utf8")) as Record<string, unknown>;
  mutate(snapshot);
  const applicationText = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(applicationPath, applicationText, "utf8");
  const manifest = await readFile(manifestPath, "utf8");
  const updatedManifest = manifest.replace(/workflowDigest: sha256:[a-f0-9]+/u, `workflowDigest: ${sha256(applicationText)}`);
  assert.notEqual(updatedManifest, manifest);
  await writeFile(manifestPath, updatedManifest, "utf8");
  const projection = await readControlPlane(current.root, workItemId);
  const anchorPath = path.join(projection.controlPlane, "application-anchor.json");
  const anchor = JSON.parse(await readFile(anchorPath, "utf8")) as Record<string, unknown>;
  anchor.manifestDigest = sha256(updatedManifest);
  await writeFile(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`, "utf8");
  return { controlPlane: projection.controlPlane, snapshot };
}

function completedResult(workPackage: WorkPackage, artifacts = workPackage.requiredOutputs): SubmitResult {
  return {
    version: 1,
    status: "completed",
    summary: `${workPackage.stepId} completed`,
    modifiedFiles: [],
    artifacts,
    commands: [],
    evidence: [],
    externalWrites: [],
    remainingRisks: [],
  };
}

function requireExecute(action: AgentAction): WorkPackage {
  assert.equal(action.action, "execute");
  if (action.action !== "execute") throw new Error("expected execute action");
  return action.workPackage;
}

async function submitPackage(current: Fixture, workPackage: WorkPackage, result = completedResult(workPackage)): Promise<AgentAction> {
  return current.app.submit({
    root: current.root,
    workItemId: workPackage.workItemId,
    stepId: workPackage.stepId,
    attemptId: workPackage.attemptId,
    leaseToken: workPackage.lease.token,
    result,
  });
}

async function writeArtifact(input: {
  worktree: string;
  workItemId: string;
  workPackage: WorkPackage;
  artifactType: string;
  body: string;
  filename?: string;
}): Promise<ArtifactReference> {
  const metadata = {
    artifactType: input.artifactType,
    schemaVersion: 1 as const,
    workItemId: input.workItemId,
    stageId: input.workPackage.stepId,
    attemptId: input.workPackage.attemptId,
    revision: 1,
  };
  const contentHash = computeArtifactContentHash(metadata, input.body);
  const relative = `.wsspec/work-items/${input.workItemId}/artifacts/${input.filename ?? `${input.artifactType}.md`}`;
  await mkdir(path.dirname(path.join(input.worktree, relative)), { recursive: true });
  await writeFile(
    path.join(input.worktree, relative),
    `---\nartifactType: ${input.artifactType}\nschemaVersion: 1\nworkItemId: ${input.workItemId}\nstageId: ${input.workPackage.stepId}\nattemptId: ${input.workPackage.attemptId}\nrevision: 1\ncontentHash: ${contentHash}\n---\n${input.body}`,
    "utf8",
  );
  return { artifactType: input.artifactType, schemaVersion: 1, path: relative, revision: 1, contentHash, mediaType: "text/markdown" };
}

async function prepareApproval(current: Fixture): Promise<{
  started: Awaited<ReturnType<Fixture["app"]["start"]>>;
  clarify: WorkPackage;
  awaiting: Extract<AgentAction, { action: "await_approval" }>;
  worktree: string;
}> {
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "增加登录" }, profile: "standard" });
  const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const explore = requireExecute(await submitPackage(current, intake));
  const worktree = await worktreeFor(current.root, started.workItemId);
  const exploration = await writeArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: explore,
    artifactType: "exploration-report",
    body: "# Exploration\n\nRepository facts.\n",
  });
  const clarify = requireExecute(await submitPackage(current, explore, completedResult(explore, [exploration])));
  const specificationBody = [
    "# 规格", "", "## 目标与背景", "目标", "## 范围", "范围", "## 需求", "需求",
    "## 验收条件", "条件", "## 约束", "约束", "## 排除项", "无", "## 开放问题", "无", "",
  ].join("\n");
  const specification = await writeArtifact({ worktree, workItemId: started.workItemId, workPackage: clarify, artifactType: "specification", body: specificationBody });
  const action = await submitPackage(current, clarify, completedResult(clarify, [specification]));
  assert.equal(action.action, "await_approval");
  if (action.action !== "await_approval") throw new Error("expected approval");
  return { started, clarify, awaiting: action, worktree };
}

async function installGlobalSkillWorkflow(current: Fixture, home: string): Promise<void> {
  const projectPackage = path.join(current.root, ".wsspec", "workflows", "feature-delivery");
  await cp(path.join(process.cwd(), "resources", "workflows", "feature-delivery"), projectPackage, { recursive: true });
  const workflowPath = path.join(projectPackage, "workflow.yaml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(workflowPath, workflow.replaceAll("builtin://skills/requirement-exploration", "global://vendor/test"), "utf8");
  await mkdir(path.join(home, ".agents", "skills", "vendor", "test"), { recursive: true });
  await writeFile(path.join(home, ".agents", "skills", "vendor", "test", "SKILL.md"), "# Global Test\n", "utf8");
  await git(current.root, "add", ".wsspec/workflows/feature-delivery");
  await git(current.root, "commit", "-m", "test: add global Skill Workflow");
}

async function installArtifactContractWorkflow(current: Fixture, artifactType: string): Promise<void> {
  const projectPackage = path.join(current.root, ".wsspec", "workflows", "feature-delivery");
  await cp(path.join(process.cwd(), "resources", "workflows", "feature-delivery"), projectPackage, { recursive: true });
  const workflowPath = path.join(projectPackage, "workflow.yaml");
  const workflow = await readFile(workflowPath, "utf8");
  await writeFile(workflowPath, workflow.replace("outputs: [exploration-report]", `outputs: [${artifactType}]`), "utf8");
  await git(current.root, "add", ".wsspec/workflows/feature-delivery");
  await git(current.root, "commit", "-m", `test: declare ${artifactType} output`);
}

async function installRetryWorkflow(current: Fixture): Promise<void> {
  const projectPackage = path.join(current.root, ".wsspec", "workflows", "feature-delivery");
  await cp(path.join(process.cwd(), "resources", "workflows", "feature-delivery"), projectPackage, { recursive: true });
  const workflowPath = path.join(projectPackage, "workflow.yaml");
  const workflow = await readFile(workflowPath, "utf8");
  const withRetry = workflow.replace(
    "  - id: plan\n    uses: agent.execute\n",
    "  - id: plan\n    uses: agent.execute\n    retry: { maxAttempts: 3 }\n",
  );
  assert.notEqual(withRetry, workflow);
  await writeFile(workflowPath, withRetry, "utf8");
  await git(current.root, "add", ".wsspec/workflows/feature-delivery");
  await git(current.root, "commit", "-m", "test: add Workflow retry policy");
}

async function trustProjectWorkflow(current: Fixture): Promise<void> {
  let request: { requestId: string; packageDigest: string; capabilityDigest: string } | undefined;
  await assert.rejects(
    current.app.start({ root: current.root, source: { type: "prompt", text: "Global Skill lock" }, workflowRef: "project://workflows/feature-delivery" }),
    (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || (error as Error & { code: string }).code !== "WSSPEC_WORKFLOW_TRUST_REQUIRED") return false;
      request = (error as unknown as Error & { details: typeof request }).details;
      return request !== undefined;
    },
  );
  assert.ok(request);
  await current.app.decide({
    kind: "workflow_trust",
    root: current.root,
    requestId: request.requestId,
    decision: "trusted",
    expectedPackageDigest: request.packageDigest,
    expectedCapabilityDigest: request.capabilityDigest,
    actor: "reviewer",
  });
}

test("start resolves explicit or active Workflow and persists a complete immutable snapshot", async () => {
  const explicit = await fixture();
  await writeFile(path.join(explicit.root, "requirement.md"), "只更新文档\n", "utf8");
  await git(explicit.root, "add", "requirement.md");
  await git(explicit.root, "commit", "-m", "test: add requirement");

  const documentation = await explicit.app.start({
    root: explicit.root,
    source: { type: "file", path: "requirement.md" },
    workflowRef: "builtin://workflows/documentation-delivery",
    profile: "standard",
  });
  assert.equal(documentation.workflowRef, "builtin://workflows/documentation-delivery");
  assert.equal(documentation.profile, "standard");

  const worktree = await worktreeFor(explicit.root, documentation.workItemId);
  const itemRoot = path.join(worktree, ".wsspec", "work-items", documentation.workItemId);
  const application = JSON.parse(await readFile(path.join(itemRoot, "snapshot", "application.json"), "utf8")) as {
    workflowRef: string;
    profiles: Record<string, unknown>;
    workflowPackageLock: { contentDigest: string };
    skillLock: { skills: unknown[] };
    gatePolicy: { requiredGateIds: string[]; configuredGateIds: string[] };
    changePolicy: { kind: string; allowedPaths: string[] };
  };
  const source = JSON.parse(await readFile(path.join(itemRoot, "source", "source.json"), "utf8")) as { content: { text: string }; contentDigest: string };
  assert.equal(application.workflowRef, "builtin://workflows/documentation-delivery");
  assert.deepEqual(Object.keys(application.profiles).sort(), ["governed", "quick", "standard"]);
  assert.match(application.workflowPackageLock.contentDigest, /^sha256:/);
  assert.ok(application.skillLock.skills.length > 0);
  assert.deepEqual(application.gatePolicy, { requiredGateIds: ["docs.integrity"], configuredGateIds: ["docs.integrity"] });
  assert.equal(application.changePolicy.kind, "documentation-only");
  assert.equal(source.content.text, "只更新文档\n");
  assert.equal(source.contentDigest, sha256(source.content.text));
  await readFile(path.join(itemRoot, "snapshot", "config.yaml"), "utf8");
  await readFile(path.join(itemRoot, "snapshot", "schemas", "builtin-work-package-v1.schema.json"), "utf8");
  await readFile(path.join(itemRoot, "snapshot", "workflow", "manifest.yaml"), "utf8");
  await readFile(path.join(itemRoot, "snapshot", "skills", "builtin", "documentation-editing", "SKILL.md"), "utf8");

  const implicit = await fixture();
  const feature = await implicit.app.start({ root: implicit.root, source: { type: "prompt", text: "增加登录" }, profile: "auto" });
  assert.equal(feature.workflowRef, "builtin://workflows/feature-delivery");
  assert.equal(feature.profile, "quick");
  await writeFile(path.join(implicit.root, ".wsspec", "workflow.yaml"), "version: 1\nactiveWorkflow: { ref: builtin://workflows/documentation-delivery, version: 1 }\nprofile: governed\n", "utf8");
  const inspected = await implicit.app.inspect({ root: implicit.root, workItemId: feature.workItemId });
  assert.equal(inspected.workflowRef, "builtin://workflows/feature-delivery");
  assert.equal(inspected.status, "active");
});

test("再次 acquire 已结束 Work Item 返回中文完成摘要", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "关闭后的查询" }, profile: "standard" });
  const projection = await readControlPlane(current.root, started.workItemId);
  await writeProjection({ ...projection, workItem: { status: "closed" }, readOnly: true });

  const action = await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" });

  assert.deepEqual(action, {
    action: "completed",
    summary: { workItemId: started.workItemId, status: "closed", message: "Workflow 已结束。" },
  });
});

test("Global 与 Project Skill 在 Snapshot 和公开 Work Package 中使用中文描述", async (t) => {
  for (const scenario of [
    { name: "Global", ref: "global://vendor/test", skillPath: (root: string, home: string) => path.join(home, ".agents", "skills", "vendor", "test") },
    { name: "Project", ref: "project://skills/test", skillPath: (root: string) => path.join(root, ".wsspec", "skills", "test") },
  ]) {
    await t.test(scenario.name, async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), `wspec-${scenario.name.toLowerCase()}-skill-`));
      const current = await fixture({ home, workflowTrust: { interactive: true, actor: "reviewer" } });
      const projectPackage = path.join(current.root, ".wsspec", "workflows", "feature-delivery");
      await cp(path.join(process.cwd(), "resources", "workflows", "feature-delivery"), projectPackage, { recursive: true });
      const workflowPath = path.join(projectPackage, "workflow.yaml");
      await writeFile(workflowPath, (await readFile(workflowPath, "utf8")).replaceAll("builtin://skills/requirement-exploration", scenario.ref), "utf8");
      const skillDirectory = scenario.skillPath(current.root, home);
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(path.join(skillDirectory, "SKILL.md"), "# 测试 Skill\n", "utf8");
      await git(current.root, "add", ".wsspec");
      await git(current.root, "commit", "-m", `test: add ${scenario.name} Skill Workflow`);
      await trustProjectWorkflow(current);

      const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "公开 Skill 描述" }, workflowRef: "project://workflows/feature-delivery", profile: "standard" });
      const worktree = await worktreeFor(current.root, started.workItemId);
      const snapshot = JSON.parse(await readFile(path.join(worktree, ".wsspec", "work-items", started.workItemId, "snapshot", "application.json"), "utf8")) as {
        profiles: { standard: { steps: Array<{ id: string; skills: Array<{ description: string }> }> } };
      };
      assert.deepEqual(snapshot.profiles.standard.steps.find(({ id }) => id === "explore")?.skills.map(({ description }) => description), ["已锁定的工作流 Skill。"]);

      const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
      const explore = requireExecute(await submitPackage(current, intake));
      assert.deepEqual(explore.skills.map(({ description }) => description), ["已锁定的工作流 Skill。"]);
    });
  }
});

test("snapshot and recovery preserve recursive compiled semantics and output content levels", async () => {
  const current = await fixture({ workflowTrust: { interactive: true, actor: "reviewer" } });
  await installRetryWorkflow(current);
  await trustProjectWorkflow(current);
  const started = await current.app.start({
    root: current.root,
    source: { type: "prompt", text: "保留编译后的执行语义" },
    workflowRef: "project://workflows/feature-delivery",
    profile: "quick",
  });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const itemRoot = path.join(worktree, ".wsspec", "work-items", started.workItemId);
  const application = JSON.parse(await readFile(path.join(itemRoot, "snapshot", "application.json"), "utf8")) as {
    profiles: Record<string, { steps: Array<{
      id: string;
      artifactLevel?: string;
      until?: string;
      retry?: { maxAttempts: number };
      maxIterations?: number;
      independentReviewActor?: boolean;
      outputs: Array<{ artifact: string; required: boolean; contentLevel?: string }>;
      steps?: Array<{ id: string }>;
    }> }>;
  };
  const governedReviewFix = application.profiles.governed?.steps.find(({ id }) => id === "review-fix");
  assert.equal(governedReviewFix?.until, "${review-result.approved}");
  assert.equal(governedReviewFix?.maxIterations, 5);
  assert.equal(governedReviewFix?.independentReviewActor, true);
  assert.deepEqual(governedReviewFix?.steps?.map(({ id }) => id), ["review", "fix", "verify"]);
  const quickPlan = application.profiles.quick?.steps.find(({ id }) => id === "plan");
  assert.equal(quickPlan?.artifactLevel, "compact");
  assert.deepEqual(quickPlan?.retry, { maxAttempts: 3 });
  assert.deepEqual(quickPlan?.outputs, [{ artifact: "tasks", required: true, contentLevel: "compact" }]);

  const projection = await readControlPlane(current.root, started.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");
  await recoverControlPlane({ cwd: current.root, workItemId: started.workItemId });

  const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const explore = requireExecute(await submitPackage(current, intake));
  const exploration = await writeArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: explore,
    artifactType: "exploration-report",
    body: "# Exploration\n\nRepository facts.\n",
  });
  const clarify = requireExecute(await submitPackage(current, explore, completedResult(explore, [exploration])));
  const specification = await writeArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: clarify,
    artifactType: "specification",
    body: [
      "# 规格", "", "## 目标与背景", "目标", "## 范围", "范围", "## 需求", "需求",
      "## 验收条件", "条件", "## 约束", "约束", "## 排除项", "无", "## 开放问题", "无", "",
    ].join("\n"),
  });
  const plan = requireExecute(await submitPackage(current, clarify, completedResult(clarify, [specification])));
  assert.equal(plan.stepId, "plan");
  assert.equal(plan.artifactLevel, "compact");
  assert.deepEqual(plan.requiredOutputs, [{ artifactType: "tasks", schemaVersion: 1, contentLevel: "compact" }]);
});

test("application snapshot parser rejects unknown and malformed recursive fields", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "严格解析快照" } });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const applicationPath = path.join(worktree, ".wsspec", "work-items", started.workItemId, "snapshot", "application.json");
  const snapshot = JSON.parse(await readFile(applicationPath, "utf8")) as Record<string, unknown>;
  assert.equal(parseApplicationSnapshot(snapshot).version, 1);

  const corruptions: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["top-level unknown field", (value) => { value.typo = true; }],
    ["nested Step unknown field", (value) => {
      const profiles = value.profiles as Record<string, { steps: Array<Record<string, unknown>> }>;
      const reviewFix = profiles.governed!.steps.find(({ id }) => id === "review-fix")!;
      (reviewFix.steps as Array<Record<string, unknown>>)[0]!.typo = true;
    }],
    ["missing recursive steps", (value) => {
      const profiles = value.profiles as Record<string, { steps: Array<Record<string, unknown>> }>;
      delete profiles.quick!.steps[0]!.steps;
    }],
    ["invalid output content level", (value) => {
      const profiles = value.profiles as Record<string, { steps: Array<Record<string, unknown>> }>;
      const plan = profiles.quick!.steps.find(({ id }) => id === "plan")!;
      (plan.outputs as Array<Record<string, unknown>>)[0]!.contentLevel = 1;
    }],
  ];
  for (const [name, mutate] of corruptions) {
    const corrupted = structuredClone(snapshot);
    mutate(corrupted);
    assert.throws(
      () => parseApplicationSnapshot(corrupted),
      (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_APPLICATION_SNAPSHOT_INVALID",
      name,
    );
  }
});

test("acquire and recovery reject structurally invalid Application snapshots with coordinated digests", async (t) => {
  await t.test("acquire", async () => {
    const current = await fixture();
    const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "Acquire 严格解析" } });
    await rewriteApplicationSnapshot(current, started.workItemId, (snapshot) => { snapshot.typo = true; });
    await assert.rejects(
      current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }),
      (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_APPLICATION_SNAPSHOT_INVALID",
    );
  });

  await t.test("recovery", async () => {
    const current = await fixture();
    const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "Recovery 严格解析" } });
    const rewritten = await rewriteApplicationSnapshot(current, started.workItemId, (snapshot) => {
      const profiles = snapshot.profiles as Record<string, { steps: Array<Record<string, unknown>> }>;
      const reviewFix = profiles.governed!.steps.find(({ id }) => id === "review-fix")!;
      (reviewFix.steps as Array<Record<string, unknown>>)[0]!.typo = true;
    });
    await writeFile(path.join(rewritten.controlPlane, "runtime.json"), "not-json\n", "utf8");
    await assert.rejects(
      recoverControlPlane({ cwd: current.root, workItemId: started.workItemId }),
      (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_APPLICATION_SNAPSHOT_INVALID",
    );
  });
});

test("start rejects unknown Workflows and non-repository or unsupported file sources", async () => {
  const current = await fixture();
  await assert.rejects(
    current.app.start({ root: current.root, source: { type: "prompt", text: "unknown" }, workflowRef: "builtin://workflows/missing" }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND",
  );
  await writeFile(path.join(current.root, "requirement.json"), "{}\n", "utf8");
  await assert.rejects(
    current.app.start({ root: current.root, source: { type: "file", path: "requirement.json" } }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SOURCE_TYPE_UNSUPPORTED",
  );
  await assert.rejects(
    current.app.start({ root: current.root, source: { type: "file", path: "../outside.md" } }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SOURCE_PATH_INVALID",
  );
});

test("start strictly validates project config and Workflow selection files", async (t) => {
  const cases: Array<{
    name: string;
    file: "config.yaml" | "workflow.yaml";
    value: unknown;
    code: string;
    path: string;
  }> = [
    { name: "config root unknown", file: "config.yaml", value: { version: 1, unknownSecuritySetting: true }, code: "WSSPEC_SCHEMA_UNKNOWN_FIELD", path: "/unknownSecuritySetting" },
    { name: "config nested unknown", file: "config.yaml", value: { version: 1, runtime: { claimTtlSeconds: 60, maxStageRetries: 3, typo: true } }, code: "WSSPEC_SCHEMA_UNKNOWN_FIELD", path: "/runtime/typo" },
    { name: "config claim TTL below range", file: "config.yaml", value: { version: 1, runtime: { claimTtlSeconds: 59, maxStageRetries: 3 } }, code: "WSSPEC_SCHEMA_INVALID_VALUE", path: "/runtime/claimTtlSeconds" },
    { name: "config retry limit above range", file: "config.yaml", value: { version: 1, runtime: { claimTtlSeconds: 60, maxStageRetries: 11 } }, code: "WSSPEC_SCHEMA_INVALID_VALUE", path: "/runtime/maxStageRetries" },
    { name: "Workflow root unknown", file: "workflow.yaml", value: { version: 1, activeWorkflow: { ref: "builtin://workflows/feature-delivery", version: 1 }, typo: true }, code: "WSSPEC_SCHEMA_UNKNOWN_FIELD", path: "/typo" },
    { name: "Workflow nested unknown", file: "workflow.yaml", value: { version: 1, activeWorkflow: { ref: "builtin://workflows/feature-delivery", version: 1, typo: true } }, code: "WSSPEC_SCHEMA_UNKNOWN_FIELD", path: "/activeWorkflow/typo" },
    { name: "Workflow profile invalid", file: "workflow.yaml", value: { version: 1, activeWorkflow: { ref: "builtin://workflows/feature-delivery", version: 1 }, profile: "fast" }, code: "WSSPEC_SCHEMA_INVALID_VALUE", path: "/profile" },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.name, async () => {
      const current = await fixture();
      await writeFile(path.join(current.root, ".wsspec", currentCase.file), `${JSON.stringify(currentCase.value)}\n`, "utf8");
      await assert.rejects(
        current.app.start({ root: current.root, source: { type: "prompt", text: "严格配置" } }),
        (error: unknown) => error instanceof Error
          && "code" in error
          && "path" in error
          && (error as Error & { code: string }).code === currentCase.code
          && (error as Error & { path: string }).path === currentCase.path,
      );
    });
  }
});

test("start preserves a foreign control-plane collision while rolling back its own branch, worktree and locator", async () => {
  const current = await fixture();
  const workItemsRoot = path.join(current.root, ".git", "wsspec", "work-items");
  const start = current.app.start({ root: current.root, source: { type: "prompt", text: "原子启动" } });
  let workItemId: string | undefined;
  for (let attempt = 0; attempt < 5_000 && workItemId === undefined; attempt += 1) {
    const candidates = await readdir(workItemsRoot).catch(() => []);
    workItemId = candidates.find((candidate) => candidate.startsWith("WSS-"));
    if (workItemId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(workItemId, "start must publish the locator before the injected failure");
  const controlPlane = path.join(workItemsRoot, workItemId, "control-plane");
  const injected = await open(controlPlane, "wx");
  await injected.writeFile("foreign control plane\n", "utf8");
  await injected.close();

  await assert.rejects(start, (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
  assert.equal(await git(current.root, "branch", "--list", `wspec/${workItemId}`), "");
  await assert.rejects(access(path.join(current.root, ".worktrees", workItemId)));
  await assert.rejects(access(path.join(workItemsRoot, workItemId, "locator.json")));
  assert.equal(await readFile(controlPlane, "utf8"), "foreign control plane\n");
});

test("start preserves a foreign locator collision while rolling back its own branch and worktree", async () => {
  const current = await fixture();
  const worktreesRoot = path.join(current.root, ".worktrees");
  const workItemsRoot = path.join(current.root, ".git", "wsspec", "work-items");
  const start = current.app.start({ root: current.root, source: { type: "prompt", text: "创建期原子性" } });
  let workItemId: string | undefined;
  for (let attempt = 0; attempt < 5_000 && workItemId === undefined; attempt += 1) {
    const candidates = await readdir(worktreesRoot).catch(() => []);
    workItemId = candidates.find((candidate) => candidate.startsWith("WSS-"));
    if (workItemId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(workItemId, "createWorkItem must add its worktree before the injected failure");
  await mkdir(path.join(workItemsRoot, workItemId, "locator.json"), { recursive: true });

  await assert.rejects(start, (error: unknown) => ["EISDIR", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""));
  assert.equal(await git(current.root, "branch", "--list", `wspec/${workItemId}`), "");
  await assert.rejects(access(path.join(worktreesRoot, workItemId)));
  assert.deepEqual(await readdir(path.join(workItemsRoot, workItemId, "locator.json")), []);
});

test("start never overwrites a foreign locator file created while its worktree is being prepared", async () => {
  const current = await fixture();
  const worktreesRoot = path.join(current.root, ".worktrees");
  const workItemsRoot = path.join(current.root, ".git", "wsspec", "work-items");
  const start = current.app.start({ root: current.root, source: { type: "prompt", text: "定位文件原子性" } });
  let workItemId: string | undefined;
  for (let attempt = 0; attempt < 5_000 && workItemId === undefined; attempt += 1) {
    const candidates = await readdir(worktreesRoot).catch(() => []);
    workItemId = candidates.find((candidate) => candidate.startsWith("WSS-"));
    if (workItemId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(workItemId, "createWorkItem must add its worktree before the injected failure");
  const locator = path.join(workItemsRoot, workItemId, "locator.json");
  await mkdir(path.dirname(locator), { recursive: true });
  await writeFile(locator, "foreign locator\n", { encoding: "utf8", flag: "wx" });

  await assert.rejects(start, (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
  assert.equal(await git(current.root, "branch", "--list", `wspec/${workItemId}`), "");
  await assert.rejects(access(path.join(worktreesRoot, workItemId)));
  assert.equal(await readFile(locator, "utf8"), "foreign locator\n");
});

test("Work Item creation persists the exact pre-captured local source bytes", async () => {
  const current = await fixture();
  const sourcePath = path.join(current.root, "requirement.md");
  await writeFile(sourcePath, "original requirement\n", "utf8");
  const captured = await captureLocalRequirement(current.root, { type: "file", path: "requirement.md" });
  await writeFile(sourcePath, "changed after capture\n", "utf8");
  const [workflowText, configText] = await Promise.all([
    readFile(path.join(current.root, ".wsspec", "workflow.yaml"), "utf8"),
    readFile(path.join(current.root, ".wsspec", "config.yaml"), "utf8"),
  ]);
  const item = await createWorkItem({
    root: current.root,
    workItemId: "WSS-PRECAPTURED-SOURCE",
    title: "Pre-captured source",
    source: { type: "file", path: "requirement.md" },
    capturedSource: captured,
    application: { workflowText, configText },
  });
  const source = JSON.parse(await readFile(
    path.join(current.root, item.execution.worktree, ".wsspec", "work-items", item.workItemId, item.source.snapshot),
    "utf8",
  )) as { content: { text: string }; contentDigest: string };
  assert.equal(source.content.text, "original requirement\n");
  assert.equal(source.contentDigest, captured.contentDigest);
});

test("project Workflow start requires a persisted trust decision before creating a Work Item", async () => {
  const current = await fixture({ workflowTrust: { interactive: true, actor: "reviewer" } });
  const projectPackage = path.join(current.root, ".wsspec", "workflows", "feature-delivery");
  await cp(path.join(process.cwd(), "resources", "workflows", "feature-delivery"), projectPackage, { recursive: true });
  await git(current.root, "add", ".wsspec/workflows/feature-delivery");
  await git(current.root, "commit", "-m", "test: eject feature Workflow");
  let request: { requestId: string; packageDigest: string; capabilityDigest: string } | undefined;
  await assert.rejects(
    current.app.start({ root: current.root, source: { type: "prompt", text: "可信项目流程" }, workflowRef: "project://workflows/feature-delivery" }),
    (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || (error as Error & { code: string }).code !== "WSSPEC_WORKFLOW_TRUST_REQUIRED") return false;
      request = (error as unknown as Error & { details: typeof request }).details;
      return request !== undefined;
    },
  );
  assert.ok(request);
  const nonInteractive = createApplication({ provider: "codex", home: os.homedir(), terminal: { isTTY: false } });
  await assert.rejects(
    nonInteractive.decide({
      kind: "workflow_trust",
      root: current.root,
      requestId: request.requestId,
      decision: "trusted",
      expectedPackageDigest: request.packageDigest,
      expectedCapabilityDigest: request.capabilityDigest,
      actor: "reviewer",
    }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_INTERACTIVE_TTY_REQUIRED",
  );
  const decision = await current.app.decide({
    kind: "workflow_trust",
    root: current.root,
    requestId: request.requestId,
    decision: "trusted",
    expectedPackageDigest: request.packageDigest,
    expectedCapabilityDigest: request.capabilityDigest,
    actor: "reviewer",
  });
  assert.equal(decision.action, "blocked");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "可信项目流程" }, workflowRef: "project://workflows/feature-delivery" });
  assert.equal(started.workflowRef, "project://workflows/feature-delivery");
});

test("acquire revalidates every locked Global Skill before issuing a Work Package", async (t) => {
  for (const scenario of [
    {
      name: "modified selected candidate",
      expectedCode: "WSSPEC_SKILL_LOCK_CHANGED",
      mutate: async (home: string) => writeFile(path.join(home, ".agents", "skills", "vendor", "test", "SKILL.md"), "# Changed Global Test\n", "utf8"),
    },
    {
      name: "deleted selected candidate",
      expectedCode: "WSSPEC_SKILL_LOCK_CHANGED",
      mutate: async (home: string) => rm(path.join(home, ".agents", "skills", "vendor", "test"), { recursive: true }),
    },
    {
      name: "new conflicting candidate",
      expectedCode: "WSSPEC_SKILL_AMBIGUOUS",
      mutate: async (home: string) => {
        const candidate = path.join(home, ".cursor", "skills", "vendor", "test");
        await mkdir(candidate, { recursive: true });
        await writeFile(path.join(candidate, "SKILL.md"), "# Conflicting Global Test\n", "utf8");
      },
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const home = path.join(os.tmpdir(), `wsspec-application-home-${crypto.randomUUID()}`);
      const current = await fixture({ provider: "cursor", home, workflowTrust: { interactive: true, actor: "reviewer" } });
      await installGlobalSkillWorkflow(current, home);
      await trustProjectWorkflow(current);
      const started = await current.app.start({
        root: current.root,
        source: { type: "prompt", text: "Global Skill lock" },
        workflowRef: "project://workflows/feature-delivery",
      });

      await scenario.mutate(home);

      await assert.rejects(
        current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }),
        (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === scenario.expectedCode,
      );
    });
  }
});

test("submit validates malformed bodies for every built-in Artifact contract", async (t) => {
  for (const artifactType of [
    "specification",
    "design",
    "plan",
    "tasks",
    "implementation-result",
    "review-result",
    "verification-result",
    "knowledge-entry",
  ]) {
    await t.test(artifactType, async () => {
      const current = await fixture({ workflowTrust: { interactive: true, actor: "reviewer" } });
      await installArtifactContractWorkflow(current, artifactType);
      await trustProjectWorkflow(current);
      const started = await current.app.start({
        root: current.root,
        source: { type: "prompt", text: `validate ${artifactType}` },
        workflowRef: "project://workflows/feature-delivery",
      });
      const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
      const explore = requireExecute(await submitPackage(current, intake));
      const worktree = await worktreeFor(current.root, started.workItemId);
      const malformed = await writeArtifact({
        worktree,
        workItemId: started.workItemId,
        workPackage: explore,
        artifactType,
        body: "# Malformed\n\nMissing the required contract body.\n",
      });

      await assert.rejects(
        submitPackage(current, explore, completedResult(explore, [malformed])),
        (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_ARTIFACT_INCOMPLETE",
      );
    });
  }
});

test("acquire rejects a mutated Workflow snapshot", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "快照" } });
  const worktree = await worktreeFor(current.root, started.workItemId);
  await writeFile(
    path.join(worktree, ".wsspec", "work-items", started.workItemId, "snapshot", "workflow", "manifest.yaml"),
    "version: 1\nid: forged\n",
    "utf8",
  );

  await assert.rejects(
    current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_WORKFLOW_SNAPSHOT_CHANGED",
  );
});

test("acquire rejects coordinated Application snapshot and manifest tampering", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "锚点" } });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const itemRoot = path.join(worktree, ".wsspec", "work-items", started.workItemId);
  const applicationPath = path.join(itemRoot, "snapshot", "application.json");
  const manifestPath = path.join(itemRoot, "work-item.yaml");
  const application = JSON.parse(await readFile(applicationPath, "utf8")) as Record<string, unknown>;
  application.createdAt = "2099-01-01T00:00:00.000Z";
  const applicationText = `${JSON.stringify(application, null, 2)}\n`;
  await writeFile(applicationPath, applicationText, "utf8");
  const manifest = await readFile(manifestPath, "utf8");
  const tamperedManifest = manifest.replace(/workflowDigest: sha256:[a-f0-9]+/u, `workflowDigest: ${sha256(applicationText)}`);
  assert.notEqual(tamperedManifest, manifest);
  await writeFile(manifestPath, tamperedManifest, "utf8");

  await assert.rejects(
    current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_WORK_ITEM_MANIFEST_CHANGED",
  );
});

test("recovery rejects a mutated Application snapshot before deriving stages", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "恢复锚点" } });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const applicationPath = path.join(worktree, ".wsspec", "work-items", started.workItemId, "snapshot", "application.json");
  const application = JSON.parse(await readFile(applicationPath, "utf8")) as {
    selectedProfile: string;
    profiles: Record<string, { order: string[]; steps: Array<Record<string, unknown>> }>;
  };
  const profile = application.profiles[application.selectedProfile]!;
  profile.order = ["forged"];
  profile.steps = [{ id: "forged", enabled: true, needs: [] }];
  await writeFile(applicationPath, `${JSON.stringify(application, null, 2)}\n`, "utf8");
  const projection = await readControlPlane(current.root, started.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: current.root, workItemId: started.workItemId }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_APPLICATION_SNAPSHOT_CHANGED",
  );
});

test("recovery cannot downgrade an anchored Application Work Item to a legacy Workflow", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "禁止降级恢复" } });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const itemRoot = path.join(worktree, ".wsspec", "work-items", started.workItemId);
  await rm(path.join(itemRoot, "snapshot", "application.json"));
  await writeFile(
    path.join(itemRoot, "snapshot", "workflow.yaml"),
    "version: 1\nworkflow: { id: forged }\nstages:\n  - { id: forged-stage }\n",
    "utf8",
  );
  const projection = await readControlPlane(current.root, started.workItemId);
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  await assert.rejects(
    recoverControlPlane({ cwd: current.root, workItemId: started.workItemId }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_APPLICATION_SNAPSHOT_CHANGED",
  );
});

test("acquire rejects a locator whose real worktree escapes the repository", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "定位边界" } });
  const projection = await readControlPlane(current.root, started.workItemId);
  const locatorPath = path.join(path.dirname(projection.controlPlane), "locator.json");
  const locator = JSON.parse(await readFile(locatorPath, "utf8")) as Record<string, unknown>;
  const worktree = await worktreeFor(current.root, started.workItemId);
  const outside = path.join(path.dirname(current.root), `wspec-outside-${crypto.randomUUID()}`);
  await git(current.root, "worktree", "add", "-b", `outside-${crypto.randomUUID()}`, outside, "HEAD");
  const outsideItem = path.join(outside, ".wsspec", "work-items", started.workItemId);
  await mkdir(path.dirname(outsideItem), { recursive: true });
  await cp(path.join(worktree, ".wsspec", "work-items", started.workItemId), outsideItem, { recursive: true });
  await writeFile(locatorPath, `${JSON.stringify({ ...locator, worktree: path.relative(current.root, outside) }, null, 2)}\n`, "utf8");

  await assert.rejects(
    current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_WORK_ITEM_LOCATION_INVALID",
  );
});

test("acquire atomically chooses one Step, Attempt and lease without Agent context", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "增加登录" } });
  const [first, second] = await Promise.all([
    current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex-a" }),
    current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex-b" }),
  ]);
  const actions = [first, second];
  assert.equal(actions.filter(({ action }) => action === "execute").length, 1);
  assert.equal(actions.filter(({ action }) => action === "blocked").length, 1);
  const workPackage = requireExecute(actions.find(({ action }) => action === "execute")!);
  assert.equal(workPackage.stepId, "intake");
  assert.equal("conversationHistory" in workPackage, false);
  assert.equal("prompt" in workPackage, false);
  assert.ok(workPackage.artifacts.every((artifact) => artifact.path === undefined || !artifact.path.includes("requirement.md")));
  const projection = await readControlPlane(current.root, started.workItemId);
  assert.equal(projection.claims.intake?.attemptId, workPackage.attemptId);
  assert.equal((projection.contexts.intake as { workPackage: WorkPackage }).workPackage.lease.token, workPackage.lease.token);
});

test("submit validates actual changes, is idempotent, and rejects a replaced Attempt", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "增加登录" } });
  const first = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const result = completedResult(first);
  const next = await submitPackage(current, first, result);
  assert.equal(requireExecute(next).stepId, "explore");
  assert.deepEqual(await submitPackage(current, first, result), next);
  const worktree = await worktreeFor(current.root, started.workItemId);
  assert.deepEqual(await current.app.submit({
    root: worktree,
    workItemId: first.workItemId,
    stepId: first.stepId,
    attemptId: first.attemptId,
    leaseToken: first.lease.token,
    result,
  }), next);

  const expiring = await fixture();
  const expiringStarted = await expiring.app.start({ root: expiring.root, source: { type: "prompt", text: "过期" } });
  const stale = requireExecute(await expiring.app.acquire({ root: expiring.root, workItemId: expiringStarted.workItemId, actor: "codex-a" }));
  expiring.setNow("2026-08-17T04:01:01.000Z");
  const replacement = requireExecute(await expiring.app.acquire({ root: expiring.root, workItemId: expiringStarted.workItemId, actor: "codex-b" }));
  assert.notEqual(replacement.attemptId, stale.attemptId);
  await assert.rejects(
    submitPackage(expiring, stale),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_ATTEMPT_NOT_ACTIVE",
  );
});

test("submit scopes modifiedFiles to the active Attempt", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "分步修改" } });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  await writeFile(path.join(worktree, "first.txt"), "first attempt\n", "utf8");
  const explore = requireExecute(await submitPackage(current, intake, { ...completedResult(intake), modifiedFiles: ["first.txt"] }));

  await writeFile(path.join(worktree, "second.txt"), "second attempt\n", "utf8");
  const exploration = await writeArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: explore,
    artifactType: "exploration-report",
    body: "# Exploration\n\nRepository facts.\n",
  });
  const next = await submitPackage(current, explore, {
    ...completedResult(explore, [exploration]),
    modifiedFiles: ["second.txt"],
  });
  assert.equal(requireExecute(next).stepId, "clarify");
});

test("submit rejects Artifacts not declared by the Step output contract", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "输出契约" } });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const injected = await writeArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: intake,
    artifactType: "exploration-report",
    body: "Injected output.\n",
  });

  await assert.rejects(
    submitPackage(current, intake, completedResult(intake, [...intake.requiredOutputs, injected])),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_UNDECLARED_ARTIFACT",
  );
});

test("submit preserves the optional mediaType contract for verified Artifacts", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "可选 media type" } });
  const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const explore = requireExecute(await submitPackage(current, intake));
  const worktree = await worktreeFor(current.root, started.workItemId);
  const { mediaType: _mediaType, ...exploration } = await writeArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: explore,
    artifactType: "exploration-report",
    body: "# Exploration\n\nRepository facts.\n",
  });

  const next = await submitPackage(current, explore, completedResult(explore, [exploration]));

  assert.equal(requireExecute(next).stepId, "clarify");
});

test("a failed Submit retries the same Step before dependent Steps can advance", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "失败重试" } });
  const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const failed = await submitPackage(current, intake, {
    ...completedResult(intake, []),
    status: "failed",
    summary: "capture failed",
  });
  assert.equal(failed.action, "blocked");
  const retried = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  assert.equal(retried.stepId, intake.stepId);
  assert.notEqual(retried.attemptId, intake.attemptId);
});

test("failed Submit stops after the snapshotted retry limit", async () => {
  const current = await fixture();
  await writeFile(path.join(current.root, ".wsspec", "config.yaml"), "version: 1\nruntime: { claimTtlSeconds: 60, maxStageRetries: 0 }\n", "utf8");
  await git(current.root, "add", ".wsspec/config.yaml");
  await git(current.root, "commit", "-m", "test: disable retries");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "不重试" } });
  const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const failed = await submitPackage(current, intake, {
    ...completedResult(intake, []),
    status: "failed",
    summary: "capture failed",
  });
  assert.equal(failed.action, "blocked");
  if (failed.action !== "blocked") throw new Error("expected blocked action");
  assert.equal(failed.problems[0]?.retryable, false);

  const exhausted = await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" });
  assert.equal(exhausted.action, "blocked");
  if (exhausted.action !== "blocked") throw new Error("expected blocked action");
  assert.equal(exhausted.problems[0]?.code, "WSSPEC_STEP_RETRY_EXHAUSTED");
  assert.equal(exhausted.problems[0]?.retryable, false);
});

test("documentation submit rejects a real Git diff outside the resolved documentation scope", async () => {
  const current = await fixture();
  const started = await current.app.start({
    root: current.root,
    source: { type: "prompt", text: "更新说明" },
    workflowRef: "builtin://workflows/documentation-delivery",
  });
  const workPackage = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const worktree = await worktreeFor(current.root, started.workItemId);
  await mkdir(path.join(worktree, "src"), { recursive: true });
  await writeFile(path.join(worktree, "src", "feature.ts"), "export const changed = true;\n", "utf8");
  const result = { ...completedResult(workPackage), modifiedFiles: ["src/feature.ts"] };
  await assert.rejects(
    submitPackage(current, workPackage, result),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION",
  );
});

test("decide uses the TTY approval boundary and returns the next AgentAction", async () => {
  const current = await fixture();
  const { started, awaiting } = await prepareApproval(current);
  const next = await current.app.decide({
    kind: "approval",
    root: current.root,
    workItemId: started.workItemId,
    requestId: awaiting.approval.requestId,
    decision: "approved",
    expectedDigest: awaiting.approval.digest,
    actor: "reviewer",
  });
  assert.equal(requireExecute(next).stepId, "design");
});

test("decide rechecks the caller digest after acquiring the control-plane owner lock", async () => {
  const current = await fixture();
  const { started, awaiting } = await prepareApproval(current);
  const projection = await readControlPlane(current.root, started.workItemId);
  let deciding: Promise<AgentAction> | undefined;
  await withControlPlaneLock(projection.controlPlane, async () => {
    deciding = current.app.decide({
      kind: "approval",
      root: current.root,
      workItemId: started.workItemId,
      requestId: awaiting.approval.requestId,
      decision: "approved",
      expectedDigest: awaiting.approval.digest,
      actor: "reviewer",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const changed = await readControlPlane(current.root, started.workItemId);
    changed.approvals[awaiting.approval.requestId] = {
      ...changed.approvals[awaiting.approval.requestId]!,
      contentHash: `sha256:${"0".repeat(64)}`,
    };
    await writeProjection(changed);
  });
  assert.ok(deciding);
  await assert.rejects(
    deciding,
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_APPROVAL_DIGEST_MISMATCH",
  );
});

test("approval binds an Artifact by declared type instead of its filename", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "审批别名" }, profile: "standard" });
  const intake = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }));
  const explore = requireExecute(await submitPackage(current, intake));
  const worktree = await worktreeFor(current.root, started.workItemId);
  const exploration = await writeArtifact({ worktree, workItemId: started.workItemId, workPackage: explore, artifactType: "exploration-report", body: "# Exploration\n\nRepository facts.\n" });
  const clarify = requireExecute(await submitPackage(current, explore, completedResult(explore, [exploration])));
  const body = [
    "# 规格", "", "## 目标与背景", "目标", "## 范围", "范围", "## 需求", "需求",
    "## 验收条件", "条件", "## 约束", "约束", "## 排除项", "无", "## 开放问题", "无", "",
  ].join("\n");
  const specification = await writeArtifact({
    worktree,
    workItemId: started.workItemId,
    workPackage: clarify,
    artifactType: "specification",
    filename: "proposal.md",
    body,
  });

  const action = await submitPackage(current, clarify, completedResult(clarify, [specification]));
  assert.equal(action.action, "await_approval");
});

test("rejected or expired approval returns a replacement execution action", async () => {
  const rejected = await fixture();
  const rejectedApproval = await prepareApproval(rejected);
  const rejectedNext = requireExecute(await rejected.app.decide({
    kind: "approval",
    root: rejected.root,
    workItemId: rejectedApproval.started.workItemId,
    requestId: rejectedApproval.awaiting.approval.requestId,
    decision: "rejected",
    expectedDigest: rejectedApproval.awaiting.approval.digest,
    actor: "reviewer",
  }));
  assert.equal(rejectedNext.stepId, "clarify");
  assert.notEqual(rejectedNext.attemptId, rejectedApproval.clarify.attemptId);

  const expired = await fixture();
  const expiredApproval = await prepareApproval(expired);
  await writeFile(path.join(expiredApproval.worktree, "README.md"), "changed during approval\n", "utf8");
  const expiredNext = requireExecute(await expired.app.decide({
    kind: "approval",
    root: expired.root,
    workItemId: expiredApproval.started.workItemId,
    requestId: expiredApproval.awaiting.approval.requestId,
    decision: "approved",
    expectedDigest: expiredApproval.awaiting.approval.digest,
    actor: "reviewer",
  }));
  assert.equal(expiredNext.stepId, "clarify");
  assert.notEqual(expiredNext.attemptId, expiredApproval.clarify.attemptId);
});

test("explicit recovery resumes an interrupted Attempt from any Git worktree", async () => {
  const current = await fixture();
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "恢复" } });
  const interrupted = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex-a" }));
  const observer = path.join(path.dirname(current.root), `wspec-observer-${crypto.randomUUID()}`);
  await git(current.root, "worktree", "add", "-b", `observer-${crypto.randomUUID()}`, observer, "HEAD");

  await recoverControlPlane({ cwd: observer, workItemId: started.workItemId });
  const view = await current.app.inspect({ root: observer, workItemId: started.workItemId });
  assert.equal(view.workItemId, started.workItemId);
  assert.equal(view.workflowRef, "builtin://workflows/feature-delivery");
  const resumed = requireExecute(await current.app.acquire({ root: observer, workItemId: started.workItemId, actor: "codex-b" }));
  assert.equal(resumed.stepId, interrupted.stepId);
  assert.notEqual(resumed.attemptId, interrupted.attemptId);
});

test("inspect preserves an unexpired active lease", async () => {
  const current = await fixture();
  current.setNow("2099-08-17T04:00:00.000Z");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "只读检查" } });
  const active = requireExecute(await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex-a" }));

  const view = await current.app.inspect({ root: current.root, workItemId: started.workItemId });
  assert.equal(view.status, "active");
  const projection = await readControlPlane(current.root, started.workItemId);
  assert.equal(projection.claims[active.stepId]?.attemptId, active.attemptId);
  const second = await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex-b" });
  assert.equal(second.action, "blocked");
});

test("inspect from a second Git worktree leaves a pending approval and event history byte-for-byte unchanged", async () => {
  const current = await fixture();
  const { started, awaiting } = await prepareApproval(current);
  const before = await readControlPlane(current.root, started.workItemId);
  const runtimePath = path.join(before.controlPlane, "runtime.json");
  const eventsPath = path.join(before.controlPlane, "events.jsonl");
  const [runtimeBytes, eventBytes] = await Promise.all([
    readFile(runtimePath),
    readFile(eventsPath),
  ]);
  const secondRoot = path.join(os.tmpdir(), `wsspec-inspect-host-${crypto.randomUUID()}`);
  await git(current.root, "worktree", "add", "-b", `inspect-${crypto.randomUUID()}`, secondRoot);

  const view = await current.app.inspect({ root: secondRoot, workItemId: started.workItemId });

  const after = await readControlPlane(secondRoot, started.workItemId);
  assert.equal(view.status, "awaiting_approval");
  assert.equal(after.approvals[awaiting.approval.requestId]?.status, "pending");
  assert.deepEqual(after, before);
  assert.deepEqual(await readFile(runtimePath), runtimeBytes);
  assert.deepEqual(await readFile(eventsPath), eventBytes);
});

test("recovery preserves a durable pending approval across projection damage, worktrees, and retries", async () => {
  const current = await fixture();
  const { started, awaiting, clarify } = await prepareApproval(current);
  const before = await readControlPlane(current.root, started.workItemId);
  const runtimePath = path.join(before.controlPlane, "runtime.json");
  const eventsPath = path.join(before.controlPlane, "events.jsonl");
  const eventBytes = await readFile(eventsPath);
  await writeFile(runtimePath, "not-json\n", "utf8");
  const secondRoot = path.join(os.tmpdir(), `wsspec-recover-host-${crypto.randomUUID()}`);
  await git(current.root, "worktree", "add", "-b", `recover-${crypto.randomUUID()}`, secondRoot);

  const first = await recoverControlPlane({ cwd: secondRoot, workItemId: started.workItemId });

  assert.deepEqual(first, before);
  assert.equal(first.workItem.status, "awaiting_approval");
  assert.equal(first.stages[clarify.stepId]?.status, "awaiting_approval");
  assert.equal(first.approvals[awaiting.approval.requestId]?.status, "pending");
  assert.deepEqual(await readFile(eventsPath), eventBytes);
  const recoveredRuntimeBytes = await readFile(runtimePath);

  const repeated = await recoverControlPlane({ cwd: current.root, workItemId: started.workItemId });

  assert.deepEqual(repeated, before);
  assert.deepEqual(await readFile(runtimePath), recoveredRuntimeBytes);
  assert.deepEqual(await readFile(eventsPath), eventBytes);
});

test("recovery of an unrelated stale claim does not expire a durable pending approval", async () => {
  const current = await fixture();
  const { started, awaiting, clarify } = await prepareApproval(current);
  const staleClaim = {
    stageId: "design",
    attemptId: "attempt-stale",
    claimToken: "stale-token",
    actor: "interrupted-agent",
    claimedAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-17T00:01:00.000Z",
    inputWorkspaceTreeDigest: "sha256:stale",
    allowedPaths: ["**"],
    workspaceSnapshot: [],
  };
  await mutateControlPlane({
    cwd: current.root,
    workItemId: started.workItemId,
    eventType: "claim.created",
    idempotencyKey: "test-stale-claim",
    stageId: staleClaim.stageId,
    attemptId: staleClaim.attemptId,
    operationInput: staleClaim,
    mutate: (projection) => ({
      projection: {
        ...projection,
        stages: { ...projection.stages, [staleClaim.stageId]: { status: "claimed" } },
        claims: { ...projection.claims, [staleClaim.stageId]: staleClaim },
      },
      value: null,
    }),
  });
  const before = await readControlPlane(current.root, started.workItemId);

  const recovered = await recoverControlPlane({ cwd: current.root, workItemId: started.workItemId });

  assert.equal(recovered.lastSequence, before.lastSequence + 1);
  assert.equal(recovered.workItem.status, "awaiting_approval");
  assert.equal(recovered.stages[clarify.stepId]?.status, "awaiting_approval");
  assert.equal(recovered.approvals[awaiting.approval.requestId]?.status, "pending");
  assert.equal(recovered.stages[staleClaim.stageId]?.status, "ready");
  assert.equal(recovered.claims[staleClaim.stageId], undefined);
});

test("start assembles Task 6 ProjectGatePolicy from project configuration", async () => {
  const current = await fixture();
  const config = {
    version: 1,
    quality: {
      gates: {
        test: { command: ["npm", "test"], cwd: "worktree", timeoutSeconds: 60, required: true, evidence: "trusted" },
      },
    },
  };
  await writeFile(path.join(current.root, ".wsspec", "config.yaml"), `${JSON.stringify(config)}\n`, "utf8");
  await git(current.root, "add", ".wsspec/config.yaml");
  await git(current.root, "commit", "-m", "test: configure project Gate");
  const started = await current.app.start({ root: current.root, source: { type: "prompt", text: "Gate" }, profile: "standard" });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const snapshot = JSON.parse(await readFile(path.join(worktree, ".wsspec", "work-items", started.workItemId, "snapshot", "application.json"), "utf8")) as { gatePolicy: unknown };
  assert.deepEqual(snapshot.gatePolicy, { requiredGateIds: ["test"], configuredGateIds: ["test"] });
});

test("explicit recovery rebuilds a terminal control.close archive before read-only inspect", async () => {
  const current = await fixture();
  const started = await current.app.start({
    root: current.root,
    source: { type: "prompt", text: "关闭工作流" },
    workflowRef: "builtin://workflows/documentation-delivery",
    profile: "quick",
  });
  const projection = await readControlPlane(current.root, started.workItemId);
  projection.stages = Object.fromEntries(Object.keys(projection.stages).map((stepId) => [
    stepId,
    { status: stepId === "close" ? "ready" : "succeeded" },
  ]));
  await writeProjection(projection);

  const action = await current.app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" });
  assert.equal(action.action, "completed");
  await writeFile(path.join(projection.controlPlane, "runtime.json"), "not-json\n", "utf8");

  await recoverControlPlane({ cwd: current.root, workItemId: started.workItemId });
  const inspected = await current.app.inspect({ root: current.root, workItemId: started.workItemId });
  assert.equal(inspected.status, "closed");
  const worktree = await worktreeFor(current.root, started.workItemId);
  await access(path.join(worktree, ".wsspec", "archive", started.workItemId, "audit.json"));
});
