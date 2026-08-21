import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGitlabIssue, readGitlabNote, writeGitlabIssue } from "../../src/adapters/connectors/gitlab-cli.js";
import { IssueProviderError, validateGitlabIssueTarget, type IssueWriteAction } from "../../src/registry/connectors/issue.js";

const target = { host: "gitlab.example.com", projectPath: "group/service", iid: 9 } as const;
const openIssue = {
  iid: 9, id: 9001, web_url: "https://gitlab.example.com/group/service/-/issues/9", title: "Title", description: "Body",
  project_id: 901, state: "opened", labels: ["bug"], upvotes: 1, downvotes: 0, merge_requests_count: 0,
  created_at: "2026-08-18T00:00:00Z", updated_at: "2026-08-19T00:00:00Z", closed_at: null,
  author: { id: 9101, username: "author", name: "Redacted Author", state: "active", locked: false, avatar_url: "https://avatars.example.com/9101", web_url: "https://gitlab.example.com/author" },
  assignees: [{ id: 9102, username: "owner", name: "Redacted Owner", state: "active", locked: false, avatar_url: "https://avatars.example.com/9102", web_url: "https://gitlab.example.com/owner" }],
  references: { short: "#9", relative: "#9", full: "group/service#9" },
  _links: { self: "https://gitlab.example.com/api/v4/projects/901/issues/9", notes: "https://gitlab.example.com/api/v4/projects/901/issues/9/notes" },
};
const closedIssue = { ...openIssue, state: "closed" };

async function scriptedCli(t: test.TestContext, responses: readonly unknown[]): Promise<{ executable: string; log: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-glab-test-")); await chmod(root, 0o700);
  const executable = path.join(root, "glab"); const log = path.join(root, "log.ndjson");
  const source = `#!${process.execPath}\nconst { appendFileSync, readFileSync } = require('node:fs');\nlet input=''; process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{ appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(input)})+'\\n');\nconst state=${JSON.stringify(responses)}; const index=readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').length-1; const response=state[index]; if(response&&typeof response==='object'&&'error'in response){process.stderr.write(response.error);process.exitCode=1}else process.stdout.write(JSON.stringify(response)); });\n`;
  await writeFile(executable, source, { mode: 0o700 }); t.after(async () => rm(root, { recursive: true, force: true })); return { executable, log };
}

