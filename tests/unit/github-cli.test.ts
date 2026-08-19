import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGithubIssue, writeGithubIssue } from "../../src/adapters/connectors/github-cli.js";
import { IssueProviderError, type IssueWriteAction } from "../../src/registry/connectors/issue.js";

const target = { host: "github.example.com", owner: "acme", repo: "widget", number: 7 } as const;

async function scriptedCli(t: test.TestContext, responses: readonly unknown[]): Promise<{ executable: string; log: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-gh-test-"));
  await chmod(root, 0o700);
  const executable = path.join(root, "gh");
  const log = path.join(root, "log.ndjson");
  const source = `#!${process.execPath}\nconst { appendFileSync, readFileSync } = require('node:fs');\nlet input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(input)})+'\\n');\nconst state=${JSON.stringify(responses)}; const index=Number(readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').length)-1;\nconst response=state[index]; if (response && typeof response==='object' && 'error' in response) { process.stderr.write(response.error); process.exitCode=1; } else process.stdout.write(JSON.stringify(response)); });\n`;
  await writeFile(executable, source, { mode: 0o700 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { executable, log };
}

const openIssue = {
  number: 7, node_id: "I_kwDOStableNode", html_url: "https://github.example.com/acme/widget/issues/7",
  title: "Title", body: "Body", state: "open", labels: [{ name: "bug" }], updated_at: "2026-08-19T00:00:00Z",
  user: { login: "author" }, assignees: [{ login: "owner" }],
};
const closedIssue = { ...openIssue, state: "closed" };

test("GitHub read emits only the fixed GET argv and keeps number separate from node_id", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  const issue = await readGithubIssue({ executable: cli.executable, target });
  const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, [{ argv: ["api", "--method", "GET", "repos/acme/widget/issues/7", "--hostname", "github.example.com"], input: {} }]);
  assert.equal(issue.number, 7);
  assert.equal(issue.stableId, "github:I_kwDOStableNode");
  assert.equal(issue.repository, "acme/widget");
});

test("GitHub validates and encodes every endpoint segment before spawning", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  for (const malicious of [
    { ...target, owner: "acme/../../secret" },
    { ...target, repo: "repo%2Fissues" },
    { ...target, host: "https://github.example.com/path?token=secret" },
    { ...target, host: "user@github.example.com" },
    { ...target, host: "github.example.com:443" },
    { ...target, number: 0 },
  ]) {
    await assert.rejects(readGithubIssue({ executable: cli.executable, target: malicious }), (error: unknown) =>
      error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_TARGET_INVALID");
  }
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("GitHub rejects token and cross-provider environment fields before spawning", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  for (const environment of [{ GH_TOKEN: "secret" }, { GLAB_CONFIG_DIR: "/private/config" }, { HOME: "relative" }]) {
    await assert.rejects(readGithubIssue({ executable: cli.executable, target, environment: environment as never }), (error: unknown) =>
      error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_CONFIGURATION_INVALID");
  }
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("GitHub rejects schema drift instead of confusing number with node_id", async (t) => {
  const cli = await scriptedCli(t, [{ ...openIssue, number: "I_kwDOStableNode", node_id: 7 }]);
  await assert.rejects(readGithubIssue({ executable: cli.executable, target }), (error: unknown) =>
    error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_RESPONSE_INVALID");
});

test("GitHub normalizes issue title and body before returning NormalizedIssue", async (t) => {
  const cli = await scriptedCli(t, [{ ...openIssue, title: "Cafe\u0301", body: "First\r\nSecond\rThird" }]);
  const issue = await readGithubIssue({ executable: cli.executable, target });
  assert.equal(issue.title, "Café");
  assert.equal(issue.body, "First\nSecond\nThird");
});

test("GitHub exposes only fixed comment, body, labels and state write unions", async (t) => {
  const cases: Array<{ action: IssueWriteAction; method: string; endpoint: string; payload: unknown }> = [
    { action: { type: "comment", body: "Approved comment" }, method: "POST", endpoint: "repos/acme/widget/issues/7/comments", payload: { body: "Approved comment" } },
    { action: { type: "body", body: "Approved body" }, method: "PATCH", endpoint: "repos/acme/widget/issues/7", payload: { body: "Approved body" } },
    { action: { type: "labels", labels: ["ready", "bug"] }, method: "PATCH", endpoint: "repos/acme/widget/issues/7", payload: { labels: ["ready", "bug"] } },
    { action: { type: "state", state: "open" }, method: "PATCH", endpoint: "repos/acme/widget/issues/7", payload: { state: "open" } },
  ];
  for (const current of cases) await t.test(current.action.type, async (st) => {
    const writeResponse = current.action.type === "comment"
      ? { id: 44, node_id: "IC_comment", body: "Approved comment" }
      : current.action.type === "body" ? { ...openIssue, body: "Approved body" }
        : current.action.type === "labels" ? { ...openIssue, labels: [{ name: "ready" }, { name: "bug" }] }
          : openIssue;
    const readback = current.action.type === "comment" ? openIssue : writeResponse;
    const cli = await scriptedCli(st, [writeResponse, readback]);
    await writeGithubIssue({ executable: cli.executable, target, action: current.action });
    const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], { argv: ["api", "--method", current.method, current.endpoint, "--hostname", "github.example.com", "--input", "-"], input: current.payload });
    assert.deepEqual(calls[1]?.argv, ["api", "--method", "GET", "repos/acme/widget/issues/7", "--hostname", "github.example.com"]);
  });

  const cli = await scriptedCli(t, []);
  await assert.rejects(writeGithubIssue({ executable: cli.executable, target, action: { type: "raw", method: "DELETE", endpoint: "/user" } as never }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_ACTION_INVALID");
});

test("GitHub issue.close reads open, writes closed, and reads back the same stable identity", async (t) => {
  const cli = await scriptedCli(t, [openIssue, closedIssue, closedIssue]);
  const issue = await writeGithubIssue({ executable: cli.executable, target, action: { type: "issue.close" } });
  assert.equal(issue.state, "closed");
  const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.argv), [
    ["api", "--method", "GET", "repos/acme/widget/issues/7", "--hostname", "github.example.com"],
    ["api", "--method", "PATCH", "repos/acme/widget/issues/7", "--hostname", "github.example.com", "--input", "-"],
    ["api", "--method", "GET", "repos/acme/widget/issues/7", "--hostname", "github.example.com"],
  ]);
  assert.deepEqual(calls[1]?.input, { state: "closed" });
});

test("GitHub close is idempotent when already closed and never succeeds after readback failure", async (t) => {
  const already = await scriptedCli(t, [closedIssue]);
  assert.equal((await writeGithubIssue({ executable: already.executable, target, action: { type: "issue.close" } })).state, "closed");
  assert.equal((await readFile(already.log, "utf8")).trim().split("\n").length, 1);

  const failed = await scriptedCli(t, [openIssue, closedIssue, { error: "HTTP 404: gone after write" }]);
  await assert.rejects(writeGithubIssue({ executable: failed.executable, target, action: { type: "issue.close" } }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_NOT_FOUND");
});
