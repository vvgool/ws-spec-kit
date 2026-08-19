import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readFeishuDocument } from "../../src/adapters/connectors/lark-cli.js";
import { sha256 } from "../../src/domain/digests.js";
import {
  FeishuDocumentError,
  loadLarkConnectorManifest,
  registerLarkConnectorManifest,
  validateFeishuDocumentTarget,
} from "../../src/registry/connectors/feishu-document.js";
import { ConnectorRegistry } from "../../src/registry/connectors/registry.js";

interface ScriptedCli {
  executable: string;
  log: string;
}

async function scriptedCli(t: test.TestContext, responses: readonly unknown[]): Promise<ScriptedCli> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-lark-unit-"));
  await chmod(root, 0o700);
  const executable = path.join(root, "lark-cli");
  const log = path.join(root, "calls.ndjson");
  const source = [
    `#!${process.execPath}`,
    `const { appendFileSync } = require("node:fs")`,
    `const argv = process.argv.slice(2)`,
    `let input = ""`,
    `process.stdin.on("data", chunk => input += chunk)`,
    `process.stdin.on("end", () => {`,
    `  JSON.parse(input || "{}")`,
    `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv}) + "\\n")`,
    `  const responses = ${JSON.stringify(responses)}`,
    `  const index = Number(require("node:fs").readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length - 1)`,
    `  const response = responses[index]`,
    `  if (response && response.exitCode) { process.stderr.write(response.stderr); process.exitCode = response.exitCode }`,
    `  else process.stdout.write(JSON.stringify(response))`,
    `})`,
    "",
  ].join("\n");
  await writeFile(executable, source, { mode: 0o700 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { executable, log };
}

const document = {
  doc_id: "sourceDocumentToken123",
  doc_url: "https://tenant.feishu.cn/docx/sourceDocumentToken123",
  title: "Connector source",
  markdown: "First line\r\nSecond line",
  has_more: false,
  owner: "owner-a",
  revision: "7",
  space: "delivery",
  updated_at: "2026-08-19T01:02:03Z",
  native_extra: { ignored: true },
};

test("Feishu fetch emits the fixed JSON argv with user default and projects native extras", async (t) => {
  const cli = await scriptedCli(t, [document]);
  const result = await readFeishuDocument({ executable: cli.executable, document: "sourceDocumentToken123" });
  const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, [{ argv: ["docs", "+fetch", "--doc", "sourceDocumentToken123", "--format", "json", "--as", "user"] }]);
  assert.deepEqual(result, {
    type: "feishu.document",
    stableId: "feishu:sourceDocumentToken123",
    documentToken: "sourceDocumentToken123",
    canonicalUrl: "https://tenant.feishu.cn/docx/sourceDocumentToken123",
    title: "Connector source",
    body: "First line\nSecond line",
    updatedAt: "2026-08-19T01:02:03.000Z",
    metadata: { owner: "owner-a", revision: "7", space: "delivery" },
  });
});

test("Feishu fetch accepts canonical document URLs and explicit bot identity", async (t) => {
  const cli = await scriptedCli(t, [document]);
  await readFeishuDocument({
    executable: cli.executable,
    document: "https://tenant.feishu.cn/docx/sourceDocumentToken123",
    identity: "bot",
  });
  const call = JSON.parse((await readFile(cli.log, "utf8")).trim());
  assert.deepEqual(call.argv, ["docs", "+fetch", "--doc", "sourceDocumentToken123", "--format", "json", "--as", "bot"]);
});

test("Feishu target validation rejects malformed, ambiguous and recursively encoded secrets", () => {
  for (const candidate of [
    "",
    "../sourceDocumentToken123",
    "https://example.com/docx/sourceDocumentToken123",
    "https://tenant.feishu.cn/docx/sourceDocumentToken123?token=secret",
    "https://user@tenant.feishu.cn/docx/sourceDocumentToken123",
    "https://tenant.feishu.cn/docx/sourceDocumentToken123/extra",
    "https://tenant.feishu.cn/wiki/glpat-abcdefghijklmnop",
    "https://tenant.feishu.cn/docx/glpat-abcdefghijklmnop",
    "https://tenant.feishu.cn/docx/glpat%25252Dabcdefghijklmnop",
    "glpat%25252Dabcdefghijklmnop",
  ]) {
    assert.throws(() => validateFeishuDocumentTarget(candidate), (error: unknown) =>
      error instanceof FeishuDocumentError && error.code === "WSSPEC_FEISHU_TARGET_INVALID");
  }
});