test("GitLab read encodes projectPath once, uses --hostname, and keeps iid separate from id", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  const issue = await readGitlabIssue({ executable: cli.executable, target });
  const call = JSON.parse((await readFile(cli.log, "utf8")).trim());
  assert.deepEqual(call, { argv: ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--hostname", "gitlab.example.com"], input: {} });
  assert.equal(issue.number, 9); assert.equal(issue.stableId, "gitlab:9001"); assert.equal(issue.repository, "group/service");
  assert.equal(Object.hasOwn(issue, "project_id"), false);
  assert.equal(Object.hasOwn(issue.metadata, "references"), false);
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

test("GitLab rejects credentials across host, projectPath, segments and recursive percent decoding before spawn", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  const encodeLayers = (value: string, count: number): string => {
    let current = value;
    for (let index = 0; index < count; index += 1) current = encodeURIComponent(current);
    return current;
  };
  const targets = [
    { ...target, host: "glpat-abcdefghijklmnop.example.com" },
    { ...target, projectPath: "github_pat_abcdefghijklmnopqrstuvwxyz123456/service" },
    { ...target, projectPath: "group/ghp_abcdefghijklmnopqrstuvwxyz123456" },
    { ...target, projectPath: "group/glpat-abcdefghijklmnop" },
    { ...target, projectPath: "group/t-A1b2C3d4E5f6G7h8I9j0K1l2" },
    { ...target, projectPath: `group/${encodeLayers("glpat-abcdefghijklmnop", 3)}` },
  ];
  for (const credentialTarget of targets) {
    await assert.rejects(readGitlabIssue({ executable: cli.executable, target: credentialTarget }), (error: unknown) =>
      error instanceof IssueProviderError
      && error.code === "WSSPEC_ISSUE_TARGET_INVALID"
      && error.message === "WSSPEC_ISSUE_TARGET_INVALID: Issue 目标包含凭据样式内容。");
  }
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

  assert.doesNotThrow(() => validateGitlabIssueTarget({ ...target, projectPath: "group/glpat-release" }));
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

test("GitLab projects native response fields but still rejects missing, mistyped and oversized required fields", async (t) => {
  const missing = { ...openIssue } as Record<string, unknown>;
  delete missing.web_url;
  const cases = [
    missing,
    { ...openIssue, author: { ...openIssue.author, username: 9101 } },
    { ...openIssue, labels: Array.from({ length: 101 }, (_, index) => `label-${index}`) },
    { ...openIssue, assignees: Array.from({ length: 101 }, (_, index) => ({ ...openIssue.assignees[0], id: 9200 + index, username: `owner-${index}` })) },
    { ...openIssue, labels: ["alpha\r\nline", "alpha\nline"] },
  ];
  for (const response of cases) {
    const cli = await scriptedCli(t, [response]);
    await assert.rejects(readGitlabIssue({ executable: cli.executable, target }), (error: unknown) =>
      error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_RESPONSE_INVALID");
  }

  const marker = "raw-response-marker-glpat-abcdefghijklmnop";
  const cli = await scriptedCli(t, [{ ...openIssue, title: 9, debug: marker }]);
  await assert.rejects(readGitlabIssue({ executable: cli.executable, target }), (error: unknown) =>
    error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_RESPONSE_INVALID" && !error.message.includes(marker));
});

test("GitLab normalizes issue title and body before returning NormalizedIssue", async (t) => {
  const cli = await scriptedCli(t, [{ ...openIssue, title: "Cafe\u0301", description: "First\r\nSecond\rThird" }]);
  const issue = await readGitlabIssue({ executable: cli.executable, target });
  assert.equal(issue.title, "Café");
  assert.equal(issue.body, "First\nSecond\nThird");
});

test("GitLab adoption reads one exact note ID and verifies its approved body and Issue", async (t) => {
  const response = { id: 56, body: "Café\nSecond", noteable_type: "Issue", noteable_iid: 9 };
  const cli = await scriptedCli(t, [response]);
  const note = await readGitlabNote({
    executable: cli.executable,
    target,
    externalStableId: "gitlab-note:56",
    expectedBody: "Cafe\u0301\r\nSecond",
  });
  assert.deepEqual(note, { stableId: "gitlab-note:56", body: "Café\nSecond" });
  const call = JSON.parse((await readFile(cli.log, "utf8")).trim());
  assert.deepEqual(call, {
    argv: ["api", "--method", "GET", "projects/group%2Fservice/issues/9/notes/56", "--hostname", "gitlab.example.com"],
    input: {},
  });

  const mismatched = await scriptedCli(t, [{ ...response, body: "Different" }]);
  await assert.rejects(readGitlabNote({
    executable: mismatched.executable,
    target,
    externalStableId: "gitlab-note:56",
    expectedBody: response.body,
  }), (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_READBACK_MISMATCH");

  const wrongIssue = await scriptedCli(t, [{ ...response, noteable_iid: 10 }]);
  await assert.rejects(readGitlabNote({
    executable: wrongIssue.executable,
    target,
    externalStableId: "gitlab-note:56",
    expectedBody: response.body,
  }), (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_READBACK_MISMATCH");
});

test("GitLab exposes only fixed POST comment and PUT body, labels and state unions", async (t) => {
  const cases: Array<{ action: IssueWriteAction; method: string; endpoint: string; payload: unknown }> = [
    { action: { type: "comment", body: "Approved comment" }, method: "POST", endpoint: "projects/group%2Fservice/issues/9/notes", payload: { body: "Approved comment" } },
    { action: { type: "body", body: "Approved body" }, method: "PUT", endpoint: "projects/group%2Fservice/issues/9", payload: { description: "Approved body" } },
    { action: { type: "labels", labels: ["ready", "bug"] }, method: "PUT", endpoint: "projects/group%2Fservice/issues/9", payload: { labels: ["ready", "bug"] } },
    { action: { type: "state", state: "open" }, method: "PUT", endpoint: "projects/group%2Fservice/issues/9", payload: { state_event: "reopen" } },
  ];
  for (const current of cases) await t.test(current.action.type, async (st) => {
    const response = current.action.type === "comment" ? {
      id: 55,
      type: null,
      body: "Approved comment",
      author: openIssue.author,
      created_at: "2026-08-19T01:00:00Z",
      updated_at: "2026-08-19T01:00:00Z",
      system: false,
      noteable_id: 9001,
      noteable_type: "Issue",
      project_id: 901,
      internal: false,
      confidential: false,
      noteable_iid: 9,
      commands_changes: {},
    }
      : current.action.type === "body" ? { ...openIssue, description: "Approved body" }
        : current.action.type === "labels" ? { ...openIssue, labels: ["ready", "bug"] }
          : openIssue;
    const responses = current.action.type === "comment" ? [response, response, openIssue] : [response, response];
    const cli = await scriptedCli(st, responses);
    const result = await writeGitlabIssue({ executable: cli.executable, target, action: current.action });
    const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], { argv: ["api", "--method", current.method, current.endpoint, "--hostname", "gitlab.example.com", "--input", "-"], input: current.payload });
    if (current.action.type === "comment") {
      assert.equal((result as unknown as Record<string, unknown>).externalEffectId, "gitlab-note:55");
      assert.deepEqual(calls.slice(1).map(({ argv }) => argv), [
        ["api", "--method", "GET", "projects/group%2Fservice/issues/9/notes/55", "--hostname", "gitlab.example.com"],
        ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--hostname", "gitlab.example.com"],
      ]);
    } else {
      assert.equal((result as unknown as Record<string, unknown>).externalEffectId, undefined);
      assert.deepEqual(calls[1]?.argv, ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--hostname", "gitlab.example.com"]);
    }
  });
  const cli = await scriptedCli(t, []);
  await assert.rejects(writeGitlabIssue({ executable: cli.executable, target, action: { type: "raw", flags: ["--paginate"] } as never }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_ACTION_INVALID");
});

test("GitLab rejects generic state closed before spawn so closing only uses issue.close", async (t) => {
  const cli = await scriptedCli(t, []);
  await assert.rejects(
    writeGitlabIssue({ executable: cli.executable, target, action: { type: "state", state: "closed" } as never }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_ACTION_INVALID",
  );
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("GitLab preserves approved stdin and compares canonical note, body and labels readback", async (t) => {
  const approvedText = "Cafe\u0301\r\nSecond\rThird";
  const canonicalText = "Café\nSecond\nThird";
  const approvedLabels = ["Cafe\u0301\r\nready", "alpha\rline"];
  const canonicalLabels = ["alpha\nline", "Café\nready"];
  const cases = [
    {
      name: "comment",
      action: { type: "comment", body: approvedText } as const,
      writeResponse: { id: 56, body: canonicalText, author: openIssue.author, created_at: openIssue.updated_at, noteable_type: "Issue", noteable_iid: 9 },
      readback: openIssue,
      payload: { body: approvedText },
    },
    {
      name: "body",
      action: { type: "body", body: approvedText } as const,
      writeResponse: { ...openIssue, description: canonicalText },
      readback: { ...openIssue, description: canonicalText },
      payload: { description: approvedText },
    },
    {
      name: "labels",
      action: { type: "labels", labels: approvedLabels } as const,
      writeResponse: { ...openIssue, labels: canonicalLabels },
      readback: { ...openIssue, labels: canonicalLabels },
      payload: { labels: approvedLabels },
    },
  ];
  for (const current of cases) await t.test(current.name, async (st) => {
    const cli = await scriptedCli(st, current.action.type === "comment"
      ? [current.writeResponse, current.writeResponse, current.readback]
      : [current.writeResponse, current.readback]);
    await writeGitlabIssue({ executable: cli.executable, target, action: current.action });
    const first = JSON.parse((await readFile(cli.log, "utf8")).split("\n")[0]!);
    assert.deepEqual(first.input, current.payload);
  });

  const duplicate = await scriptedCli(t, []);
  await assert.rejects(
    writeGitlabIssue({ executable: duplicate.executable, target, action: { type: "labels", labels: ["Cafe\u0301", "Café"] } }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_ACTION_INVALID",
  );
  await assert.rejects(access(duplicate.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("GitLab comment write fails when the authoritative note is missing or has different content", async (t) => {
  const posted = { id: 55, body: "Approved comment", noteable_type: "Issue", noteable_iid: 9 };
  for (const scenario of [
    { name: "missing note", readback: openIssue, code: "WSSPEC_ISSUE_RESPONSE_INVALID" },
    { name: "different body", readback: { ...posted, body: "Different" }, code: "WSSPEC_ISSUE_READBACK_MISMATCH" },
  ]) await t.test(scenario.name, async (st) => {
    const cli = await scriptedCli(st, [posted, scenario.readback, openIssue]);
    await assert.rejects(
      writeGitlabIssue({ executable: cli.executable, target, action: { type: "comment", body: posted.body } }),
      (error: unknown) => error instanceof IssueProviderError && error.code === scenario.code,
    );
    const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.map(({ argv }) => argv), [
      ["api", "--method", "POST", "projects/group%2Fservice/issues/9/notes", "--hostname", "gitlab.example.com", "--input", "-"],
      ["api", "--method", "GET", "projects/group%2Fservice/issues/9/notes/55", "--hostname", "gitlab.example.com"],
    ]);
  });
});

test("GitLab issue.close is read-open, PUT close, same-identity closed readback, with idempotent closed success", async (t) => {
  const cli = await scriptedCli(t, [openIssue, closedIssue, closedIssue]);
  assert.equal((await writeGitlabIssue({ executable: cli.executable, target, action: { type: "issue.close" } })).state, "closed");
  const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.argv), [
    ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--hostname", "gitlab.example.com"],
    ["api", "--method", "PUT", "projects/group%2Fservice/issues/9", "--hostname", "gitlab.example.com", "--input", "-"],
    ["api", "--method", "GET", "projects/group%2Fservice/issues/9", "--hostname", "gitlab.example.com"],
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
