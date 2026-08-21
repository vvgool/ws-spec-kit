import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGithubIssue, writeGithubIssue } from "../../src/adapters/connectors/github-cli.js";
import { commitGitChanges } from "../../src/adapters/connectors/git-native.js";
import { readGitlabIssue, writeGitlabIssue } from "../../src/adapters/connectors/gitlab-cli.js";
import { publishKnowledge, readFeishuDocument } from "../../src/adapters/connectors/lark-cli.js";
import { runCommand } from "../../src/cli/commands/core.js";
import { createApplication, type ApplicationDependencies } from "../../src/application/application.js";
import type { ExternalActionExecutor } from "../../src/application/external-action.js";
import { loadApplicationState } from "../../src/application/state.js";
import { computeArtifactContentHash } from "../../src/domain/artifacts.js";
import { sha256, computeWorkspaceTreeDigest } from "../../src/domain/digests.js";
import { createExternalBinding } from "../../src/domain/external-receipt.js";
import { checkDocumentationIntegrity } from "../../src/engine/docs-integrity.js";
import { evidenceProjectionKey, evidenceRecordHash } from "../../src/engine/verification.js";
import type { AgentAction, RequirementSourceInput, StartResult, SubmitResult } from "../../src/protocol/application.js";
import type { ArtifactReference, WorkPackage } from "../../src/protocol/work-package.js";
import { doctorConnectors } from "../../src/application/doctor-connectors.js";
import { ExecutorRegistry, type StepExecutor } from "../../src/registry/executors/registry.js";
import { loadBuiltinCatalog } from "../../src/resources/catalog.js";
import { readControlPlane, type RuntimeProjection } from "../../src/storage/control-plane.js";
import { initRepository } from "../../src/storage/repository.js";
import { createGitRepository, git } from "../integration/helpers/git.js";

const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures");
const issueTargets = {
  github: { host: "github.example.com", owner: "acme", repo: "widget", number: 7 },
  gitlab: { host: "gitlab.example.com", projectPath: "group/service", iid: 9 },
} as const;
const issueStableIds = { github: "github:I_fixture_github_7", gitlab: "gitlab:9001" } as const;
const knowledgeStableId = "feishu-target:folderFixtureToken123";
const deliveryMarkdown = "# Fixture delivery\n\nVerified through the Connector Fixture E2E.\n";
const secretMarkers = [
  "github_pat_fixture_secret_abcdefghijklmnopqrstuvwxyz",
  "glpat-fixture-secret-abcdefghijklmnop",
  "t-fixture-secret-A1b2C3d4E5f6G7h8",
];

type IssueProvider = "github" | "gitlab";
type FaultPoint = "pre-send" | "post-send" | "readback-once" | "readback-always";
type ExternalStage = "issue.update" | "knowledge.publish" | "issue.close";

interface Scenario {
  source: RequirementSourceInput;
  issueProvider?: IssueProvider;
  issueBinding: boolean;
  knowledgeBinding: boolean;
  faults: Partial<Record<ExternalStage, FaultPoint>>;
  expectClosed: boolean;
}

interface Fixture {
  root: string;
  remoteRoot: string;
  executables: { git: string; gh: string; glab: string; "lark-cli": string };
  environments: {
    github: { HOME: string; GH_CONFIG_DIR: string };
    gitlab: { HOME: string; GLAB_CONFIG_DIR: string };
    feishu: { HOME: string; LARK_CONFIG_DIR: string };
  };
  app: ReturnType<typeof createApplication>;
  restart(): void;
}

