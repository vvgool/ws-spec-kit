import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { computeArtifactContentHash } from "../../src/domain/artifacts.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const prepareScript = path.join(repositoryRoot, "scripts", "acceptance", "prepare-agent-smoke.mjs");
const verifyScript = path.join(repositoryRoot, "scripts", "acceptance", "verify-agent-smoke.mjs");
const tsxLoader = path.join(repositoryRoot, "node_modules", "tsx", "dist", "loader.mjs");
process.env.WSSPECKIT_ACCEPTANCE_RUNTIME = "source";
const verifierModule = "../../scripts/acceptance/verify-agent-smoke.mjs";
const { checkedArtifact } = await import(verifierModule);

interface PreparedSmoke {
  version: 1;
  client: "codex" | "claude" | "cursor";
  root: string;
  workItemId: string;
  baselineCommit: string;
  driver: string;
}

interface VerificationSummary {
  ok: boolean;
  client: string;
  workItemId: string;
  checks: Array<{ id: string; ok: boolean; detail?: string }>;
}

async function prepare(client: PreparedSmoke["client"]): Promise<PreparedSmoke> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "wsspec-agent-live-test-"));
  const root = path.join(parent, "repository");
  const { stdout } = await execFileAsync(process.execPath, [prepareScript, "--client", client, "--directory", root], {
    cwd: repositoryRoot,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout) as PreparedSmoke;
}

async function verify(root: string, client: PreparedSmoke["client"]): Promise<{ code: number; summary: VerificationSummary }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--import", tsxLoader, verifyScript, "--client", client, "--repo", root], {
      cwd: repositoryRoot,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { code: 0, summary: JSON.parse(stdout) as VerificationSummary };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string };
    return { code: failure.code ?? 1, summary: JSON.parse(failure.stdout ?? "{}") as VerificationSummary };
  }
}

test("prepare 创建隔离 TypeScript 仓库、真实 Quick Work Item 和宿主 Driver", async () => {
  const prepared = await prepare("codex");

  assert.equal(prepared.version, 1);
  assert.equal(prepared.client, "codex");
  assert.match(prepared.workItemId, /^WSS-[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.match(prepared.baselineCommit, /^[a-f0-9]{40}$/u);
  assert.equal(prepared.driver, ".agents/skills/wsspeckit-driver/SKILL.md");
  await access(path.join(prepared.root, prepared.driver));
  await access(path.join(prepared.root, "src", "labels.ts"));
  await access(path.join(prepared.root, "tests", "labels.test.ts"));
  await access(path.join(prepared.root, ".acceptance", "agent-smoke.json"));

  await execFileAsync(process.execPath, ["--test", "tests/labels.test.ts"], { cwd: prepared.root });
  const source = await readFile(path.join(prepared.root, "src", "labels.ts"), "utf8");
  assert.doesNotMatch(source, /formatLabelParts/u, "fixture 不得预置目标函数实现");
});

test("prepare 未指定目录时直接使用 mkdtemp 创建的隔离根目录", async () => {
  const { stdout } = await execFileAsync(process.execPath, [prepareScript, "--client", "claude"], {
    cwd: repositoryRoot,
    maxBuffer: 2 * 1024 * 1024,
  });
  const prepared = JSON.parse(stdout) as PreparedSmoke;
  try {
    assert.equal(prepared.client, "claude");
    await access(path.join(prepared.root, prepared.driver));
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
  }
});

test("prepare 拒绝复用已有目录且不修改其中内容", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsspec-agent-existing-"));
  const sentinel = path.join(root, "sentinel.txt");
  await writeFile(sentinel, "preserve\n", "utf8");

  await assert.rejects(execFileAsync(process.execPath, [prepareScript, "--client", "codex", "--directory", root], {
    cwd: repositoryRoot,
    maxBuffer: 2 * 1024 * 1024,
  }));
  assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
  await assert.rejects(access(path.join(root, ".git")), /ENOENT/u);
});

test("verifier 对尚无真实 acquire/submit、TDD、Review 和 Close 的 fixture fail closed", async () => {
  const prepared = await prepare("cursor");
  const result = await verify(prepared.root, "cursor");

  assert.equal(result.code, 1);
  assert.equal(result.summary.ok, false);
  assert.equal(result.summary.client, "cursor");
  const failed = result.summary.checks.filter(({ ok }) => !ok).map(({ id }) => id);
  for (const id of ["protocol.acquire-submit", "artifact.compact-plan", "tdd.trusted-red-green", "workflow.review", "workflow.close"]) {
    assert.ok(failed.includes(id), `${id} 必须失败`);
  }
});

test("verifier 拒绝用另一个客户端标签复用 acceptance 状态", async () => {
  const prepared = await prepare("codex");
  const result = await verify(prepared.root, "claude");

  assert.equal(result.code, 1);
  assert.equal(result.summary.ok, false);
  assert.equal(result.summary.checks.find(({ id }) => id === "fixture.client")?.ok, false);
});

test("verifier 从 Work Item worktree 读取产品与测试 diff", async () => {
  const prepared = await prepare("codex");
  const worktree = path.join(prepared.root, ".worktrees", prepared.workItemId);
  await writeFile(path.join(worktree, "src", "labels.ts"), [
    "export function normalizeLabel(value: string): string { return value.trim().toLowerCase(); }",
    "export function formatLabelParts(parts: readonly string[]): string { return parts.map(normalizeLabel).filter(Boolean).join(' / '); }",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(worktree, "tests", "labels.test.ts"), "// acceptance test change\n", "utf8");

  const result = await verify(prepared.root, "codex");
  const diff = result.summary.checks.find(({ id }) => id === "git.expected-diff");
  assert.equal(diff?.ok, true, diff?.detail);
});

test("verifier 重新计算 Artifact contentHash 并拒绝正文篡改", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wsspec-agent-artifact-"));
  const relative = ".wsspec/work-items/WSS-TEST/artifacts/plan.md";
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  const metadata = {
    artifactType: "tasks",
    schemaVersion: 1 as const,
    workItemId: "WSS-TEST",
    stageId: "plan",
    attemptId: "attempt-test",
    revision: 1,
  };
  const body = "# 任务\n\n```yaml\ntasks:\n  - id: task-1\n    status: pending\n    dependencies: []\n    completion: 完成 Smoke\n```\n";
  const contentHash = computeArtifactContentHash(metadata, body);
  const content = [
    "---",
    "artifactType: tasks",
    "schemaVersion: 1",
    "workItemId: WSS-TEST",
    "stageId: plan",
    "attemptId: attempt-test",
    "revision: 1",
    `contentHash: ${contentHash}`,
    "---",
    body,
  ].join("\n");
  await writeFile(filename, content, "utf8");
  const reference = { artifactType: "tasks", path: relative, contentHash };
  await checkedArtifact(root, reference);

  await writeFile(filename, content.replace("status: pending", "status: completed"), "utf8");
  await assert.rejects(checkedArtifact(root, reference));
});
