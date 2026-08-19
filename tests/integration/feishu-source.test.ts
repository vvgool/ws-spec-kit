import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readFeishuDocument } from "../../src/adapters/connectors/lark-cli.js";
import { captureRequirement } from "../../src/registry/connectors/requirement-source.js";

const root = path.resolve(import.meta.dirname, "../..");

async function privateLarkCli(t: test.TestContext): Promise<{ executable: string; config: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wspec-lark-fixture-"));
  await chmod(directory, 0o700);
  const executable = path.join(directory, "lark-cli");
  const config = path.join(directory, "config");
  await chmod(directory, 0o700);
  await writeFile(executable, await readFile(path.join(root, "tests/fixtures/bin/lark-cli")), { mode: 0o700 });
  await writeFile(path.join(directory, ".private"), "fixture", { mode: 0o600 });
  await import("node:fs/promises").then(({ mkdir }) => mkdir(config, { mode: 0o700 }));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { executable, config };
}

test("private lark fixture captures a normalized immutable Task 2 Source Artifact without network", async (t) => {
  const cli = await privateLarkCli(t);
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "wspec-feishu-source-"));
  await chmod(repositoryRoot, 0o700);
  t.after(async () => rm(repositoryRoot, { recursive: true, force: true }));
  const source = await readFeishuDocument({
    executable: cli.executable,
    document: "https://tenant.feishu.cn/docx/sourceDocumentToken123",
    environment: { LARK_CONFIG_DIR: cli.config },
  });
  const artifact = await captureRequirement({ repositoryRoot, artifactRoot: repositoryRoot, workItemId: "WSS-FEISHU", source });
  assert.deepEqual({ type: artifact.type, stableId: artifact.stableId, owner: artifact.metadata.owner, revision: artifact.metadata.revision }, {
    type: "feishu.document",
    stableId: "feishu:sourceDocumentToken123",
    owner: "owner-a",
    revision: "7",
  });
  const stored = await readFile(path.join(repositoryRoot, ".wsspec/work-items/WSS-FEISHU/source", `${artifact.artifactId.slice(7)}.json`), "utf8");
  assert.match(stored, /Capture this document\.\\n/u);
  assert.equal(stored.includes("permission_debug"), false);
  const calls = (await readFile(path.join(cli.config, "calls.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, [{ argv: ["docs", "+fetch", "--doc", "sourceDocumentToken123", "--format", "json", "--as", "user"] }]);
  await assert.rejects(access(path.join(cli.config, "network.log")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("fixture pagination remains one normalized Source Artifact", async (t) => {
  const cli = await privateLarkCli(t);
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "wspec-feishu-paged-"));
  await chmod(repositoryRoot, 0o700);
  t.after(async () => rm(repositoryRoot, { recursive: true, force: true }));
  const source = await readFeishuDocument({ executable: cli.executable, document: "pagedDocumentToken123", environment: { LARK_CONFIG_DIR: cli.config } });
  const artifact = await captureRequirement({ repositoryRoot, artifactRoot: repositoryRoot, workItemId: "WSS-FEISHU-PAGED", source });
  assert.equal(artifact.body, "First page\nSecond page");
});

test("credential-bearing Feishu response fields never reach a Source Artifact or fixture log", async (t) => {
  const cases = [
    { document: "secretTitleDocument123", secret: "glpat%25252Dabcdefghijklmnop" },
    { document: "secretMarkdownDocument123", secret: "Authorization%253A%2520Bearer%2520github_pat_abcdefghijklmnopqrstuvwxyz123456" },
    { document: "secretMetadataDocument123", secret: "t%25252DA1b2C3d4E5f6G7h8I9j0K1l2" },
    { document: "invalidPercentDocument123", secret: "invalid %GG surface" },
    { document: "deepEncodedDocument123", secret: "ordinary%2525252520value" },
  ];
  for (const current of cases) await t.test(current.document, async (st) => {
    const cli = await privateLarkCli(st);
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "wspec-feishu-confidential-"));
    await chmod(repositoryRoot, 0o700);
    st.after(async () => rm(repositoryRoot, { recursive: true, force: true }));
    await assert.rejects((async () => {
      const source = await readFeishuDocument({ executable: cli.executable, document: current.document, environment: { LARK_CONFIG_DIR: cli.config } });
      await captureRequirement({ repositoryRoot, artifactRoot: repositoryRoot, workItemId: "WSS-FEISHU-SECRET", source });
    })(), (error: unknown) => (error as { code?: string; message?: string }).code === "WSSPEC_FEISHU_RESPONSE_INVALID"
      && !(error as { message: string }).message.includes(current.secret));
    await assert.rejects(access(path.join(repositoryRoot, ".wsspec")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    const log = await readFile(path.join(cli.config, "calls.ndjson"), "utf8");
    assert.equal(log.includes(current.secret), false);
    assert.deepEqual(JSON.parse(log).argv, ["docs", "+fetch", "--doc", current.document, "--format", "json", "--as", "user"]);
  });
});
