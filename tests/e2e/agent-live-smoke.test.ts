import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { computeArtifactContentHash } from "../../src/domain/artifacts.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const prepareScript = path.join(repositoryRoot, "scripts", "acceptance", "prepare-agent-smoke.mjs");
const verifyScript = path.join(repositoryRoot, "scripts", "acceptance", "verify-agent-smoke.mjs");
const matrixScript = path.join(repositoryRoot, "scripts", "acceptance", "render-agent-live-matrix.mjs");
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
  authorityFile: string;
  authorityIdentity: string;
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

async function verify(root: string, client: PreparedSmoke["client"], authorityFile: string, authorityIdentity: string): Promise<{ code: number; summary: VerificationSummary }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", tsxLoader, verifyScript,
      "--client", client,
      "--repo", root,
      "--authority", authorityFile,
      "--authority-identity", authorityIdentity,
    ], {
      cwd: repositoryRoot,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { code: 0, summary: JSON.parse(stdout) as VerificationSummary };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string };
    return { code: failure.code ?? 1, summary: JSON.parse(failure.stdout ?? "{}") as VerificationSummary };
  }
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", [
    "-c", "user.email=acceptance@example.invalid",
    "-c", "user.name=WSSpecKit Acceptance",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd: root });
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await visit(root);
  return files;
}

