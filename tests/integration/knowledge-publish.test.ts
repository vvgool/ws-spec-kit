import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishKnowledge } from "../../src/adapters/connectors/lark-cli.js";
import { sha256 } from "../../src/domain/digests.js";
import type { ExternalBinding } from "../../src/domain/external-receipt.js";
import { externalReceiptMatches } from "../../src/domain/external-receipt.js";
import { KnowledgePublishError, validateKnowledgePublishTarget } from "../../src/registry/connectors/knowledge-publish.js";

const root = path.resolve(import.meta.dirname, "../..");

async function privateLarkCli(t: test.TestContext): Promise<{ executable: string; config: string; log: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wspec-lark-publish-"));
  await chmod(directory, 0o700);
  const executable = path.join(directory, "lark-cli");
  const config = path.join(directory, "config");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(config, { mode: 0o700 }));
  await writeFile(executable, await readFile(path.join(root, "tests/fixtures/bin/lark-cli")), { mode: 0o700 });
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return { executable, config, log: path.join(config, "calls.ndjson") };
}

function binding(stableId: string, markdown = "Published body\n"): ExternalBinding {
  return {
    version: 1,
    kind: "external-binding",
    target: "knowledge",
    exists: true,
    stableId,
    externalWorkItemId: "WSS-KNOWLEDGE",
    publishStepId: "publish-knowledge",
    publishAttemptId: "attempt-publish-1",
    publishInputDigest: `sha256:${"1".repeat(64)}`,
    expectedPublishedContentDigest: sha256(markdown),
  };
}

function safeArgv(argv: readonly string[]): readonly string[] {
  const index = argv.indexOf("--markdown");
  return index < 0 ? argv : argv.map((part, current) => current === index + 1 ? "<redacted>" : part);
}

function encodeLayers(value: string, layers: number): string {
  let result = value;
  for (let index = 0; index < layers; index += 1) result = encodeURIComponent(result);
  return result;
}

test("knowledge create supports each exact target, uses default JSON output, then fetches the created token", async (t) => {
  const targets = [
    { target: { folderToken: "folderToken123456", title: "Published title", markdown: "Published body\n" }, flag: "--folder-token", token: "folderToken123456" },
    { target: { wikiNode: "wikiNodeToken12345", title: "Published title", markdown: "Published body\n" }, flag: "--wiki-node", token: "wikiNodeToken12345" },
    { target: { wikiSpace: "7000000000000000000", title: "Published title", markdown: "Published body\n" }, flag: "--wiki-space", token: "7000000000000000000" },
  ] as const;
  for (const current of targets) await t.test(current.flag, async (st) => {
    const cli = await privateLarkCli(st);
    const currentBinding = binding(`feishu-target:${current.token}`);
    const receipt = await publishKnowledge({
      executable: cli.executable,
      target: current.target,
      binding: currentBinding,
      environment: { LARK_CONFIG_DIR: cli.config },
    });
    assert.equal(externalReceiptMatches({ receipt, target: "knowledge", binding: currentBinding, readBackRequired: true }), true);
    const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; markdownDigest?: string });
    assert.equal(calls[0]!.markdownDigest, "sha256:6d26dee3848cb7cd7cb33b3c78a5d81ce3c0f2f13de0f7329768330189ef6b35");
    assert.deepEqual(safeArgv(calls[0]!.argv), ["docs", "+create", "--title", "Published title", current.flag, current.token, "--markdown", "<redacted>", "--as", "user"]);
    assert.deepEqual(calls[1]!.argv, ["docs", "+fetch", "--doc", "createdDocumentToken123", "--format", "json", "--as", "user"]);
    assert.equal(calls.flatMap(({ argv }) => argv).includes("--format"), true);
    assert.equal(calls[0]!.argv.includes("--format"), false);
  });
});

test("knowledge update requires a document token, overwrites title/body, and reads the same token back", async (t) => {
  const cli = await privateLarkCli(t);
  const currentBinding = binding("feishu:existingDocumentToken123", "Updated caf\u00e9\n");
  const receipt = await publishKnowledge({
    executable: cli.executable,
    target: { documentToken: "existingDocumentToken123", title: "Updated title", markdown: "Updated cafe\u0301\r\n" },
    binding: currentBinding,
    identity: "bot",
    environment: { LARK_CONFIG_DIR: cli.config },
  });
  assert.equal(externalReceiptMatches({ receipt, target: "knowledge", binding: currentBinding, readBackRequired: true }), true);
  const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; markdownDigest?: string });
  assert.equal(calls[0]!.markdownDigest, sha256("Updated caf\u00e9\n"));
  assert.equal(receipt.publishedContentDigest, sha256("Updated caf\u00e9\n"));
  assert.equal(receipt.readBackContentDigest, sha256("Updated caf\u00e9\n"));
  assert.deepEqual(safeArgv(calls[0]!.argv), [
    "docs", "+update", "--doc", "existingDocumentToken123", "--mode", "overwrite", "--markdown", "<redacted>", "--new-title", "Updated title", "--as", "bot",
  ]);
  assert.deepEqual(calls[1]!.argv, ["docs", "+fetch", "--doc", "existingDocumentToken123", "--format", "json", "--as", "bot"]);
  assert.equal(calls[0]!.argv.includes("--format"), false);
});

