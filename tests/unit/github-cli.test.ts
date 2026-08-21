import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGithubComment, readGithubIssue, writeGithubIssue } from "../../src/adapters/connectors/github-cli.js";
import { IssueProviderError, validateGithubIssueTarget, type IssueWriteAction } from "../../src/registry/connectors/issue.js";

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
  url: "https://github.example.com/api/v3/repos/acme/widget/issues/7",
  repository_url: "https://github.example.com/api/v3/repos/acme/widget",
  labels_url: "https://github.example.com/api/v3/repos/acme/widget/issues/7/labels{/name}",
  comments_url: "https://github.example.com/api/v3/repos/acme/widget/issues/7/comments",
  events_url: "https://github.example.com/api/v3/repos/acme/widget/issues/7/events",
  id: 7001,
  number: 7, node_id: "I_kwDOStableNode", html_url: "https://github.example.com/acme/widget/issues/7",
  title: "Title", body: "Body", state: "open", locked: false,
  labels: [{ id: 7101, node_id: "LA_label", url: "https://github.example.com/api/v3/repos/acme/widget/labels/bug", name: "bug", color: "d73a4a", default: true, description: "A redacted label" }],
  comments: 2, created_at: "2026-08-18T00:00:00Z", updated_at: "2026-08-19T00:00:00Z", closed_at: null,
  user: { login: "author", id: 7201, node_id: "U_author", avatar_url: "https://avatars.example.com/u/7201", type: "User", site_admin: false },
  assignees: [{ login: "owner", id: 7202, node_id: "U_owner", avatar_url: "https://avatars.example.com/u/7202", type: "User", site_admin: false }],
  author_association: "MEMBER",
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
  assert.equal(Object.hasOwn(issue, "url"), false);
  assert.equal(Object.hasOwn(issue.metadata, "author_association"), false);
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

