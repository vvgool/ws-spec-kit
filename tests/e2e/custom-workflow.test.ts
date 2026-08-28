import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { runWorkflowCommand } from "../../src/adapters/cli/workflow.js";
import { createApplication } from "../../src/application/application.js";
import { resolveProjectWorkflowContext } from "../../src/application/start.js";
import type { WorkflowTrustSummary } from "../../src/workflow-package/types.js";
import { readControlPlane } from "../../src/storage/control-plane.js";
import { materializeWorkItem, type WorkItem } from "../../src/storage/work-items.js";
import { loadWorkflowPackage } from "../../src/workflow-package/loader.js";
import { createGitRepository, git } from "../integration/helpers/git.js";

interface CliResult { code: number | null; stdout: string; stderr: string }
interface CliEnvelope<T> { ok: boolean; result?: T; error?: { code: string; message: string; details?: unknown } }

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures");
const workflowFixture = path.join(fixtureRoot, "workflows", "custom-delivery");
const skillFixtures = path.join(fixtureRoot, "skills");

function startCli(cwd: string, args: string[], home: string): Promise<CliResult> {
  const child = spawn(process.execPath, [
    "--import",
    path.join(repositoryRoot, "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(repositoryRoot, "src", "cli", "main.ts"),
    ...args,
  ], {
    cwd,
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function cli<T>(cwd: string, args: string[], home: string): Promise<{ process: CliResult; envelope: CliEnvelope<T> }> {
  const process = await startCli(cwd, args, home);
  assert.equal(process.stderr, "", args.join(" "));
  return { process, envelope: JSON.parse(process.stdout) as CliEnvelope<T> };
}

interface CustomProject {
  root: string;
  home: string;
  workflowRef: string;
  workflowDirectory: string;
  globalDirectory: string;
}

async function installCustomProject(mode: "ejected" | "external" = "ejected"): Promise<CustomProject> {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-custom-home-"));
  const initialized = await cli(root, ["init"], home);
  assert.equal(initialized.process.code, 0);

  const packageName = mode === "ejected" ? "custom-delivery" : "installed-delivery";
  const workflowRef = `project://workflows/${packageName}`;
  const workflowDirectory = path.join(root, ".wsspec", "workflows", packageName);
  if (mode === "ejected") {
    const ejected = await cli<{ target: string }>(root, [
      "workflow", "eject", "builtin://workflows/feature-delivery", workflowDirectory,
    ], home);
    assert.equal(ejected.process.code, 0);
    assert.equal(ejected.envelope.result?.target, workflowDirectory);
  } else {
    await mkdir(path.dirname(workflowDirectory), { recursive: true });
  }
  await cp(workflowFixture, workflowDirectory, { recursive: true, force: true });
  await cp(
    path.join(skillFixtures, "package-security-review"),
    path.join(workflowDirectory, "skills", "security-review"),
    { recursive: true },
  );
  await cp(
    path.join(skillFixtures, "project-security-review"),
    path.join(root, ".wsspec", "skills", "project-security-review"),
    { recursive: true },
  );
  const globalDirectory = path.join(home, ".agents", "skills", "global-security-review");
  await cp(path.join(skillFixtures, "global-security-review"), globalDirectory, { recursive: true });
  await git(root, "add", ".wsspec");
  await git(root, "commit", "-m", `test: install ${mode} custom Workflow`);
  return { root, home, workflowRef, workflowDirectory, globalDirectory };
}

function application(current: CustomProject) {
  return createApplication({
    provider: "codex",
    home: current.home,
    terminal: { isTTY: true },
    workflowTrust: { interactive: true, actor: "release-reviewer" },
  });
}

async function requestTrust(current: CustomProject, ref = current.workflowRef): Promise<WorkflowTrustSummary> {
  const result = await runWorkflowCommand({
    root: current.root,
    home: current.home,
    provider: "codex",
    argv: ["use", ref, "--provider", "codex"],
    interactive: true,
    actor: "release-reviewer",
  }) as { status: string; trust: WorkflowTrustSummary };
  assert.equal(result.status, "blocked");
  return result.trust;
}

async function decideTrust(current: CustomProject, summary: WorkflowTrustSummary, decision: "trusted" | "rejected") {
  return application(current).decide({
    kind: "workflow_trust",
    root: current.root,
    requestId: summary.requestId,
    decision,
    expectedPackageDigest: summary.packageDigest,
    expectedCapabilityDigest: summary.capabilityDigest,
    actor: "release-reviewer",
  });
}

async function worktreeFor(root: string, workItemId: string): Promise<string> {
  const projection = await readControlPlane(root, workItemId);
  const workItemRoot = path.dirname(projection.controlPlane);
  const locator = JSON.parse(await readFile(path.join(workItemRoot, "locator.json"), "utf8")) as { worktree: string; materialized?: boolean };
  if (locator.materialized === false) {
    const item = parse(await readFile(path.join(workItemRoot, "authority", "work-item.yaml"), "utf8")) as WorkItem;
    await materializeWorkItem({ root, item });
  }
  return path.join(root, locator.worktree);
}

test("公开 CLI 串联 Workflow 自定义与四类 Skill Resolver，并记录 Global 主项、fallback 和歧义", async () => {
  const current = await installCustomProject();

  const listed = await cli<{ workflows: Array<{ ref: string }> }>(current.root, ["workflow", "list"], current.home);
  assert.equal(listed.process.code, 0);
  assert.deepEqual(listed.envelope.result?.workflows.map(({ ref }) => ref), [
    "builtin://workflows/documentation-delivery",
    "builtin://workflows/feature-delivery",
  ]);
  const shown = await cli<{ workflow: { ref: string; id: string } }>(current.root, ["workflow", "show", current.workflowRef], current.home);
  assert.equal(shown.process.code, 0);
  assert.deepEqual({ ref: shown.envelope.result?.workflow.ref, id: shown.envelope.result?.workflow.id }, {
    ref: current.workflowRef,
    id: "custom-delivery",
  });
  const validated = await cli<{ valid: boolean }>(current.root, ["workflow", "validate", current.workflowRef, "--provider", "codex"], current.home);
  assert.equal(validated.process.code, 0);
  assert.equal(validated.envelope.result?.valid, true);

  const pkg = await loadWorkflowPackage({ root: current.root, ref: current.workflowRef });
  const primary = await resolveProjectWorkflowContext({ root: current.root, pkg, provider: "codex", home: current.home });
  const expectedSources = new Map([
    ["package://skills/security-review", "package"],
    ["project://skills/project-security-review", "project"],
    ["global://global-security-review", "global"],
    ["builtin://skills/code-review", "builtin"],
  ]);
  for (const [ref, source] of expectedSources) {
    assert.equal(primary.skills.find(({ requestedRef }) => requestedRef === ref)?.source, source, ref);
  }
  assert.equal(primary.skills.find(({ requestedRef }) => requestedRef === "global://global-security-review")?.usedFallback, false);

  const duplicate = path.join(current.home, ".cursor", "skills", "global-security-review");
  await cp(current.globalDirectory, duplicate, { recursive: true });
  const deduplicated = await resolveProjectWorkflowContext({ root: current.root, pkg, provider: "cursor", home: current.home });
  const global = deduplicated.skills.find(({ requestedRef }) => requestedRef === "global://global-security-review");
  assert.equal(global?.usedFallback, false);
  assert.equal(global?.candidates.length, 2);
  assert.equal(new Set(global?.candidates.map(({ digest }) => digest)).size, 1);
  assert.equal(deduplicated.skills.filter(({ requestedRef }) => requestedRef === "global://global-security-review").length, 1);

  await writeFile(path.join(duplicate, "SKILL.md"), "# 冲突的 Global 安全审查\n", "utf8");
  const ambiguous = await cli(current.root, ["workflow", "validate", current.workflowRef, "--provider", "cursor"], current.home);
  assert.equal(ambiguous.process.code, 1);
  assert.equal(ambiguous.envelope.error?.code, "WSSPEC_SKILL_AMBIGUOUS");

  await rm(path.join(current.home, ".agents", "skills", "global-security-review"), { recursive: true });
  await rm(path.join(current.home, ".cursor", "skills", "global-security-review"), { recursive: true });
  const fallbackValidation = await cli<{ valid: boolean }>(current.root, ["workflow", "validate", current.workflowRef, "--provider", "cursor"], current.home);
  assert.equal(fallbackValidation.process.code, 0);
  const fallback = await resolveProjectWorkflowContext({ root: current.root, pkg, provider: "cursor", home: current.home });
  const selected = fallback.skills.find(({ requestedRef }) => requestedRef === "global://global-security-review");
  assert.equal(selected?.usedFallback, true);
  assert.equal(selected?.ref, "builtin://skills/code-review");
});

test("活动 Work Item 固定编译合同与 Locks，并在绑定 Step 使用锁定 Skill", async () => {
  const current = await installCustomProject();
  const beforeSelection = await readFile(path.join(current.root, ".wsspec", "workflow.yaml"), "utf8");
  const nonInteractive = await cli(current.root, ["workflow", "use", current.workflowRef, "--provider", "codex"], current.home);
  assert.equal(nonInteractive.process.code, 1);
  assert.equal(nonInteractive.envelope.error?.code, "WSSPEC_WORKFLOW_TRUST_REQUIRED");
  assert.equal(await readFile(path.join(current.root, ".wsspec", "workflow.yaml"), "utf8"), beforeSelection);

  const summary = await requestTrust(current);
  assert.equal(summary.packageRef, current.workflowRef);
  assert.ok(summary.fileDigests.length > 5);
  assert.ok(summary.fileDigests.every(({ path: filename }) => !path.isAbsolute(filename)));
  assert.deepEqual(summary.skillDigests.map(({ ref }) => ref), ["package://skills/security-review"]);
  assert.ok(summary.capabilities.includes("issue-update"));
  assert.ok(summary.capabilities.includes("connector-execution"));
  assert.equal((await decideTrust(current, summary, "trusted")).action, "blocked");

  const selected = await cli<{ status: string; workflowRef: string }>(current.root, ["workflow", "use", current.workflowRef, "--provider", "codex"], current.home);
  assert.equal(selected.process.code, 0);
  assert.deepEqual({ status: selected.envelope.result?.status, ref: selected.envelope.result?.workflowRef }, {
    status: "selected",
    ref: current.workflowRef,
  });
  const app = application(current);
  const started = await app.start({
    root: current.root,
    source: { type: "prompt", text: "验证项目自定义 Workflow 的快照不变性" },
    workflowRef: current.workflowRef,
    profile: "quick",
  });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const snapshotRoot = path.join(worktree, ".wsspec", "work-items", started.workItemId, "snapshot");
  const applicationPath = path.join(snapshotRoot, "application.json");
  const snapshotPaths = [
    applicationPath,
    path.join(snapshotRoot, "config.yaml"),
    path.join(snapshotRoot, "skill.lock.json"),
    path.join(snapshotRoot, "workflow.lock.json"),
  ];
  const snapshotBefore = await Promise.all(snapshotPaths.map((file) => readFile(file, "utf8")));
  const applicationBefore = snapshotBefore[0]!;
  assert.deepEqual((await readdir(snapshotRoot)).sort(), [
    "application.json",
    "config.yaml",
    "skill.lock.json",
    "workflow.lock.json",
  ]);
  const snapshot = JSON.parse(applicationBefore) as {
    workflowRef: string;
    packageDigest: string;
    skillLock: { skills: Array<{
      requested: string;
      digest?: string;
      selection: string;
      candidates: unknown[];
      selected: { ref: string; digest: string };
    }> };
    profiles: { quick: { steps: Array<{ id: string; authorizationRequired: boolean }> } };
  };
  assert.equal(snapshot.workflowRef, current.workflowRef);
  assert.equal(snapshot.skillLock.skills.find(({ requested }) => requested === "global://global-security-review")?.selection, "primary");
  assert.equal(snapshot.profiles.quick.steps.find(({ id }) => id === "update-issue")?.authorizationRequired, true);
  assert.deepEqual((await readControlPlane(current.root, started.workItemId)).externalActions, {});

  const originalPackage = await loadWorkflowPackage({ root: current.root, ref: current.workflowRef });
  const originalContext = await resolveProjectWorkflowContext({ root: current.root, pkg: originalPackage, provider: "codex", home: current.home });
  const originalPackageSkill = originalContext.skills.find(({ requestedRef }) => requestedRef === "package://skills/security-review");
  const movedDirectory = path.join(current.root, ".wsspec", "workflows", "moved-delivery");
  await rename(current.workflowDirectory, movedDirectory);
  const movedRef = "project://workflows/moved-delivery";
  const movedPackage = await loadWorkflowPackage({ root: current.root, ref: movedRef });
  const movedContext = await resolveProjectWorkflowContext({ root: current.root, pkg: movedPackage, provider: "codex", home: current.home });
  const movedPackageSkill = movedContext.skills.find(({ requestedRef }) => requestedRef === "package://skills/security-review");
  assert.equal(movedPackage.contentDigest, originalPackage.contentDigest);
  assert.equal(movedPackageSkill?.digest, originalPackageSkill?.digest);
  assert.notEqual(movedPackageSkill?.entrypoint, originalPackageSkill?.entrypoint);
  const movedUse = await cli<{ status: string }>(current.root, ["workflow", "use", movedRef, "--provider", "codex"], current.home);
  assert.equal(movedUse.process.code, 0);
  assert.equal(movedUse.envelope.result?.status, "selected");

  await writeFile(path.join(movedDirectory, "workflow.yaml"), `${await readFile(path.join(movedDirectory, "workflow.yaml"), "utf8")}\n# 项目后续修改\n`, "utf8");
  await writeFile(path.join(current.root, ".wsspec", "skills", "project-security-review", "SKILL.md"), "# 已修改的 Project Skill\n", "utf8");
  const acquired = await app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" });
  assert.equal(acquired.action, "execute");
  if (acquired.action === "execute") {
    assert.equal(acquired.workPackage.stepId, "security-review");
    assert.deepEqual(acquired.workPackage.skills.map(({ ref }) => ref), [
      "package://skills/security-review",
      "project://skills/project-security-review",
      "global://global-security-review",
      "builtin://skills/code-review",
    ]);
    for (const descriptor of acquired.workPackage.skills) {
      const locked = snapshot.skillLock.skills.find(({ selected }) => selected.ref === descriptor.ref);
      assert.equal(descriptor.digest, locked?.selected.digest, descriptor.ref);
    }
    assert.ok(acquired.workPackage.constraints.forbiddenActions.includes("unapproved-external-write"));
  }
  assert.deepEqual(await Promise.all(snapshotPaths.map((file) => readFile(file, "utf8"))), snapshotBefore);
});

test("活动 Work Item 的 Global 主项漂移或消失都 fail closed，且不会静默改选 fallback", async () => {
  const current = await installCustomProject();
  const summary = await requestTrust(current);
  await decideTrust(current, summary, "trusted");
  const app = application(current);
  const started = await app.start({
    root: current.root,
    source: { type: "prompt", text: "Global Skill 漂移后不得静默降级" },
    workflowRef: current.workflowRef,
    profile: "quick",
  });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const lockPath = path.join(worktree, ".wsspec", "work-items", started.workItemId, "snapshot", "skill.lock.json");
  const primaryLock = await readFile(lockPath, "utf8");

  await writeFile(path.join(current.globalDirectory, "SKILL.md"), "# 已漂移的 Global Skill\n", "utf8");
  await assert.rejects(
    app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_SKILL_LOCK_CHANGED",
  );
  assert.equal(await readFile(lockPath, "utf8"), primaryLock);

  await rm(current.globalDirectory, { recursive: true });
  await assert.rejects(
    app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_SKILL_LOCK_CHANGED",
  );
  assert.equal(await readFile(lockPath, "utf8"), primaryLock);
  const lock = JSON.parse(primaryLock) as { skills: Array<{ requested: string; selection: string; selected: { ref: string } }> };
  const global = lock.skills.find(({ requested }) => requested === "global://global-security-review");
  assert.equal(global?.selection, "primary");
  assert.equal(global?.selected.ref, "global://global-security-review");
});

test("活动 Work Item 的 Project Workflow 或 Skill 来源漂移时 fail closed", async (t) => {
  for (const scenario of [
    {
      name: "Workflow",
      mutate: async (worktree: string) => writeFile(
        path.join(worktree, ".wsspec", "workflows", "custom-delivery", "workflow.yaml"),
        "version: 1\nworkflow: { id: forged }\n",
        "utf8",
      ),
      code: "WSSPEC_WORKFLOW_SNAPSHOT_CHANGED",
    },
    {
      name: "Project Skill",
      mutate: async (worktree: string) => writeFile(
        path.join(worktree, ".wsspec", "skills", "project-security-review", "SKILL.md"),
        "# 已漂移的 Project Skill\n",
        "utf8",
      ),
      code: "WSSPEC_SKILL_LOCK_CHANGED",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const current = await installCustomProject();
      await decideTrust(current, await requestTrust(current), "trusted");
      const app = application(current);
      const started = await app.start({
        root: current.root,
        source: { type: "prompt", text: `${scenario.name} 来源漂移` },
        workflowRef: current.workflowRef,
        profile: "quick",
      });
      await scenario.mutate(await worktreeFor(current.root, started.workItemId));

      await assert.rejects(
        app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" }),
        (error: unknown) => error instanceof Error && "code" in error
          && (error as Error & { code: string }).code === scenario.code,
      );
    });
  }
});

test("Workflow 信任不能替代生产 Connector 的独立外部写入授权", async () => {
  const current = await installCustomProject();
  const summary = await requestTrust(current);
  await decideTrust(current, summary, "trusted");

  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), "wspec-custom-github-"));
  const gh = path.join(remoteRoot, "gh");
  const statePath = path.join(remoteRoot, "github-state.json");
  await cp(path.join(fixtureRoot, "connectors", "github", "gh"), gh);
  await chmod(gh, 0o700);
  await cp(path.join(fixtureRoot, "connectors", "github", "issue.json"), statePath);
  const connectorRuntime = {
    executables: { git: "git", gh, glab: "glab", "lark-cli": "lark-cli" },
    environments: { github: { HOME: remoteRoot, GH_CONFIG_DIR: remoteRoot } },
    larkIdentity: "user" as const,
  };
  const app = createApplication({
    provider: "codex",
    home: current.home,
    terminal: { isTTY: true },
    workflowTrust: { interactive: true, actor: "release-reviewer" },
    connectorRuntime,
  });
  const started = await app.start({
    root: current.root,
    source: { type: "issue", provider: "github", id: "https://github.example.com/acme/widget/issues/7" },
    workflowRef: current.workflowRef,
    profile: "quick",
  });
  const acquired = await app.acquire({ root: current.root, workItemId: started.workItemId, actor: "codex" });
  assert.equal(acquired.action, "execute");
  if (acquired.action !== "execute") throw new Error("authorization-probe 未进入 execute");
  assert.equal(acquired.workPackage.stepId, "authorization-probe");

  const before = JSON.parse(await readFile(statePath, "utf8")) as { body: string };
  const result = {
    version: 1 as const,
    status: "completed" as const,
    summary: "请求更新 Fixture Issue",
    modifiedFiles: [],
    artifacts: [],
    commands: [],
    evidence: [],
    externalWrites: [{
      kind: "external-action" as const,
      provider: "github",
      action: "issue.update" as const,
      target: { kind: "issue" as const, stableId: "github:I_fixture_github_7" },
      payload: {
        target: { host: "github.example.com", owner: "acme", repo: "widget", number: 7 },
        action: { type: "body", body: "Custom Workflow fixture approved" },
      },
      sideEffects: ["更新 Fixture Issue 正文"],
    }],
    remainingRisks: [{ risk: "fixture-only" }],
  };
  const submit = () => app.submit({
    root: current.root,
    workItemId: started.workItemId,
    stepId: acquired.workPackage.stepId,
    attemptId: acquired.workPackage.attemptId,
    leaseToken: acquired.workPackage.lease.token,
    result,
  });
  const pending = await submit();
  assert.equal(pending.action, "await_approval");
  if (pending.action !== "await_approval" || pending.approval.kind !== "external_action") {
    throw new Error("issue.update 未进入独立外部授权");
  }
  assert.equal((JSON.parse(await readFile(statePath, "utf8")) as { body: string }).body, before.body);
  assert.equal((await readdir(remoteRoot)).includes("timeline.ndjson"), false);
  assert.equal((await readControlPlane(current.root, started.workItemId)).externalActions[pending.approval.requestId]?.status, "prepared");

  const approved = await app.decide({
    kind: "external_action",
    root: current.root,
    workItemId: started.workItemId,
    requestId: pending.approval.requestId,
    decision: "approved",
    expectedDigest: pending.approval.digest,
    actor: "release-reviewer",
  });
  assert.equal(approved.action, "execute");
  assert.equal((JSON.parse(await readFile(statePath, "utf8")) as { body: string }).body, before.body);

  await submit();
  assert.equal((JSON.parse(await readFile(statePath, "utf8")) as { body: string }).body, "Custom Workflow fixture approved");
  assert.equal((await readControlPlane(current.root, started.workItemId)).externalActions[pending.approval.requestId]?.status, "verified");
});

test("非 Builtin Package 的拒绝、复用、文件变化、能力升级与搬迁都绑定内容摘要", async () => {
  const current = await installCustomProject("external");
  const selectionPath = path.join(current.root, ".wsspec", "workflow.yaml");
  const selectionBefore = await readFile(selectionPath, "utf8");

  const nonInteractive = await cli(current.root, ["workflow", "use", current.workflowRef, "--provider", "codex"], current.home);
  assert.equal(nonInteractive.process.code, 1);
  assert.equal(nonInteractive.envelope.error?.code, "WSSPEC_WORKFLOW_TRUST_REQUIRED");
  assert.equal(await readFile(selectionPath, "utf8"), selectionBefore);
  const unattendedApplication = createApplication({ provider: "codex", home: current.home, terminal: { isTTY: false } });
  await assert.rejects(
    unattendedApplication.start({ root: current.root, source: { type: "prompt", text: "未确认不能启动" }, workflowRef: current.workflowRef, profile: "quick" }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_WORKFLOW_TRUST_REQUIRED",
  );
  assert.deepEqual(await readdir(path.join(current.root, ".worktrees")).catch(() => []), []);

  const rejectedSummary = await requestTrust(current);
  assert.equal(rejectedSummary.packageRef, current.workflowRef);
  assert.ok(rejectedSummary.fileDigests.some(({ path: filename }) => filename === "workflow.yaml"));
  assert.deepEqual(rejectedSummary.skillDigests.map(({ ref }) => ref), ["package://skills/security-review"]);
  assert.ok(rejectedSummary.capabilities.includes("git-commit"));
  assert.ok(rejectedSummary.capabilities.includes("issue-update"));
  await decideTrust(current, rejectedSummary, "rejected");
  const rejectedUse = await runWorkflowCommand({
    root: current.root,
    home: current.home,
    provider: "codex",
    argv: ["use", current.workflowRef, "--provider", "codex"],
    interactive: true,
    actor: "release-reviewer",
  }) as { status: string; problems: Array<{ code: string }> };
  assert.equal(rejectedUse.status, "blocked");
  assert.equal(rejectedUse.problems[0]?.code, "WSSPEC_WORKFLOW_TRUST_REJECTED");
  await assert.rejects(
    application(current).start({ root: current.root, source: { type: "prompt", text: "拒绝后不得启动" }, workflowRef: current.workflowRef, profile: "quick" }),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_WORKFLOW_TRUST_REJECTED",
  );

  const templates = path.join(current.workflowDirectory, "templates");
  await mkdir(templates, { recursive: true });
  await writeFile(path.join(templates, "review.md"), "# 新增普通模板文件\n", "utf8");
  const fileChanged = await requestTrust(current);
  assert.notEqual(fileChanged.packageDigest, rejectedSummary.packageDigest);
  assert.equal(fileChanged.capabilityDigest, rejectedSummary.capabilityDigest);
  await decideTrust(current, fileChanged, "trusted");
  const selected = await runWorkflowCommand({
    root: current.root,
    home: current.home,
    provider: "codex",
    argv: ["use", current.workflowRef, "--provider", "codex"],
    interactive: false,
  }) as { status: string };
  assert.equal(selected.status, "selected");

  const movedDirectory = path.join(current.root, ".wsspec", "workflows", "relocated-delivery");
  await rename(current.workflowDirectory, movedDirectory);
  const movedRef = "project://workflows/relocated-delivery";
  const moved = await runWorkflowCommand({
    root: current.root,
    home: current.home,
    provider: "codex",
    argv: ["use", movedRef, "--provider", "codex"],
    interactive: false,
  }) as { status: string };
  assert.equal(moved.status, "selected");

  await writeFile(path.join(movedDirectory, "templates", "policy.md"), "# 又一个普通文件\n", "utf8");
  const secondFileChange = await requestTrust(current, movedRef);
  assert.notEqual(secondFileChange.packageDigest, fileChanged.packageDigest);
  assert.equal(secondFileChange.capabilityDigest, fileChanged.capabilityDigest);
  await decideTrust(current, secondFileChange, "trusted");

  const manifestPath = path.join(movedDirectory, "manifest.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifest.replace(
    "capabilities: [agent-execution, command-execution, connector-execution, control-flow]",
    "capabilities: [agent-execution, command-execution, connector-execution, control-flow, external-write]",
  ), "utf8");
  const escalated = await requestTrust(current, movedRef);
  assert.notEqual(escalated.packageDigest, secondFileChange.packageDigest);
  assert.notEqual(escalated.capabilityDigest, secondFileChange.capabilityDigest);
  assert.ok(escalated.capabilities.includes("external-write"));
});

test("Global fallback 选择写入 Work Item 的 Skill Lock 决策记录", async () => {
  const current = await installCustomProject();
  const summary = await requestTrust(current);
  await decideTrust(current, summary, "trusted");
  await rm(current.globalDirectory, { recursive: true });

  const started = await application(current).start({
    root: current.root,
    source: { type: "prompt", text: "缺少 Global Skill 时使用显式 Builtin fallback" },
    workflowRef: current.workflowRef,
    profile: "quick",
  });
  const worktree = await worktreeFor(current.root, started.workItemId);
  const lockPath = path.join(worktree, ".wsspec", "work-items", started.workItemId, "snapshot", "skill.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    skills: Array<{
      requested: string;
      resolved: string;
      source: string;
      provider: string;
      candidates: unknown[];
      required: boolean;
      selection: string;
      selected: { ref: string; source: string; provider: string; rootId: string; digest: string };
      fallback?: { ref: string; source: string; rootId: string; digest: string };
    }>;
  };
  const decision = lock.skills.find(({ requested }) => requested === "global://global-security-review");
  assert.equal(decision?.requested, "global://global-security-review");
  assert.equal(decision?.resolved, "global://global-security-review");
  assert.equal(decision?.source, "global");
  assert.equal(decision?.provider, "codex");
  assert.deepEqual(decision?.candidates, []);
  assert.equal(decision?.required, true);
  assert.equal(decision?.selection, "fallback");
  assert.deepEqual({ ref: decision?.fallback?.ref, source: decision?.fallback?.source, rootId: decision?.fallback?.rootId }, {
    ref: "builtin://skills/code-review",
    source: "builtin",
    rootId: "builtin",
  });
  assert.match(decision?.fallback?.digest ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual({ ref: decision?.selected.ref, source: decision?.selected.source, provider: decision?.selected.provider, rootId: decision?.selected.rootId }, {
    ref: "builtin://skills/code-review",
    source: "builtin",
    provider: "codex",
    rootId: "builtin",
  });
  assert.equal(decision?.selected.digest, decision?.fallback?.digest);
});