test("knowledge publish rejects missing or ambiguous create targets and update target aliases before spawn", async (t) => {
  const cli = await privateLarkCli(t);
  const invalidTargets = [
    { title: "Title", markdown: "Body" },
    { folderToken: "folderToken123456", wikiNode: "wikiNodeToken12345", title: "Title", markdown: "Body" },
    { documentToken: "existingDocumentToken123", folderToken: "folderToken123456", title: "Title", markdown: "Body" },
    { documentToken: "https://tenant.feishu.cn/wiki/existingDocumentToken123", title: "Title", markdown: "Body" },
    { documentToken: "../../existingDocumentToken123", title: "Title", markdown: "Body" },
    { wikiNode: "https://example.com/wiki/wikiNodeToken12345", title: "Title", markdown: "Body" },
    { folderToken: "https://example.com/drive/folder/folderToken123456", title: "Title", markdown: "Body" },
    { documentToken: "existingDocumentToken123", title: "Title", markdown: "Body", token: "forbidden" },
  ];
  for (const target of invalidTargets) {
    await assert.rejects(publishKnowledge({ executable: cli.executable, target: target as never, binding: binding("feishu:target") }), (error: unknown) =>
      error instanceof KnowledgePublishError && error.code === "WSSPEC_KNOWLEDGE_TARGET_INVALID");
  }
  await assert.rejects(publishKnowledge({
    executable: cli.executable,
    target: { folderToken: "folderToken123456", title: "t-secret-abcdefghijklmnopqrstuvwxyz123456", markdown: "Body" },
    binding: binding("feishu-target:folderToken123456", "Body"),
  }), (error: unknown) => error instanceof KnowledgePublishError && error.code === "WSSPEC_KNOWLEDGE_CONTENT_INVALID");
});