test("Feishu fetch follows bounded offset pagination and combines canonical Markdown", async (t) => {
  const cli = await scriptedCli(t, [
    { ...document, markdown: "First\r\n", has_more: true, next_offset: 2 },
    { ...document, markdown: "Second", has_more: false },
  ]);
  const result = await readFeishuDocument({ executable: cli.executable, document: "sourceDocumentToken123" });
  assert.equal(result.body, "First\nSecond");
  const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map(({ argv }) => argv), [
    ["docs", "+fetch", "--doc", "sourceDocumentToken123", "--format", "json", "--as", "user"],
    ["docs", "+fetch", "--doc", "sourceDocumentToken123", "--offset", "2", "--limit", "100", "--format", "json", "--as", "user"],
  ]);
});

test("Feishu pagination rejects cursor loops and aggregate overflow", async (t) => {
  const loop = await scriptedCli(t, [
    { ...document, has_more: true, next_offset: 2 },
    { ...document, has_more: true, next_offset: 2 },
  ]);
  await assert.rejects(readFeishuDocument({ executable: loop.executable, document: "sourceDocumentToken123" }), (error: unknown) =>
    error instanceof FeishuDocumentError && error.code === "WSSPEC_FEISHU_PAGINATION_INVALID");

  const overflow = await scriptedCli(t, [{ ...document, markdown: "x".repeat(1_048_577) }]);
  await assert.rejects(readFeishuDocument({ executable: overflow.executable, document: "sourceDocumentToken123" }), (error: unknown) =>
    error instanceof FeishuDocumentError && error.code === "WSSPEC_FEISHU_RESPONSE_TOO_LARGE");
});

test("Feishu response required fields fail closed while native extra fields remain allowed", async (t) => {
  const missing = { ...document } as Record<string, unknown>;
  delete missing.markdown;
  for (const response of [
    missing,
    { ...document, title: 7 },
    { ...document, has_more: "false" },
    { ...document, doc_id: "otherDocumentToken123" },
    { ...document, owner: "glpat-abcdefghijklmnop" },
  ]) {
    const cli = await scriptedCli(t, [response]);
    await assert.rejects(readFeishuDocument({ executable: cli.executable, document: "sourceDocumentToken123" }), (error: unknown) =>
      error instanceof FeishuDocumentError && error.code === "WSSPEC_FEISHU_RESPONSE_INVALID");
  }
});

test("Feishu maps authentication and rate-limit failures without leaking diagnostics", async (t) => {
  const secret = "t-secret-abcdefghijklmnopqrstuvwxyz123456";
  for (const [stderr, code] of [
    [`HTTP 401 authentication required access_token=${secret}`, "WSSPEC_FEISHU_UNAUTHENTICATED"],
    ["HTTP 429 too many requests", "WSSPEC_FEISHU_RATE_LIMITED"],
  ] as const) {
    const cli = await scriptedCli(t, [{ exitCode: 1, stderr }]);
    await assert.rejects(readFeishuDocument({ executable: cli.executable, document: "sourceDocumentToken123" }), (error: unknown) =>
      error instanceof FeishuDocumentError && error.code === code && !error.message.includes(secret));
  }
});

test("lark connector manifest preserves audited argv and unavailable Doctor auth semantics", async () => {
  const manifest = await loadLarkConnectorManifest();
  assert.equal(manifest.id, "lark-cli");
  assert.deepEqual(manifest.capabilities, ["feishu.document", "document.read", "knowledge.publish"]);
  assert.deepEqual(manifest.argvTemplates, [
    ["docs", "+fetch", "--doc", "{documentToken}", "--format", "json", "--as", "{identity}"],
    ["docs", "+fetch", "--doc", "{documentToken}", "--offset", "{offset}", "--limit", "100", "--format", "json", "--as", "{identity}"],
    ["docs", "+create", "--title", "{title}", "--folder-token", "{folderToken}", "--markdown", "{markdown}", "--as", "{identity}"],
    ["docs", "+create", "--title", "{title}", "--wiki-node", "{wikiNode}", "--markdown", "{markdown}", "--as", "{identity}"],
    ["docs", "+create", "--title", "{title}", "--wiki-space", "{wikiSpace}", "--markdown", "{markdown}", "--as", "{identity}"],
    ["docs", "+update", "--doc", "{documentToken}", "--mode", "overwrite", "--markdown", "{markdown}", "--new-title", "{title}", "--as", "{identity}"],
  ]);
  assert.deepEqual(manifest.doctor.auth, { kind: "unavailable", reasonCode: "WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE" });
  const registry = registerLarkConnectorManifest(new ConnectorRegistry(), manifest);
  assert.equal(registry.resolve("feishu.document", "lark-cli").id, "lark-cli");
  assert.equal(registry.resolve("knowledge.publish", "lark-cli").securityClass, "external-write");
  assert.equal(manifest.argvTemplates.flat().includes("--format"), true);
  assert.equal(manifest.argvTemplates.slice(2).flat().includes("--format"), false);
  assert.equal(sha256("Published body\n"), "sha256:6d26dee3848cb7cd7cb33b3c78a5d81ce3c0f2f13de0f7329768330189ef6b35");
});