test("GitHub rejects raw and recursively encoded credential-like target surfaces before spawn", async (t) => {
  const cli = await scriptedCli(t, [openIssue]);
  const encodeLayers = (value: string, count: number): string => {
    let current = value;
    for (let index = 0; index < count; index += 1) current = encodeURIComponent(current);
    return current;
  };
  const targets = [
    { ...target, host: "glpat-abcdefghijklmnop.example.com" },
    { ...target, owner: "github_pat_abcdefghijklmnopqrstuvwxyz123456" },
    { ...target, repo: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
    { ...target, repo: "t-A1b2C3d4E5f6G7h8I9j0K1l2" },
    { ...target, owner: encodeLayers("github_pat_abcdefghijklmnopqrstuvwxyz123456", 2) },
  ];
  for (const credentialTarget of targets) {
    await assert.rejects(readGithubIssue({ executable: cli.executable, target: credentialTarget }), (error: unknown) =>
      error instanceof IssueProviderError
      && error.code === "WSSPEC_ISSUE_TARGET_INVALID"
      && error.message === "WSSPEC_ISSUE_TARGET_INVALID: Issue 目标包含凭据样式内容。");
  }
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

  assert.doesNotThrow(() => validateGithubIssueTarget({ ...target, owner: "github_pat_team", repo: "ghp_docs" }));
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

test("GitHub projects native response fields but still rejects missing, mistyped and oversized required fields", async (t) => {
  const missing = { ...openIssue } as Record<string, unknown>;
  delete missing.updated_at;
  const cases = [
    missing,
    { ...openIssue, user: { ...openIssue.user, login: 7201 } },
    { ...openIssue, labels: Array.from({ length: 101 }, (_, index) => ({ ...openIssue.labels[0], id: 8000 + index, name: `label-${index}` })) },
    { ...openIssue, assignees: Array.from({ length: 101 }, (_, index) => ({ ...openIssue.assignees[0], id: 9000 + index, login: `owner-${index}` })) },
    { ...openIssue, labels: [{ ...openIssue.labels[0], name: "alpha\r\nline" }, { ...openIssue.labels[0], id: 7102, name: "alpha\nline" }] },
  ];
  for (const response of cases) {
    const cli = await scriptedCli(t, [response]);
    await assert.rejects(readGithubIssue({ executable: cli.executable, target }), (error: unknown) =>
      error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_RESPONSE_INVALID");
  }

  const marker = "raw-response-marker-ghp_abcdefghijklmnopqrstuvwxyz123456";
  const cli = await scriptedCli(t, [{ ...openIssue, title: 7, debug: marker }]);
  await assert.rejects(readGithubIssue({ executable: cli.executable, target }), (error: unknown) =>
    error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_RESPONSE_INVALID" && !error.message.includes(marker));
});

test("GitHub normalizes issue title and body before returning NormalizedIssue", async (t) => {
  const cli = await scriptedCli(t, [{ ...openIssue, title: "Cafe\u0301", body: "First\r\nSecond\rThird" }]);
  const issue = await readGithubIssue({ executable: cli.executable, target });
  assert.equal(issue.title, "Café");
  assert.equal(issue.body, "First\nSecond\nThird");
});

test("GitHub adoption reads one exact comment ID and verifies its approved body and Issue", async (t) => {
  const response = {
    id: 44,
    node_id: "IC_comment",
    body: "Café\nSecond",
    issue_url: "https://github.example.com/api/v3/repos/acme/widget/issues/7",
  };
  const cli = await scriptedCli(t, [response]);
  const comment = await readGithubComment({
    executable: cli.executable,
    target,
    externalStableId: "github-comment:44",
    expectedBody: "Cafe\u0301\r\nSecond",
  });
  assert.deepEqual(comment, { stableId: "github-comment:44", body: "Café\nSecond" });
  const call = JSON.parse((await readFile(cli.log, "utf8")).trim());
  assert.deepEqual(call, {
    argv: ["api", "--method", "GET", "repos/acme/widget/issues/comments/44", "--hostname", "github.example.com"],
    input: {},
  });

  const mismatched = await scriptedCli(t, [{ ...response, id: 45 }]);
  await assert.rejects(readGithubComment({
    executable: mismatched.executable,
    target,
    externalStableId: "github-comment:44",
    expectedBody: response.body,
  }), (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_READBACK_MISMATCH");

  const wrongIssue = await scriptedCli(t, [{ ...response, issue_url: "https://github.example.com/api/v3/repos/acme/widget/issues/8" }]);
  await assert.rejects(readGithubComment({
    executable: wrongIssue.executable,
    target,
    externalStableId: "github-comment:44",
    expectedBody: response.body,
  }), (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_READBACK_MISMATCH");
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
      ? {
          url: "https://github.example.com/api/v3/repos/acme/widget/issues/comments/44",
          html_url: "https://github.example.com/acme/widget/issues/7#issuecomment-44",
          issue_url: "https://github.example.com/api/v3/repos/acme/widget/issues/7",
          id: 44,
          node_id: "IC_comment",
          user: openIssue.user,
          created_at: "2026-08-19T01:00:00Z",
          updated_at: "2026-08-19T01:00:00Z",
          author_association: "MEMBER",
          body: "Approved comment",
          reactions: { url: "https://github.example.com/api/v3/repos/acme/widget/issues/comments/44/reactions", total_count: 0 },
        }
      : current.action.type === "body" ? { ...openIssue, body: "Approved body" }
        : current.action.type === "labels" ? { ...openIssue, labels: [{ name: "ready" }, { name: "bug" }] }
          : openIssue;
    const responses = current.action.type === "comment"
      ? [writeResponse, writeResponse, openIssue]
      : [writeResponse, writeResponse];
    const cli = await scriptedCli(st, responses);
    const result = await writeGithubIssue({ executable: cli.executable, target, action: current.action });
    const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], { argv: ["api", "--method", current.method, current.endpoint, "--hostname", "github.example.com", "--input", "-"], input: current.payload });
    if (current.action.type === "comment") {
      assert.equal((result as unknown as Record<string, unknown>).externalEffectId, "github-comment:44");
      assert.deepEqual(calls.slice(1).map(({ argv }) => argv), [
        ["api", "--method", "GET", "repos/acme/widget/issues/comments/44", "--hostname", "github.example.com"],
        ["api", "--method", "GET", "repos/acme/widget/issues/7", "--hostname", "github.example.com"],
      ]);
    } else {
      assert.equal((result as unknown as Record<string, unknown>).externalEffectId, undefined);
      assert.deepEqual(calls[1]?.argv, ["api", "--method", "GET", "repos/acme/widget/issues/7", "--hostname", "github.example.com"]);
    }
  });

  const cli = await scriptedCli(t, []);
  await assert.rejects(writeGithubIssue({ executable: cli.executable, target, action: { type: "raw", method: "DELETE", endpoint: "/user" } as never }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_ACTION_INVALID");
});

test("GitHub rejects generic state closed before spawn so closing only uses issue.close", async (t) => {
  const cli = await scriptedCli(t, []);
  await assert.rejects(
    writeGithubIssue({ executable: cli.executable, target, action: { type: "state", state: "closed" } as never }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_ACTION_INVALID",
  );
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("GitHub preserves approved stdin and compares canonical comment, body and labels readback", async (t) => {
  const approvedText = "Cafe\u0301\r\nSecond\rThird";
  const canonicalText = "Café\nSecond\nThird";
  const approvedLabels = ["Cafe\u0301\r\nready", "alpha\rline"];
  const canonicalLabels = ["alpha\nline", "Café\nready"];
  const cases = [
    {
      name: "comment",
      action: { type: "comment", body: approvedText } as const,
      writeResponse: {
        id: 45,
        node_id: "IC_canonical",
        body: canonicalText,
        issue_url: "https://github.example.com/api/v3/repos/acme/widget/issues/7",
        user: openIssue.user,
        created_at: openIssue.updated_at,
      },
      readback: openIssue,
      payload: { body: approvedText },
    },
    {
      name: "body",
      action: { type: "body", body: approvedText } as const,
      writeResponse: { ...openIssue, body: canonicalText },
      readback: { ...openIssue, body: canonicalText },
      payload: { body: approvedText },
    },
    {
      name: "labels",
      action: { type: "labels", labels: approvedLabels } as const,
      writeResponse: { ...openIssue, labels: canonicalLabels.map((name, index) => ({ ...openIssue.labels[0], id: 7300 + index, node_id: `LA_canonical_${index}`, name })) },
      readback: { ...openIssue, labels: canonicalLabels.map((name, index) => ({ ...openIssue.labels[0], id: 7400 + index, node_id: `LA_readback_${index}`, name })) },
      payload: { labels: approvedLabels },
    },
  ];
  for (const current of cases) await t.test(current.name, async (st) => {
    const cli = await scriptedCli(st, current.action.type === "comment"
      ? [current.writeResponse, current.writeResponse, current.readback]
      : [current.writeResponse, current.readback]);
    await writeGithubIssue({ executable: cli.executable, target, action: current.action });
    const first = JSON.parse((await readFile(cli.log, "utf8")).split("\n")[0]!);
    assert.deepEqual(first.input, current.payload);
  });

  const duplicate = await scriptedCli(t, []);
  await assert.rejects(
    writeGithubIssue({ executable: duplicate.executable, target, action: { type: "labels", labels: ["Cafe\u0301", "Café"] } }),
    (error: unknown) => error instanceof IssueProviderError && error.code === "WSSPEC_ISSUE_ACTION_INVALID",
  );
  await assert.rejects(access(duplicate.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("GitHub comment write fails when the authoritative comment is missing or has different content", async (t) => {
  const posted = {
    id: 44,
    node_id: "IC_comment",
    body: "Approved comment",
    issue_url: "https://github.example.com/api/v3/repos/acme/widget/issues/7",
  };
  for (const scenario of [
    { name: "missing comment", readback: openIssue, code: "WSSPEC_ISSUE_RESPONSE_INVALID" },
    { name: "different body", readback: { ...posted, body: "Different" }, code: "WSSPEC_ISSUE_READBACK_MISMATCH" },
  ]) await t.test(scenario.name, async (st) => {
    const cli = await scriptedCli(st, [posted, scenario.readback, openIssue]);
    await assert.rejects(
      writeGithubIssue({ executable: cli.executable, target, action: { type: "comment", body: posted.body } }),
      (error: unknown) => error instanceof IssueProviderError && error.code === scenario.code,
    );
    const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.map(({ argv }) => argv), [
      ["api", "--method", "POST", "repos/acme/widget/issues/7/comments", "--hostname", "github.example.com", "--input", "-"],
      ["api", "--method", "GET", "repos/acme/widget/issues/comments/44", "--hostname", "github.example.com"],
    ]);
  });
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
