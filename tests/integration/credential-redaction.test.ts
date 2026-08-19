import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGithubIssue } from "../../src/adapters/connectors/github-cli.js";
import { IssueProviderError } from "../../src/registry/connectors/issue.js";

function recursivelyAssertAbsent(value: unknown, secrets: readonly string[]): void {
  if (typeof value === "string") for (const secret of secrets) assert.equal(value.includes(secret), false);
  else if (Array.isArray(value)) for (const item of value) recursivelyAssertAbsent(item, secrets);
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    recursivelyAssertAbsent(key, secrets); recursivelyAssertAbsent(item, secrets);
  }
}

test("credentials never survive recursively in provider errors, event-shaped values or artifact-shaped values", async (t) => {
  const secrets = ["ghp_abcdefghijklmnopqrstuvwxyz123456", "glpat-abcdefghijklmnop", "secret.example.com/private"];
  const directory = await mkdtemp(path.join(os.tmpdir(), "wspec-redaction-")); await chmod(directory, 0o700);
  const executable = path.join(directory, "gh");
  await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(`HTTP 403 rate limit Authorization: Bearer ${secrets[0]} host=${secrets[2]} GITLAB_TOKEN=${secrets[1]}`)});process.exitCode=1;\n`, { mode: 0o700 });
  t.after(async () => rm(directory, { recursive: true, force: true }));
  let rejected: unknown;
  try { await readGithubIssue({ executable, target: { host: "github.example.com", owner: "acme", repo: "widget", number: 7 } }); } catch (error) { rejected = error; }
  assert.ok(rejected instanceof IssueProviderError);
  assert.equal(rejected.code, "WSSPEC_ISSUE_RATE_LIMITED");
  const event = { type: "connector.failed", error: rejected, nested: [{ diagnostic: rejected.message }] };
  const artifact = { artifactType: "requirement-source", metadata: { state: "open" }, errors: [event] };
  recursivelyAssertAbsent([rejected, event, artifact], secrets);
});