test("knowledge publish rejects recursively encoded credentials and invalid encoding before spawn", async (t) => {
  const cases = [
    { label: "encoded GitLab title", title: "glpat%2525252Dabcdefghijklmnop", markdown: "Safe body" },
    { label: "Authorization header", title: "Safe title", markdown: "Authorization: Bearer github_pat_abcdefghijklmnopqrstuvwxyz123456" },
    { label: "encoded Cookie header", title: "Safe title", markdown: encodeLayers("Cookie: session=private-value", 2) },
    { label: "GitHub token", title: "Safe title", markdown: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
    { label: "GitLab token", title: "Safe title", markdown: "glpat-abcdefghijklmnop" },
    { label: "Lark t token", title: "Safe title", markdown: "t-A1b2C3d4E5f6G7h8I9j0K1l2" },
    { label: "Lark u token", title: "Safe title", markdown: "u-Z9y8X7w6V5u4T3s2R1q0P9o8" },
    { label: "Lark a token", title: "Safe title", markdown: "a-M1n2B3v4C5x6Z7l8K9j0H1g2" },
    { label: "invalid percent", title: "Safe title", markdown: "invalid %GG surface" },
    { label: "fifth encoded layer", title: "Safe title", markdown: encodeLayers("ordinary value", 5) },
  ];
  for (const current of cases) await t.test(current.label, async (st) => {
    const cli = await privateLarkCli(st);
    await assert.rejects(publishKnowledge({
      executable: cli.executable,
      target: { folderToken: "folderToken123456", title: current.title, markdown: current.markdown },
      binding: binding("feishu-target:folderToken123456", current.markdown),
      environment: { LARK_CONFIG_DIR: cli.config },
    }), (error: unknown) => error instanceof KnowledgePublishError
      && error.code === "WSSPEC_KNOWLEDGE_CONTENT_INVALID"
      && !error.message.includes(current.title)
      && !error.message.includes(current.markdown));
    await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  });
});

test("knowledge content scanning does not reject ordinary Feishu document tokens", () => {
  const target = validateKnowledgePublishTarget({
    folderToken: "folderToken123456",
    title: "Reference doccnAbCdEfGhIjKlMnOpQrS",
    markdown: "Read doccnAbCdEfGhIjKlMnOpQrS before publishing.",
  });
  assert.equal(target.title, "Reference doccnAbCdEfGhIjKlMnOpQrS");
  assert.equal(target.markdown, "Read doccnAbCdEfGhIjKlMnOpQrS before publishing.");
});

test("knowledge publish binds the current ExternalBinding and rejects stale or malformed bindings before write", async (t) => {
  const cli = await privateLarkCli(t);
  for (const invalid of [
    { ...binding("feishu:existingDocumentToken123"), target: "issue" },
    { ...binding("feishu:existingDocumentToken123"), publishAttemptId: "" },
    { ...binding("feishu:existingDocumentToken123"), readBackContentDigest: `sha256:${"3".repeat(64)}` },
  ]) {
    await assert.rejects(publishKnowledge({
      executable: cli.executable,
      target: { documentToken: "existingDocumentToken123", title: "Updated title", markdown: "Updated body\n" },
      binding: invalid as never,
    }), (error: unknown) => error instanceof KnowledgePublishError && error.code === "WSSPEC_KNOWLEDGE_BINDING_INVALID");
  }
});

test("knowledge publish rejects a binding for different canonical Markdown before write", async (t) => {
  const cli = await privateLarkCli(t);
  await assert.rejects(publishKnowledge({
    executable: cli.executable,
    target: { documentToken: "existingDocumentToken123", title: "Updated title", markdown: "Updated body\r\n" },
    binding: binding("feishu:existingDocumentToken123", "Different bound body\n"),
    environment: { LARK_CONFIG_DIR: cli.config },
  }), (error: unknown) => error instanceof KnowledgePublishError && error.code === "WSSPEC_KNOWLEDGE_BINDING_INVALID");
  await assert.rejects(access(cli.log), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("knowledge publish never confirms create when readback fails or token, title, or Markdown differs", async (t) => {
  const baseCreate = { doc_id: "createdDocumentToken123", doc_url: "https://tenant.feishu.cn/docx/createdDocumentToken123", message: "created" };
  const baseReadback = {
    doc_id: "createdDocumentToken123",
    doc_url: "https://tenant.feishu.cn/docx/createdDocumentToken123",
    title: "Published title",
    markdown: "Published body\n",
    has_more: false,
    revision: "1",
  };
  for (const response of [
    { exitCode: 1, stderr: "HTTP 404 not found after create" },
    { ...baseReadback, doc_id: "otherDocumentToken123", doc_url: "https://tenant.feishu.cn/docx/otherDocumentToken123" },
    { ...baseReadback, title: "Other title" },
    { ...baseReadback, markdown: "Other body" },
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "wspec-lark-failure-"));
    await chmod(root, 0o700);
    const executable = path.join(root, "lark-cli");
    const script = [
      `#!${process.execPath}`,
      `let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => {`,
      `JSON.parse(input || "{}"); const argv=process.argv.slice(2);`,
      `if (argv[1] === "+create") process.stdout.write(${JSON.stringify(JSON.stringify(baseCreate))});`,
      `else { const response=${JSON.stringify(response)}; if(response.exitCode){process.stderr.write(response.stderr);process.exitCode=response.exitCode}else process.stdout.write(JSON.stringify(response)); }`,
      `})`,
    ].join("\n");
    await writeFile(executable, script, { mode: 0o700 });
    t.after(async () => rm(root, { recursive: true, force: true }));
    await assert.rejects(publishKnowledge({
      executable,
      target: { folderToken: "folderToken123456", title: "Published title", markdown: "Published body\n" },
      binding: binding("feishu-target:folderToken123456"),
    }), (error: unknown) => error instanceof KnowledgePublishError
      && ["WSSPEC_KNOWLEDGE_READBACK_FAILED", "WSSPEC_KNOWLEDGE_READBACK_MISMATCH"].includes(error.code));
  }
});

test("knowledge errors and receipts contain no Markdown or token fields", async (t) => {
  const cli = await privateLarkCli(t);
  const markdown = "Published body\n";
  const receipt = await publishKnowledge({
    executable: cli.executable,
    target: { folderToken: "folderToken123456", title: "Published title", markdown },
    binding: binding("feishu-target:folderToken123456"),
    environment: { LARK_CONFIG_DIR: cli.config },
  });
  assert.equal(JSON.stringify(receipt).includes(markdown), false);
  assert.equal(Object.hasOwn(receipt, "token"), false);
  assert.equal(Object.hasOwn(receipt, "documentToken"), false);
});
