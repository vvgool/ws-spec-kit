import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGitlabIssue, writeGitlabIssue } from "../../src/adapters/connectors/gitlab-cli.js";
import { IssueProviderError, type IssueWriteAction } from "../../src/registry/connectors/issue.js";

const target = { host: "gitlab.example.com", projectPath: "group/service", iid: 9 } as const;
const openIssue = {
  iid: 9, id: 9001, web_url: "https://gitlab.example.com/group/service/-/issues/9", title: "Title", description: "Body",
  state: "opened", labels: ["bug"], updated_at: "2026-08-19T00:00:00Z", author: { username: "author" }, assignees: [{ username: "owner" }],
};
const closedIssue = { ...openIssue, state: "closed" };

async function scriptedCli(t: test.TestContext, responses: readonly unknown[]): Promise<{ executable: string; log: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-glab-test-")); await chmod(root, 0o700);
  const executable = path.join(root, "glab"); const log = path.join(root, "log.ndjson");
  const source = `#!${process.execPath}\nconst { appendFileSync, readFileSync } = require('node:fs');\nlet input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{ appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(input)})+'\\n');\nconst state=${JSON.stringify(responses)}; const index=readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').length-1; const response=state[index]; if(response&&typeof response==='object'&&'error'in response){process.stderr.write(response.error);process.exitCode=1}else process.stdout.write(JSON.stringify(response)); });\n`;
  await writeFile(executable, source, { mode: 0o700 }); t.after(async () => rm(root, { recursive: true, force: true })); return { executable, log };
}

test("GitLab read encodes projectPath once, uses --host, and keeps iid separate from id", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  const issue = await readGitlabIssue({ executable: cli.executable, target });
  const call = JSON.parse((await readFile(cli.log, "utf8")).trim());
  assert.deepEqual(call, { argv: ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--host", "gitlab.example.com"], input: {} });
  assert.equal(issue.number, 9); assert.equal(issue.stableId, "gitlab:9001"); assert.equal(issue.repository, "group/service");
});

test("GitLab rejects malicious project segments, host authority, ports and invalid iid before spawn", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  for (const malicious of [
    { ...target, projectPath: "group/../secret" }, { ...target, projectPath: "group/%2Fsecret" }, { ...target, projectPath: "/group/service" },
    { ...target, host: "https://gitlab.example.com/path" }, { ...target, host: "user@gitlab.example.com" }, { ...target, host: "gitlab.example.com:443" }, { ...target, iid: -1 },
  ]) await assert.rejects(readGitlabIssue({ executable: cli.executable, target: malicious }), (error: unknown) =>
    error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_TARGET_INVALID");
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("GitLab rejects token and cross-provider environment fields before spawning", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  for (const environment of [{ GITLAB_TOKEN: "secret" }, { GH_CONFIG_DIR: "/private/config" }, { HOME: "relative" }]) {
    await assert.rejects(readGitlabIssue({ executable: cli.executable, target, environment: environment as never }), (error: unknown) =>
      error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_CONFIGURATION_INVALID");
  }
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("GitLab rejects schema drift instead of confusing iid with global id", async (t) => {
  const cli = await scriptedCli(t, [{ ...openIssue, iid: 9001, id: 9 }]);
  await assert.rejects(readGitlabIssue({ executable: cli.executable, target }), (error: unknown) =>
    error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_RESPONSE_INVALID");
});

test("GitLab normalizes issue title and body before returning NormalizedIssue", async (t) => {
  const cli = await scriptedCli(t, [{ ...openIssue, title: "Cafe\u0301", description: "First\r\nSecond\rThird" }]);
  const issue = await readGitlabIssue({ executable: cli.executable, target });
  assert.equal(issue.title, "Café");
  assert.equal(issue.body, "First\nSecond\nThird");
});

test("GitLab exposes only fixed POST comment and PUT body, labels and state unions", async (t) => {
  const cases: Array<{ action: IssueWriteAction; method: string; endpoint: string; payload: unknown }> = [
    { action: { type: "comment", body: "Approved comment" }, method: "POST", endpoint: "projects/group%2Fservice/issues/9/notes", payload: { body: "Approved comment" } },
    { action: { type: "body", body: "Approved body" }, method: "PUT", endpoint: "projects/group%2Fservice/issues/9", payload: { description: "Approved body" } },
    { action: { type: "labels", labels: ["ready", "bug"] }, method: "PUT", endpoint: "projects/group%2Fservice/issues/9", payload: { labels: ["ready", "bug"] } },
    { action: { type: "state", state: "open" }, method: "PUT", endpoint: "projects/group%2Fservice/issues/9", payload: { state_event: "reopen" } },
  ];
  for (const current of cases) await t.test(current.action.type, async (st) => {
    const response = current.action.type === "comment" ? { id: 55, body: "Approved comment" }
      : current.action.type === "body" ? { ...openIssue, description: "Approved body" }
        : current.action.type === "labels" ? { ...openIssue, labels: ["ready", "bug"] }
          : openIssue;
    const readback = current.action.type === "comment" ? openIssue : response;
    const cli = await scriptedCli(st, [response, readback]); await writeGitlabIssue({ executable: cli.executable, target, action: current.action });
    const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], { argv: ["api", "--method", current.method, current.endpoint, "--host", "gitlab.example.com", "--input", "-"], input: current.payload });
    assert.deepEqual(calls[1]?.argv, ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--host", "gitlab.example.com"]);
  });
  const cli = await scriptedCli(t, []);
  await assert.rejects(writeGitlabIssue({ executable: cli.executable, target, action: { type: "raw", flags: ["--paginate"] } as never }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_ACTION_INVALID");
});

test("GitLab issue.close is read-open, PUT close, same-identity closed readback, with idempotent closed success", async (t) => {
  const cli = await scriptedCli(t, [openIssue, closedIssue, closedIssue]);
  assert.equal((await writeGitlabIssue({ executable: cli.executable, target, action: { type: "issue.close" } })).state, "closed");
  const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.argv), [
    ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--host", "gitlab.example.com"],
    ["api", "--method", "PUT", "projects/group%2Fservice/issues/9", "--host", "gitlab.example.com", "--input", "-"],
    ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--host", "gitlab.example.com"],
  ]);
  assert.deepEqual(calls[1]?.input, { state_event: "close" });

  const already = await scriptedCli(t, [closedIssue]);
  assert.equal((await writeGitlabIssue({ executable: already.executable, target, action: { type: "issue.close" } })).state, "closed");
  assert.equal((await readFile(already.log, "utf8")).trim().split("\n").length, 1);
});

test("GitLab does not return success when close write succeeds but readback identity changes", async (t) => {
  const cli = await scriptedCli(t, [openIssue, closedIssue, { ...closedIssue, id: 9002 }]);
  await assert.rejects(writeGitlabIssue({ executable: cli.executable, target, action: { type: "issue.close" } }), (error: unknown) =>
    error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_IDENTITY_MISMATCH");
});