function attemptPackage(runtime: RuntimeProjection, stepId: string): WorkPackage {
  const context = runtime.contexts[stepId] as { workPackage?: WorkPackage } | undefined;
  assert.ok(context?.workPackage);
  return context.workPackage;
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

function fixtureExecutors(root: string, scenario: Scenario): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  for (const [id, securityClass] of [
    ["agent.execute", "agent"],
    ["connector.execute/requirement.capture", "external-read"],
    ["command.execute/quality.docs.integrity", "local-read"],
    ["connector.execute/git.commit", "local-write"],
    ["connector.execute/issue.update", "external-write"],
    ["connector.execute/knowledge.publish", "external-write"],
    ["connector.execute/issue.close", "external-write"],
    ["control.loop", "control"],
    ["control.close", "control"],
  ] as const) {
    if (id === "command.execute/quality.docs.integrity") {
      registry.register({
        id,
        securityClass,
        async acquire(step, runtime) {
          return { action: "execute", workPackage: attemptPackage(runtime, step.id) };
        },
        async validate(step, result, runtime) {
          const state = await loadApplicationState(root, runtime.workItemId);
          const edited = runtime.contexts["edit-document"] as { result?: { modifiedFiles?: string[] } } | undefined;
          const files = edited?.result?.modifiedFiles ?? [];
          const checked = await checkDocumentationIntegrity({ root: state.worktree, files, allowedPaths: state.snapshot.changePolicy.allowedPaths });
          assert.equal(checked.ok, true, JSON.stringify(checked.problems));
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
      });
      continue;
    }
    registry.register(executor(id, securityClass, async (_result, runtime) => {
      if (id !== "connector.execute/requirement.capture") return;
      const currentBindings = runtime.evidence.bindings as Record<string, unknown> | undefined;
      runtime.evidence = {
        ...runtime.evidence,
        bindings: {
          ...(currentBindings?.issue === undefined ? {} : { issue: currentBindings.issue }),
          knowledge: scenario.knowledgeBinding
            ? { exists: true, stableId: knowledgeStableId, externalWorkItemId: runtime.workItemId }
            : { exists: false },
        },
      };
    }));
  }
  return registry;
}

function bodyFor(type: string): string {
  if (type === "specification") return "# 目标与背景\nFixture 交付。\n# 范围\n仅本地。\n# 需求\n完成 Connector 链路。\n# 验收条件\n严格回读。\n# 约束\n不访问网络。\n# 排除项\n生产验收。\n# 开放问题\n无。\n";
  if (type === "tasks") return "# 任务\n\n```yaml\ntasks:\n  - id: task-1\n    status: pending\n    dependencies: []\n    completion: Connector fixture verified\n```\n";
  if (type === "documentation-result") return deliveryMarkdown;
  if (type === "review-result") return "# Findings\n\n```yaml\nfindings: []\n```\n";
  return `# ${type}\n\nConnector fixture output.\n`;
}

async function writeArtifact(worktree: string, pkg: WorkPackage, artifactType: string): Promise<ArtifactReference> {
  const body = bodyFor(artifactType);
  const metadata = {
    artifactType,
    schemaVersion: 1 as const,
    workItemId: pkg.workItemId,
    stageId: pkg.stepId,
    attemptId: pkg.attemptId,
    revision: 1,
  };
  const contentHash = computeArtifactContentHash(metadata, body);
  const relative = `.wsspec/work-items/${pkg.workItemId}/artifacts/${pkg.stepId.replaceAll(":", "-")}-${artifactType}.md`;
  await mkdir(path.dirname(path.join(worktree, relative)), { recursive: true });
  await writeFile(path.join(worktree, relative), [
    "---",
    `artifactType: ${artifactType}`,
    "schemaVersion: 1",
    `workItemId: ${pkg.workItemId}`,
    `stageId: ${pkg.stepId}`,
    `attemptId: ${pkg.attemptId}`,
    "revision: 1",
    `contentHash: ${contentHash}`,
    "---",
    body,
  ].join("\n"), "utf8");
  const contentLevel = pkg.requiredOutputs.find((output) => output.artifactType === artifactType)?.contentLevel;
  return {
    artifactType,
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
  evidence: Array<Record<string, unknown>> = [],
  externalWrites: Array<Record<string, unknown>> = [],
): SubmitResult {
  return {
    version: 1,
    status: "completed",
    summary: `${pkg.stepId} 已由 Connector Fixture 完成`,
    modifiedFiles,
    artifacts,
    commands: [],
    evidence,
    externalWrites,
    remainingRisks: [{ risk: "fixture-only" }],
  };
}

function issuePayload(provider: IssueProvider, action: "update" | "close") {
  return {
    target: issueTargets[provider],
    action: action === "update"
      ? { type: "body" as const, body: `${provider} fixture delivered` }
      : { type: "issue.close" as const },
  };
}

async function createExternalExecutor(fixture: Omit<Fixture, "app" | "restart">, scenario: Scenario): Promise<ExternalActionExecutor> {
  const consumed = new Set<ExternalStage>();
  const payloads = new Map<string, unknown>();
  const armReadback = async (stage: ExternalStage, point: FaultPoint): Promise<void> => {
    const provider = stage === "knowledge.publish" ? "feishu" : scenario.issueProvider;
    assert.ok(provider);
    const suffix = point === "readback-always" ? "always" : "once";
    await writeFile(path.join(fixture.remoteRoot, `${provider}-arm-readback-fail-${suffix}`), "armed\n", "utf8");
  };
  const executeProvider = async (stage: ExternalStage, payload: unknown): Promise<void> => {
    if (stage === "knowledge.publish") {
      const value = payload as Parameters<typeof publishKnowledge>[0];
      const receipt = await publishKnowledge({
        executable: fixture.executables["lark-cli"],
        target: value.target,
        binding: value.binding,
        identity: "user",
        environment: fixture.environments.feishu,
      });
      assert.equal(receipt.status, "confirmed");
      return;
    }
    const value = payload as { target: typeof issueTargets.github; action: { type: "body"; body: string } | { type: "issue.close" } };
    if (scenario.issueProvider === "github") {
      await writeGithubIssue({ executable: fixture.executables.gh, target: value.target, action: value.action, environment: fixture.environments.github });
    } else {
      await writeGitlabIssue({ executable: fixture.executables.glab, target: value.target as never, action: value.action, environment: fixture.environments.gitlab });
    }
  };
  const reconcileProvider = async (stage: ExternalStage, payload: unknown): Promise<boolean> => {
    if (stage === "knowledge.publish") {
      const value = payload as Parameters<typeof publishKnowledge>[0];
      const actual = await readFeishuDocument({
        executable: fixture.executables["lark-cli"],
        document: "https://tenant.feishu.cn/docx/createdDocumentToken123",
        identity: "user",
        environment: fixture.environments.feishu,
      });
      return actual.body === value.target.markdown && actual.title === value.target.title;
    }
    const value = payload as ReturnType<typeof issuePayload>;
    const actual = scenario.issueProvider === "github"
      ? await readGithubIssue({ executable: fixture.executables.gh, target: value.target as never, environment: fixture.environments.github })
      : await readGitlabIssue({ executable: fixture.executables.glab, target: value.target as never, environment: fixture.environments.gitlab });
    return stage === "issue.close" ? actual.state === "closed" : actual.body === (value.action as { body: string }).body;
  };
  return {
    async execute({ request, payload, markDispatched }) {
      const stage = request.action;
      const point = scenario.faults[stage];
      payloads.set(request.requestId, payload);
      if (point === "pre-send" && !consumed.has(stage)) {
        consumed.add(stage);
        throw new Error("fixture crash before send");
      }
      if ((point === "readback-once" || point === "readback-always") && !consumed.has(stage)) {
        consumed.add(stage);
        await armReadback(stage, point);
      }
      await markDispatched();
      await executeProvider(stage, payload);
      if (point === "post-send" && !consumed.has(stage)) {
        consumed.add(stage);
        throw new Error("fixture crash after send");
      }
      return { targetStableId: request.target.stableId, contentDigest: request.payloadDigest, verifiedAt: "2026-08-20T08:00:00.000Z" };
    },
    async reconcile({ request }) {
      const payload = payloads.get(request.requestId);
      if (payload === undefined) return { outcome: "unknown", checkedAt: "2026-08-20T08:00:01.000Z", reason: "fixture payload unavailable" };
      try {
        const verified = await reconcileProvider(request.action, payload);
        return verified
          ? { outcome: "verified", targetStableId: request.target.stableId, contentDigest: request.payloadDigest, checkedAt: "2026-08-20T08:00:01.000Z" }
          : { outcome: "failed", checkedAt: "2026-08-20T08:00:01.000Z", reason: "fixture readback mismatch" };
      } catch {
        throw new Error("fixture readback unavailable");
      }
    },
  };
}

async function copyExecutable(source: string, target: string): Promise<void> {
  await copyFile(source, target);
  await chmod(target, 0o700);
}

async function createFixture(scenario: Scenario): Promise<Fixture> {
  const root = await createGitRepository();
  await initRepository(root);
  await copyFile(path.join(fixtureRoot, "workflows/external-delivery/config.yaml"), path.join(root, ".wsspec/config.yaml"));
  const ignored = await readFile(path.join(root, ".gitignore"), "utf8");
  await writeFile(path.join(root, ".gitignore"), `${ignored}.wsspec/work-items/\n`, "utf8");
  await git(root, "add", ".wsspec", ".gitignore");
  await git(root, "commit", "-m", "test: configure external delivery fixture");

  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), "wspec-external-delivery-"));
  await chmod(remoteRoot, 0o700);
  const bin = path.join(remoteRoot, "bin");
  const githubConfig = path.join(remoteRoot, "github-config");
  const gitlabConfig = path.join(remoteRoot, "gitlab-config");
  const larkConfig = path.join(remoteRoot, "lark-config");
  await Promise.all([bin, githubConfig, gitlabConfig, larkConfig].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const executables = {
    git: await realpath(execFileSync("which", ["git"], { encoding: "utf8" }).trim()),
    gh: path.join(bin, "gh"),
    glab: path.join(bin, "glab"),
    "lark-cli": path.join(bin, "lark-cli"),
  };
  await Promise.all([
    copyExecutable(path.join(fixtureRoot, "connectors/github/gh"), executables.gh),
    copyExecutable(path.join(fixtureRoot, "connectors/gitlab/glab"), executables.glab),
    copyExecutable(path.join(fixtureRoot, "connectors/feishu/lark-cli"), executables["lark-cli"]),
    copyFile(path.join(fixtureRoot, "connectors/github/issue.json"), path.join(remoteRoot, "github-state.json")),
    copyFile(path.join(fixtureRoot, "connectors/gitlab/issue.json"), path.join(remoteRoot, "gitlab-state.json")),
    copyFile(path.join(fixtureRoot, "connectors/feishu/document.json"), path.join(remoteRoot, "feishu-source.json")),
  ]);
  await Promise.all([
    writeFile(path.join(githubConfig, "hosts.yml"), `oauth_token: ${secretMarkers[0]}\n`, { mode: 0o600 }),
    writeFile(path.join(gitlabConfig, "config.yml"), `token: ${secretMarkers[1]}\n`, { mode: 0o600 }),
    writeFile(path.join(larkConfig, "session.json"), `${JSON.stringify({ access_token: secretMarkers[2] })}\n`, { mode: 0o600 }),
  ]);
  const environments = {
    github: { HOME: remoteRoot, GH_CONFIG_DIR: githubConfig },
    gitlab: { HOME: remoteRoot, GLAB_CONFIG_DIR: gitlabConfig },
    feishu: { HOME: remoteRoot, LARK_CONFIG_DIR: larkConfig },
  };
  const externalExecutor = await createExternalExecutor({ root, remoteRoot, executables, environments }, scenario);
  const dependencies = (): ApplicationDependencies => ({
    provider: "codex",
    home: os.homedir(),
    terminal: { isTTY: true },
    now: () => new Date("2026-08-20T08:00:00.000Z"),
    executors: fixtureExecutors(root, scenario),
    externalExecutor: () => externalExecutor,
    connectorRuntime: {
      executables,
      environments,
      larkIdentity: "user",
    },
  });
  const fixture = {
    root,
    remoteRoot,
    executables,
    environments,
    app: createApplication(dependencies()),
    restart() { fixture.app = createApplication(dependencies()); },
  };
  return fixture;
}