test("prepare 创建隔离 TypeScript 仓库、真实 Quick Work Item 和宿主 Driver", async () => {
  const prepared = await prepare("codex");

  assert.equal(prepared.version, 1);
  assert.equal(prepared.client, "codex");
  assert.match(prepared.workItemId, /^WSS-[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.match(prepared.baselineCommit, /^[a-f0-9]{40}$/u);
  assert.equal(prepared.driver, ".agents/skills/wsspeckit-driver/SKILL.md");
  assert.match(prepared.authorityIdentity, /^sha256:[a-f0-9]{64}$/u);
  assert.equal((await stat(prepared.authorityFile)).mode & 0o777, 0o600);
  assert.equal((await lstat(prepared.authorityFile)).isSymbolicLink(), false);
  await access(path.join(prepared.root, prepared.driver));
  await access(path.join(prepared.root, "src", "labels.ts"));
  await access(path.join(prepared.root, "tests", "labels.test.ts"));
  await access(path.join(prepared.root, ".acceptance", "agent-smoke.json"));
  await access(path.join(prepared.root, ".acceptance", "agent-smoke-receipt.json"));
  const runManifest = JSON.parse(await readFile(path.join(prepared.root, ".acceptance", "agent-smoke-run.json"), "utf8")) as Record<string, unknown>;
  assert.match(String(runManifest.runIdHash), /^sha256:[a-f0-9]{64}$/u);
  assert.match(String(runManifest.workItemIdHash), /^sha256:[a-f0-9]{64}$/u);
  assert.match(String(runManifest.requirementDigest), /^sha256:[a-f0-9]{64}$/u);
  assert.match(String(runManifest.baselineCommit), /^[a-f0-9]{40}$/u);
  assert.match(String(runManifest.baselineTree), /^[a-f0-9]{40}$/u);
  assert.match(String(runManifest.driverDigest), /^sha256:[a-f0-9]{64}$/u);
  assert.match(String(runManifest.authorityIdentity), /^sha256:[a-f0-9]{64}$/u);
  assert.equal(runManifest.client, "codex");
  assert.equal(runManifest.status, "prepared");
  const clientVersionProbe = runManifest.clientVersionProbe as Record<string, unknown>;
  assert.deepEqual(clientVersionProbe.versionArgv, ["--version"]);
  assert.ok(["recorded", "unavailable", "failed"].includes(String(clientVersionProbe.status)));
  if (clientVersionProbe.status === "recorded") {
    assert.match(String(clientVersionProbe.executableDigest), /^sha256:[a-f0-9]{64}$/u);
    assert.match(String(clientVersionProbe.outputDigest), /^sha256:[a-f0-9]{64}$/u);
  }
  assert.equal(JSON.stringify(runManifest).includes(prepared.root), false);
  assert.equal(JSON.stringify(runManifest).includes(prepared.workItemId), false);

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
  const result = await verify(prepared.root, "cursor", prepared.authorityFile, prepared.authorityIdentity);

  assert.equal(result.code, 1);
  assert.equal(result.summary.ok, false);
  assert.equal(result.summary.client, "cursor");
  const failed = result.summary.checks.filter(({ ok }) => !ok).map(({ id }) => id);
  for (const id of ["protocol.acquire-submit", "artifact.compact-plan", "tdd.trusted-red-green", "workflow.review", "workflow.close"]) {
    assert.ok(failed.includes(id), `${id} 必须失败`);
  }
  const runManifestText = await readFile(path.join(prepared.root, ".acceptance", "agent-smoke-run.json"), "utf8");
  const runManifest = JSON.parse(runManifestText) as Record<string, unknown>;
  assert.equal(runManifest.status, "no-go");
  assert.match(String(runManifest.eventDigest), /^sha256:[a-f0-9]{64}$/u);
  assert.match(String(runManifest.verifierDigest), /^sha256:[a-f0-9]{64}$/u);
  const eventReferences = runManifest.eventReferences as Array<Record<string, unknown>>;
  assert.ok(eventReferences.length > 0);
  for (const reference of eventReferences) {
    assert.match(String(reference.eventIdHash), /^sha256:[a-f0-9]{64}$/u);
    assert.match(String(reference.eventHash), /^sha256:[a-f0-9]{64}$/u);
  }
  assert.equal((runManifest.verifier as Record<string, boolean>)["protocol.acquire-submit"], false);
  assert.equal(runManifestText.includes(prepared.root), false);
  assert.equal(runManifestText.includes(prepared.workItemId), false);
});

test("verifier 拒绝用另一个客户端标签复用 acceptance 状态", async () => {
  const prepared = await prepare("codex");
  const result = await verify(prepared.root, "claude", prepared.authorityFile, prepared.authorityIdentity);

  assert.equal(result.code, 1);
  assert.equal(result.summary.ok, false);
  assert.equal(result.summary.checks.find(({ id }) => id === "fixture.client")?.ok, false);
});

test("verifier 从 clean checkout 执行固定行为探针并拒绝空断言或跳过测试", async () => {
  const prepared = await prepare("codex");
  const worktree = path.join(prepared.root, ".worktrees", prepared.workItemId);
  await writeFile(path.join(worktree, "src", "labels.ts"), [
    "export function normalizeLabel(value: string): string { return value.trim().toLowerCase(); }",
    "export function formatLabelParts(parts: readonly string[]): string { return parts.map(normalizeLabel).filter(Boolean).join(' / '); }",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(worktree, "tests", "labels.test.ts"), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { formatLabelParts } from '../src/labels.ts';",
    "test('formats label parts', () => {",
    "  assert.equal(formatLabelParts(['  READY  ', '', ' Next Step ']), 'ready / next step');",
    "});",
    "",
  ].join("\n"), "utf8");
  await git(worktree, "add", "src/labels.ts", "tests/labels.test.ts");
  await git(worktree, "commit", "-m", "feat: implement smoke behavior");

  const result = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  const diff = result.summary.checks.find(({ id }) => id === "smoke.behavior-probe");
  assert.equal(diff?.ok, true, diff?.detail);

  await writeFile(path.join(worktree, "tests", "labels.test.ts"), [
    "import test from 'node:test';",
    "test.skip('formats label parts', () => {});",
    "",
  ].join("\n"), "utf8");
  await git(worktree, "add", "tests/labels.test.ts");
  await git(worktree, "commit", "-m", "test: skip smoke assertion");
  const skipped = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(skipped.summary.checks.find(({ id }) => id === "smoke.behavior-probe")?.ok, false);

  await writeFile(path.join(worktree, "tests", "labels.test.ts"), [
    "import test from 'node:test';",
    "test('formats label parts', () => {});",
    "",
  ].join("\n"), "utf8");
  await git(worktree, "add", "tests/labels.test.ts");
  await git(worktree, "commit", "-m", "test: empty smoke assertion");
  const empty = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(empty.summary.checks.find(({ id }) => id === "smoke.behavior-probe")?.ok, false);

  await writeFile(path.join(worktree, "tests", "labels.test.ts"), "// no behavior assertion\n", "utf8");
  await git(worktree, "add", "tests/labels.test.ts");
  await git(worktree, "commit", "-m", "test: remove smoke assertion");
  const comment = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(comment.summary.checks.find(({ id }) => id === "smoke.behavior-probe")?.ok, false);
});

test("签名 fixture 拒绝 metadata、receipt、Work Item 和 authority 替换", async () => {
  const prepared = await prepare("codex");
  const manifestFile = path.join(prepared.root, ".acceptance", "agent-smoke.json");
  const receiptFile = path.join(prepared.root, ".acceptance", "agent-smoke-receipt.json");
  const manifestText = await readFile(manifestFile, "utf8");
  const receiptText = await readFile(receiptFile, "utf8");
  const authorityText = await readFile(prepared.authorityFile, "utf8");
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;

  await writeFile(manifestFile, `${JSON.stringify({ ...manifest, client: "claude" }, null, 2)}\n`, "utf8");
  let result = await verify(prepared.root, "claude", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(result.summary.checks.find(({ id }) => id === "fixture.authority")?.ok, false);

  await writeFile(manifestFile, `${JSON.stringify({ ...manifest, workItemId: "WSS-01M00000000000000000000000" }, null, 2)}\n`, "utf8");
  result = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(result.summary.checks.find(({ id }) => id === "fixture.authority")?.ok, false);

  await writeFile(manifestFile, manifestText, "utf8");
  const receipt = JSON.parse(receiptText) as Record<string, unknown>;
  await writeFile(receiptFile, `${JSON.stringify({ ...receipt, mac: `sha256:${"0".repeat(64)}` }, null, 2)}\n`, "utf8");
  result = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(result.summary.checks.find(({ id }) => id === "fixture.authority")?.ok, false);

  await writeFile(receiptFile, receiptText, "utf8");
  const authority = JSON.parse(authorityText) as Record<string, unknown>;
  await writeFile(prepared.authorityFile, `${JSON.stringify({ ...authority, runNonce: "0".repeat(64) })}\n`, { encoding: "utf8", mode: 0o600 });
  result = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(result.summary.checks.find(({ id }) => id === "fixture.authority")?.ok, false);

  await writeFile(prepared.authorityFile, `${JSON.stringify({ ...authority, hmacKey: "0".repeat(64) })}\n`, { encoding: "utf8", mode: 0o600 });
  result = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(result.summary.checks.find(({ id }) => id === "fixture.authority")?.ok, false);

  await writeFile(prepared.authorityFile, authorityText, { encoding: "utf8", mode: 0o600 });
  const savedAuthority = `${prepared.authorityFile}.saved`;
  await rename(prepared.authorityFile, savedAuthority);
  await writeFile(prepared.authorityFile, authorityText, { encoding: "utf8", mode: 0o600 });
  await chmod(prepared.authorityFile, 0o600);
  result = await verify(prepared.root, "codex", prepared.authorityFile, prepared.authorityIdentity);
  assert.equal(result.summary.checks.find(({ id }) => id === "fixture.authority")?.ok, false);
});

test("prepare 子进程环境不继承 injected secrets，run manifest 只保留 allowlist 键", async () => {
  const secret = "acceptance-secret-must-not-cross-child-boundary";
  const parent = await mkdtemp(path.join(os.tmpdir(), "wsspec-agent-env-test-"));
  const root = path.join(parent, "repository");
  const { stdout } = await execFileAsync(process.execPath, [prepareScript, "--client", "cursor", "--directory", root], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OPENAI_API_KEY: secret,
      GITHUB_TOKEN: secret,
      AWS_SECRET_ACCESS_KEY: secret,
      HTTPS_PROXY: `https://${secret}.invalid`,
      WSSPEC_ENV_SENTINEL: secret,
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  const prepared = JSON.parse(stdout) as PreparedSmoke;
  const commonDirectory = (await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: root })).stdout.trim();
  const persistedFiles = [...await filesUnder(root), ...await filesUnder(path.resolve(root, commonDirectory)), prepared.authorityFile];
  for (const filename of new Set(persistedFiles)) assert.doesNotMatch(await readFile(filename, "utf8").catch(() => ""), new RegExp(secret, "u"), filename);

  const runManifest = JSON.parse(await readFile(path.join(root, ".acceptance", "agent-smoke-run.json"), "utf8")) as {
    invocations: Array<{ environmentKeys: string[] }>;
  };
  const expectedKeys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LC_ALL", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"];
  for (const invocation of runManifest.invocations) assert.deepEqual(invocation.environmentKeys, expectedKeys);
});

test("历史 live matrix 由 legacy-unbound manifest 生成且不把观察写成可发布 PASS", async () => {
  await execFileAsync(process.execPath, [matrixScript, "--check"], { cwd: repositoryRoot });
  const historyText = await readFile(path.join(repositoryRoot, "docs", "acceptance", "agent-live-history.json"), "utf8");
  const history = JSON.parse(historyText) as { clients: Record<string, Record<string, unknown>> };
  assert.doesNotMatch(historyText, /\/Users\/|wiesenwang|Bearer\s|ghp_|glpat-|sk-/u);
  for (const client of ["codex", "claude", "cursor"]) {
    assert.equal(history.clients[client]?.authorityStatus, "legacy-unbound");
    assert.match(String(history.clients[client]?.runIdHash), /^sha256:[a-f0-9]{64}$/u);
    assert.match(String(history.clients[client]?.status), /no-go$/u);
    assert.doesNotMatch(JSON.stringify(history.clients[client]), /"pass"/u);
  }
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
