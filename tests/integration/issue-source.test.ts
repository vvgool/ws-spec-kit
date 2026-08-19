import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGithubIssue } from "../../src/adapters/connectors/github-cli.js";
import { readGitlabIssue } from "../../src/adapters/connectors/gitlab-cli.js";
import { doctorConnectors } from "../../src/application/doctor-connectors.js";
import { captureRequirement } from "../../src/registry/connectors/requirement-source.js";
import { IssueProviderError, loadIssueConnectorManifests, registerIssueConnectorManifests } from "../../src/registry/connectors/issue.js";
import { ConnectorRegistry } from "../../src/registry/connectors/registry.js";

const root = path.resolve(import.meta.dirname, "../..");
const fixtureBin = path.join(root, "tests/fixtures/bin");

function executeText(executable: string, argv: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(executable, argv, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolve({ stdout, stderr });
      else reject(Object.assign(error, { stderr, stdout }));
    });
    child.stdin?.end("{}");
  });
}

async function privateFixtureBinaries(t: test.TestContext): Promise<{ gh: string; glab: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wspec-issue-cli-")); await chmod(directory, 0o700);
  const gh = path.join(directory, "gh");
  const glab = path.join(directory, "glab");
  await writeFile(gh, await readFile(path.join(fixtureBin, "gh")), { mode: 0o700 });
  await writeFile(glab, await readFile(path.join(fixtureBin, "glab")), { mode: 0o700 });
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { gh, glab };
}

test("private fixture CLI copies create Task 2 source artifacts without real CLI config", async (t) => {
  const { gh, glab } = await privateFixtureBinaries(t);
  assert.equal((await stat(gh)).mode & 0o777, 0o700);
  assert.equal((await stat(glab)).mode & 0o777, 0o700);
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "wspec-issue-source-")); await chmod(repositoryRoot, 0o700);
  t.after(async () => rm(repositoryRoot, { recursive: true, force: true }));

  const github = await readGithubIssue({ executable: gh, target: { host: "github.example.com", owner: "acme", repo: "widget", number: 7 } });
  const gitlab = await readGitlabIssue({ executable: glab, target: { host: "gitlab.example.com", projectPath: "group/service", iid: 9 } });
  const first = await captureRequirement({ repositoryRoot, artifactRoot: repositoryRoot, workItemId: "WSS-GITHUB", source: github });
  const second = await captureRequirement({ repositoryRoot, artifactRoot: repositoryRoot, workItemId: "WSS-GITLAB", source: gitlab });
  assert.deepEqual({ type: first.type, stableId: first.stableId, repository: first.metadata.repository, state: first.metadata.state },
    { type: "github.issue", stableId: "github:I_kwDOStableNode", repository: "acme/widget", state: "open" });
  assert.deepEqual({ type: second.type, stableId: second.stableId, repository: second.metadata.repository, state: second.metadata.state },
    { type: "gitlab.issue", stableId: "gitlab:9001", repository: "group/service", state: "open" });
  assert.match(await readFile(path.join(repositoryRoot, ".wsspec/work-items/WSS-GITHUB/source", `${first.artifactId.slice(7)}.json`), "utf8"), /Ship the connector/u);
});