async function gitCommit(fixture: Fixture, worktree: string): Promise<Record<string, unknown>> {
  const baselineRevision = await git(worktree, "rev-parse", "HEAD");
  const commonDir = await realpath(await git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wspec-fixture-approval-"));
  const index = path.join(temporary, "index");
  const pathspec = path.join(temporary, "pathspec");
  const environment = { PATH: "/usr/bin:/bin", GIT_INDEX_FILE: index };
  let diffDigest: string;
  try {
    await writeFile(pathspec, Buffer.from("docs/connector-fixture-delivery.md\0", "utf8"));
    execFileSync(fixture.executables.git, ["read-tree", baselineRevision], { cwd: worktree, env: environment });
    execFileSync(fixture.executables.git, [
      "--literal-pathspecs", "add", "--all", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul",
    ], { cwd: worktree, env: environment });
    diffDigest = sha256(execFileSync(fixture.executables.git, [
      "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--src-prefix=a/", "--dst-prefix=b/", baselineRevision, "--",
    ], { cwd: worktree, env: environment }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const receipt = await commitGitChanges({
    executable: fixture.executables.git,
    approval: {
      repositoryRoot: await realpath(worktree),
      repositoryCommonDir: commonDir,
      baselineRevision,
      files: ["docs/connector-fixture-delivery.md"],
      message: "test: commit connector fixture delivery",
      diffDigest: diffDigest as `sha256:${string}`,
    },
  });
  await writeFile(path.join(fixture.remoteRoot, "timeline.ndjson"), `${JSON.stringify({ stage: "git.commit", oid: receipt.commitOid })}\n`, { flag: "a" });
  return receipt as unknown as Record<string, unknown>;
}

function externalIntent(pkg: WorkPackage, scenario: Scenario): Record<string, unknown> | undefined {
  if ((pkg.stepId === "update-issue" || pkg.stepId === "close-issue") && scenario.issueBinding) {
    const action = pkg.stepId === "update-issue" ? "issue.update" : "issue.close";
    return {
      kind: "external-action",
      provider: scenario.issueProvider,
      action,
      target: { kind: "issue", stableId: issueStableIds[scenario.issueProvider!] },
      payload: issuePayload(scenario.issueProvider!, pkg.stepId === "update-issue" ? "update" : "close"),
      sideEffects: [pkg.stepId === "update-issue" ? "更新 Fixture Issue" : "关闭 Fixture Issue"],
    };
  }
  if (pkg.stepId === "update-wiki" && scenario.knowledgeBinding) {
    const target = { folderToken: "folderFixtureToken123", title: "Fixture delivery", markdown: deliveryMarkdown };
    const binding = createExternalBinding({
      target: "knowledge",
      workPackage: pkg,
      discoveryBinding: { exists: true, stableId: knowledgeStableId, externalWorkItemId: pkg.workItemId },
      expectedPublishedContentDigest: sha256(deliveryMarkdown),
    });
    return {
      kind: "external-action",
      provider: "feishu",
      action: "knowledge.publish",
      target: { kind: "knowledge", stableId: knowledgeStableId },
      payload: { target, binding },
      sideEffects: ["发布 Fixture 知识文档"],
    };
  }
  return undefined;
}

async function approve(fixture: Fixture, started: StartResult, action: Extract<AgentAction, { action: "await_approval" }>): Promise<AgentAction> {
  return action.approval.kind === "external_action"
    ? fixture.app.decide({
        kind: "external_action",
        root: fixture.root,
        workItemId: started.workItemId,
        requestId: action.approval.requestId,
        decision: "approved",
        expectedDigest: action.approval.digest,
        actor: "fixture-owner",
      })
    : fixture.app.decide({
        kind: "approval",
        root: fixture.root,
        workItemId: started.workItemId,
        requestId: action.approval.requestId,
        decision: "approved",
        expectedDigest: action.approval.digest,
        actor: "fixture-owner",
      });
}

async function reconcile(fixture: Fixture, started: StartResult): Promise<AgentAction> {
  const view = await fixture.app.inspect({ root: fixture.root, workItemId: started.workItemId });
  const pending = view.externalActions?.find(({ status }) => status === "reconciliation_required");
  assert.ok(pending);
  return fixture.app.decide({
    kind: "external_reconciliation",
    root: fixture.root,
    workItemId: started.workItemId,
    requestId: pending.requestId,
    actor: "fixture-owner",
  });
}

async function runDelivery(fixture: Fixture, scenario: Scenario): Promise<{ started: StartResult; action: AgentAction; worktree: string }> {
  const started = await fixture.app.start({
    root: fixture.root,
    source: scenario.source,
    workflowRef: "builtin://workflows/documentation-delivery",
    profile: "governed",
  });
  const state = await loadApplicationState(fixture.root, started.workItemId);
  const worktree = state.worktree;
  let action = await fixture.app.acquire({ root: fixture.root, workItemId: started.workItemId, actor: "fixture-author" });
  let safety = 0;
  while (action.action !== "completed" && safety++ < 60) {
    if (action.action === "await_approval") {
      action = await approve(fixture, started, action);
      continue;
    }
    if (action.action === "blocked") {
      if (action.problems.some(({ code }) => code === "WSSPEC_INDEPENDENT_REVIEW_REQUIRED")) {
        action = await fixture.app.acquire({
          root: fixture.root,
          workItemId: started.workItemId,
          actor: "fixture-independent-reviewer",
        });
        continue;
      }
      if (action.problems.some(({ code }) => code === "WSSPEC_EXTERNAL_RECONCILIATION_REQUIRED")) {
        fixture.restart();
        try { action = await reconcile(fixture, started); }
        catch {
          if (!scenario.expectClosed) return { started, action, worktree };
          throw new Error("public external reconciliation failed unexpectedly");
        }
        continue;
      }
      throw new Error(`delivery blocked: ${action.problems.map(({ code }) => code).join(",")}`);
    }
    const pkg = action.workPackage;
    const artifacts: ArtifactReference[] = [];
    const modifiedFiles: string[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    if (pkg.stepId === "edit-document") {
      await mkdir(path.join(worktree, "docs"), { recursive: true });
      await copyFile(path.join(fixtureRoot, "workflows/external-delivery/delivery.md"), path.join(worktree, "docs/connector-fixture-delivery.md"));
      modifiedFiles.push("docs/connector-fixture-delivery.md");
    } else if (pkg.stepId === "commit") {
      evidence.push(await gitCommit(fixture, worktree));
    }
    for (const output of pkg.requiredOutputs) {
      if (output.artifactType === "requirement-source") {
        const source = pkg.artifacts.find(({ artifactType }) => artifactType === "requirement-source");
        assert.ok(source);
        artifacts.push(source);
      } else {
        artifacts.push(await writeArtifact(worktree, pkg, output.artifactType));
      }
    }
    const intent = externalIntent(pkg, scenario);
    const result = completed(pkg, artifacts, modifiedFiles, evidence, intent === undefined ? [] : [intent]);
    try {
      action = await fixture.app.submit({
        root: fixture.root,
        workItemId: started.workItemId,
        stepId: pkg.stepId,
        attemptId: pkg.attemptId,
        leaseToken: pkg.lease.token,
        result,
      });
    } catch (error) {
      assert.match(String(error), /WSSPEC_EXTERNAL_PROVIDER_EXECUTION_FAILED/u);
      fixture.restart();
      action = await fixture.app.submit({
        root: fixture.root,
        workItemId: started.workItemId,
        stepId: pkg.stepId,
        attemptId: pkg.attemptId,
        leaseToken: pkg.lease.token,
        result,
      });
    }
  }
  assert.ok(safety < 60, "external delivery exceeded bounded steps");
  return { started, action, worktree };
}

async function timeline(root: string): Promise<string[]> {
  const text = await readFile(path.join(root, "timeline.ndjson"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { stage: string }).stage);
}

async function persistedText(roots: string[]): Promise<string> {
  const values: string[] = [];
  const visit = async (target: string): Promise<void> => {
    let info;
    try { info = await stat(target); }
    catch { return; }
    if (info.isDirectory()) {
      for (const entry of await readdir(target)) await visit(path.join(target, entry));
    } else if (info.isFile()) {
      values.push(await readFile(target, "utf8"));
    }
  };
  for (const root of roots) await visit(root);
  return values.join("\n");
}

async function assertNoPersistenceLeak(fixture: Fixture, worktree: string): Promise<void> {
  const text = await persistedText([
    path.join(fixture.root, ".wsspec"),
    path.join(fixture.root, ".git/wsspec"),
    path.join(worktree, ".wsspec"),
  ]);
  for (const forbidden of [...secretMarkers, fixture.remoteRoot, os.homedir(), "oauth_token:", "access_token", "token: glpat-"]) {
    assert.equal(text.includes(forbidden), false, `persisted connector output leaked ${forbidden}`);
  }
}

async function assertDoctorCoversBuiltins(fixture: Fixture): Promise<void> {
  const catalog = await loadBuiltinCatalog();
  const manifests = catalog.connectors;
  assert.deepEqual(manifests.map(({ executable }) => executable).sort(), ["gh", "git", "glab", "lark-cli"]);
  const byExecutable = new Map(manifests.map((manifest) => [manifest.executable, fixture.executables[manifest.executable]]));
  const health = await doctorConnectors({
    manifests,
    environment: {
      HOME: fixture.remoteRoot,
      GH_CONFIG_DIR: fixture.environments.github.GH_CONFIG_DIR,
      GLAB_CONFIG_DIR: fixture.environments.gitlab.GLAB_CONFIG_DIR,
      LARK_CONFIG_DIR: fixture.environments.feishu.LARK_CONFIG_DIR,
    },
    locateExecutable: async (executable) => byExecutable.get(executable),
  });
  assert.deepEqual(health.map(({ provider }) => provider).sort(), ["git-native", "github-cli", "gitlab-cli", "lark-cli"]);
  const publicHealth = await runCommand(fixture.root, ["doctor", "connectors"]) as Array<{ provider: string }>;
  assert.deepEqual(publicHealth.map(({ provider }) => provider).sort(), ["git-native", "github-cli", "gitlab-cli", "lark-cli"]);
}

test("GitHub Issue fixture uses Application delivery order and retries only a pre-send failure", async () => {
  const scenario: Scenario = {
    source: { type: "issue", provider: "github", id: "https://github.example.com/acme/widget/issues/7" },
    issueProvider: "github",
    issueBinding: true,
    knowledgeBinding: true,
    faults: { "issue.update": "pre-send", "knowledge.publish": "post-send", "issue.close": "readback-once" },
    expectClosed: true,
  };
  const fixture = await createFixture(scenario);
  await assertDoctorCoversBuiltins(fixture);
  const result = await runDelivery(fixture, scenario);
  assert.equal(result.action.action, "completed");
  assert.equal((await fixture.app.inspect({ root: fixture.root, workItemId: result.started.workItemId })).status, "closed");
  assert.deepEqual(await timeline(fixture.remoteRoot), ["git.commit", "issue.update", "knowledge.publish", "issue.close"]);
  await assertNoPersistenceLeak(fixture, result.worktree);
});

test("GitLab Issue fixture reconciles sent-or-unknown writes without duplicate mutations and blocks an unverifiable close", async (t) => {
  const scenario: Scenario = {
    source: { type: "issue", provider: "gitlab", id: "https://gitlab.example.com/group/service/-/issues/9" },
    issueProvider: "gitlab",
    issueBinding: true,
    knowledgeBinding: true,
    faults: { "issue.update": "post-send", "knowledge.publish": "readback-once", "issue.close": "pre-send" },
    expectClosed: true,
  };
  const fixture = await createFixture(scenario);
  const result = await runDelivery(fixture, scenario);
  assert.equal(result.action.action, "completed");
  assert.deepEqual(await timeline(fixture.remoteRoot), ["git.commit", "issue.update", "knowledge.publish", "issue.close"]);
  await assertNoPersistenceLeak(fixture, result.worktree);

  await t.test("external close readback failure leaves the Work Item blocked", async () => {
    const blockedScenario: Scenario = {
      ...scenario,
      faults: { "issue.close": "readback-always" },
      expectClosed: false,
    };
    const blockedFixture = await createFixture(blockedScenario);
    const blocked = await runDelivery(blockedFixture, blockedScenario);
    assert.notEqual(blocked.action.action, "completed");
    assert.notEqual((await blockedFixture.app.inspect({ root: blockedFixture.root, workItemId: blocked.started.workItemId })).status, "closed");
    assert.deepEqual(await timeline(blockedFixture.remoteRoot), ["git.commit", "issue.update", "knowledge.publish", "issue.close"]);
  });
});

test("Feishu Document fixture captures through lark-cli, skips Issue stages, and reconciles knowledge readback", async () => {
  const scenario: Scenario = {
    source: { type: "issue", provider: "feishu", id: "https://tenant.feishu.cn/docx/sourceDocumentToken123" },
    issueBinding: false,
    knowledgeBinding: true,
    faults: { "knowledge.publish": "readback-once" },
    expectClosed: true,
  };
  const fixture = await createFixture(scenario);
  const result = await runDelivery(fixture, scenario);
  assert.equal(result.action.action, "completed");
  const projection = await readControlPlane(fixture.root, result.started.workItemId);
  assert.equal(projection.stages["update-issue"]?.status, "skipped");
  assert.equal(projection.stages["close-issue"]?.status, "skipped");
  assert.deepEqual(await timeline(fixture.remoteRoot), ["git.commit", "knowledge.publish"]);
  await assertNoPersistenceLeak(fixture, result.worktree);
});

test("each external stage recovers its remaining crash boundary without reordering or duplicate writes", async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    fault: Partial<Record<ExternalStage, FaultPoint>>;
  }> = [
    { name: "issue.update readback crash", fault: { "issue.update": "readback-once" } },
    { name: "knowledge.publish pre-send crash", fault: { "knowledge.publish": "pre-send" } },
    { name: "issue.close post-send crash", fault: { "issue.close": "post-send" } },
  ];

  for (const current of cases) await t.test(current.name, async () => {
    const scenario: Scenario = {
      source: { type: "issue", provider: "github", id: "https://github.example.com/acme/widget/issues/7" },
      issueProvider: "github",
      issueBinding: true,
      knowledgeBinding: true,
      faults: current.fault,
      expectClosed: true,
    };
    const fixture = await createFixture(scenario);
    const result = await runDelivery(fixture, scenario);

    assert.equal(result.action.action, "completed");
    assert.equal((await fixture.app.inspect({ root: fixture.root, workItemId: result.started.workItemId })).status, "closed");
    assert.deepEqual(await timeline(fixture.remoteRoot), ["git.commit", "issue.update", "knowledge.publish", "issue.close"]);
    await assertNoPersistenceLeak(fixture, result.worktree);
  });
});