test("GitLab fixture exposes native --hostname help and rejects the non-native --host flag", async (t) => {
  const { glab } = await privateFixtureBinaries(t);
  const help = await executeText(glab, ["api", "--help"]);
  assert.match(help.stdout, /--hostname string/u);
  assert.equal(help.stdout.includes("--host string"), false);
  await assert.rejects(
    executeText(glab, ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--host", "gitlab.example.com"]),
    (error: unknown) => (error as { code?: number; stderr?: string }).code === 9
      && (error as { stderr?: string }).stderr === "unexpected fixture argv\n",
  );
});

test("provider failures map to stable missing, not-found, auth, forbidden, rate-limit and schema codes", async (t) => {
  const { gh, glab } = await privateFixtureBinaries(t);
  const cases = [
    ["missing", path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`), "acme", "WSSPEC_ISSUE_MISSING_BINARY"],
    ["not found", gh, "not-found", "WSSPEC_ISSUE_NOT_FOUND"],
    ["unauthorized", gh, "unauthorized", "WSSPEC_ISSUE_UNAUTHENTICATED"],
    ["forbidden", gh, "forbidden", "WSSPEC_ISSUE_FORBIDDEN"],
    ["rate limited", gh, "rate-limited", "WSSPEC_ISSUE_RATE_LIMITED"],
    ["schema drift", gh, "drift", "WSSPEC_ISSUE_RESPONSE_INVALID"],
  ] as const;
  for (const [, executable, owner, code] of cases) {
    await assert.rejects(readGithubIssue({ executable, target: { host: "github.example.com", owner, repo: "widget", number: 7 } }),
      (error: unknown) => error instanceof IssueProviderError && error.code === code);
  }

  const gitlabCases = [
    [path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`), "group/missing", "WSSPEC_ISSUE_MISSING_BINARY"],
    [glab, "not-found/service", "WSSPEC_ISSUE_NOT_FOUND"],
    [glab, "unauthorized/service", "WSSPEC_ISSUE_UNAUTHENTICATED"],
    [glab, "forbidden/service", "WSSPEC_ISSUE_FORBIDDEN"],
    [glab, "rate-limited/service", "WSSPEC_ISSUE_RATE_LIMITED"],
    [glab, "drift/service", "WSSPEC_ISSUE_RESPONSE_INVALID"],
  ] as const;
  for (const [executable, projectPath, code] of gitlabCases) {
    await assert.rejects(readGitlabIssue({ executable, target: { host: "gitlab.example.com", projectPath, iid: 9 } }),
      (error: unknown) => error instanceof IssueProviderError && error.code === code);
  }
});

test("strict YAML manifests load, register, and retain the Task 1 doctor contract", async (t) => {
  const { gh, glab } = await privateFixtureBinaries(t);
  const manifests = await loadIssueConnectorManifests(path.join(root, "resources/connectors"));
  assert.deepEqual(manifests.map(({ id, executable, doctor }) => ({ id, executable, version: doctor.version.argv, auth: doctor.auth.kind === "auth" ? doctor.auth.argv : [] })), [
    { id: "github-cli", executable: "gh", version: ["--version"], auth: ["auth", "status", "--active"] },
    { id: "gitlab-cli", executable: "glab", version: ["--version"], auth: ["auth", "status"] },
  ]);
  const registry = registerIssueConnectorManifests(new ConnectorRegistry(), manifests);
  assert.equal(registry.resolve("github.issue", "github-cli").securityClass, "external-write");
  assert.equal(registry.resolve("gitlab.issue", "gitlab-cli").securityClass, "external-write");
  const health = await doctorConnectors({
    manifests,
    locateExecutable: async (name) => name === "gh" ? gh : name === "glab" ? glab : undefined,
  });
  assert.deepEqual(health, [
    { provider: "github-cli", status: "available", version: "2.80.0" },
    { provider: "gitlab-cli", status: "available", version: "1.68.0" },
  ]);
});

test("strict YAML manifest loading rejects audited argv drift and aliases", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wspec-issue-manifest-")); await chmod(directory, 0o700);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const github = await readFile(path.join(root, "resources/connectors/github-cli.yaml"), "utf8");
  const gitlab = await readFile(path.join(root, "resources/connectors/gitlab-cli.yaml"), "utf8");
  await writeFile(path.join(directory, "github-cli.yaml"), github.replace("GET", "DELETE"), { mode: 0o600 });
  await writeFile(path.join(directory, "gitlab-cli.yaml"), gitlab, { mode: 0o600 });
  await assert.rejects(loadIssueConnectorManifests(directory), (error: unknown) =>
    error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_MANIFEST_INVALID");

  await writeFile(path.join(directory, "github-cli.yaml"), github.replace("capabilities:", "shared: &shared [github.issue]\ncapabilities: *shared\nignored:"), { mode: 0o600 });
  await copyFile(path.join(root, "resources/connectors/gitlab-cli.yaml"), path.join(directory, "gitlab-cli.yaml"));
  await assert.rejects(loadIssueConnectorManifests(directory), (error: unknown) =>
    error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_MANIFEST_INVALID");
});
