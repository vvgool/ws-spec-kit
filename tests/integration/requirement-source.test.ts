import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as canonicalizeModule from "canonicalize";

import {
  captureRequirement,
  SourceArtifactError,
  sourceArtifactReference,
  verifySourceArtifact,
  type NormalizedRequirementSource,
} from "../../src/registry/connectors/requirement-source.js";

const canonicalize = canonicalizeModule.default as unknown as (input: unknown) => string | undefined;
const execFileAsync = promisify(execFile);
const workItemId = "WSS-SOURCE";

async function fixture(): Promise<{ repositoryRoot: string; artifactRoot: string }> {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "wsspec-source-repository-"));
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "wsspec-source-artifacts-"));
  return { repositoryRoot, artifactRoot };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof SourceArtifactError && error.code === code;
}

test("user.prompt canonicalizes Unicode, BOM and all newline forms before deriving identity", async () => {
  const current = await fixture();
  const first = await captureRequirement({
    ...current,
    workItemId,
    source: { type: "user.prompt", text: "\ufeff# Cafe\u0301\r\n\rDetails\r" },
  });
  const second = await captureRequirement({
    ...current,
    workItemId,
    source: { type: "user.prompt", text: "# Caf\u00e9\n\nDetails\n" },
  });

  assert.equal(first.body, "# Caf\u00e9\n\nDetails\n");
  assert.equal(first.title, "Caf\u00e9");
  assert.equal(first.stableId, first.contentDigest);
  assert.equal(first.artifactId, second.artifactId);
  assert.equal(first.contentDigest, second.contentDigest);
  assert.deepEqual(sourceArtifactReference(workItemId, first), sourceArtifactReference(workItemId, second));

  const reference = sourceArtifactReference(workItemId, first);
  assert.match(reference.artifactId, /^source-[a-f0-9]{64}$/u);
  assert.match(reference.contentHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(reference.path, /^\.wsspec\/work-items\/WSS-SOURCE\/source\/[a-f0-9]{64}\.json$/u);
  const text = await readFile(path.join(current.artifactRoot, reference.path), "utf8");
  assert.equal(text, `${canonicalize(JSON.parse(text))}\n`);
});

test("local.file captures a canonical repository-relative regular Markdown file", async () => {
  const current = await fixture();
  await mkdir(path.join(current.repositoryRoot, "requirements"));
  await writeFile(path.join(current.repositoryRoot, "requirements", "checkout.md"), "\ufeff# Checkout\r\n\r\nRetry payment.\r\n", "utf8");

  const artifact = await captureRequirement({
    ...current,
    workItemId,
    source: { type: "local.file", path: "requirements/checkout.md" },
  });

  assert.equal(artifact.type, "local.file");
  assert.equal(artifact.stableId, "requirements/checkout.md");
  assert.equal(artifact.title, "Checkout");
  assert.equal(artifact.body, "# Checkout\n\nRetry payment.\n");
  assert.deepEqual(artifact.metadata, {});
});

test("local.file rejects non-canonical, absolute, escaping and symlinked paths", async () => {
  const current = await fixture();
  await mkdir(path.join(current.repositoryRoot, "requirements"));
  await writeFile(path.join(current.repositoryRoot, "requirements", "spec.md"), "# Spec\n", "utf8");
  await symlink("spec.md", path.join(current.repositoryRoot, "requirements", "linked.md"));
  await symlink("requirements", path.join(current.repositoryRoot, "linked-dir"));

  for (const candidate of [
    "./requirements/spec.md",
    "requirements/../requirements/spec.md",
    "../outside.md",
    path.join(current.repositoryRoot, "requirements", "spec.md"),
    "requirements/linked.md",
    "linked-dir/spec.md",
  ]) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: { type: "local.file", path: candidate } }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_PATH_INVALID"),
      candidate,
    );
  }
});

test("local.file rejects directories, special files and unsupported extensions", async () => {
  const current = await fixture();
  await mkdir(path.join(current.repositoryRoot, "directory.md"));
  await writeFile(path.join(current.repositoryRoot, "requirement.json"), "{}\n", "utf8");
  const fifo = path.join(current.repositoryRoot, "pipe.txt");
  await execFileAsync("mkfifo", [fifo]);

  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "local.file", path: "directory.md" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_NOT_REGULAR_FILE"),
  );
  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "local.file", path: "pipe.txt" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_NOT_REGULAR_FILE"),
  );
  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "local.file", path: "requirement.json" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_TYPE_UNSUPPORTED"),
  );
});

test("local.file rejects invalid UTF-8, NUL and binary control bytes", async () => {
  const current = await fixture();
  const cases: Array<[string, Uint8Array]> = [
    ["invalid.md", Uint8Array.from([0x23, 0x20, 0xc3, 0x28])],
    ["nul.md", Uint8Array.from([0x23, 0x00, 0x0a])],
    ["control.txt", Uint8Array.from([0x74, 0x65, 0x78, 0x74, 0x01, 0x0a])],
  ];
  for (const [filename, bytes] of cases) {
    await writeFile(path.join(current.repositoryRoot, filename), bytes);
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: { type: "local.file", path: filename } }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_BINARY"),
      filename,
    );
  }
});

test("all source inputs enforce byte and Unicode character limits", async () => {
  const current = await fixture();
  await writeFile(path.join(current.repositoryRoot, "large.md"), "a".repeat(1_048_577), "utf8");
  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "local.file", path: "large.md" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_TOO_LARGE"),
  );
  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "a".repeat(262_145) } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_TOO_LARGE"),
  );
  await assert.rejects(
    captureRequirement({
      ...current,
      workItemId,
      source: {
        type: "github.issue",
        stableId: "org/repo#1",
        canonicalUrl: "https://github.com/org/repo/issues/1",
        title: "Large issue",
        body: "\ud83d\ude00".repeat(262_145),
        metadata: {},
      },
    }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_TOO_LARGE"),
  );
});

test("normalized Provider input uses canonical fields and an explicit metadata allowlist", async () => {
  const current = await fixture();
  const source: NormalizedRequirementSource = {
    type: "github.issue",
    stableId: "org/repo#17",
    canonicalUrl: "https://github.com/org/repo/issues/17",
    title: "Cafe\u0301 issue",
    body: "First\r\nSecond\r",
    updatedAt: "2026-08-18T16:00:00+08:00",
    metadata: { state: "open", labels: ["bug", "payment"], author: "alice" },
  };

  const artifact = await captureRequirement({ ...current, workItemId, source });

  assert.equal(artifact.title, "Caf\u00e9 issue");
  assert.equal(artifact.body, "First\nSecond\n");
  assert.equal(artifact.updatedAt, "2026-08-18T08:00:00.000Z");
  assert.deepEqual(artifact.metadata, { author: "alice", labels: ["bug", "payment"], state: "open" });
});

test("Provider metadata rejects unknown, prototype and credential-like keys or values", async () => {
  const current = await fixture();
  const source = (metadata: Record<string, string | string[]>): NormalizedRequirementSource => ({
    type: "github.issue",
    stableId: "org/repo#17",
    canonicalUrl: "https://github.com/org/repo/issues/17",
    title: "Issue",
    body: "Body",
    metadata,
  });
  const cases: Array<Record<string, string | string[]>> = [
    { milestone: "v1" },
    { access_token: "secret" },
    { author: "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456" },
    { labels: ["bug", "Cookie: session=private"] },
    JSON.parse('{"__proto__":"polluted"}') as Record<string, string>,
    Object.create({ token: "inherited-secret" }) as Record<string, string>,
  ];
  for (const metadata of cases) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: source(metadata) }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_METADATA_INVALID"),
    );
  }
});

test("Provider canonical URLs reject embedded credentials and credential-like query or fragment content", async () => {
  const current = await fixture();
  const base = {
    type: "github.issue" as const,
    stableId: "org/repo#17",
    title: "Issue",
    body: "Body",
    metadata: {},
  };
  for (const canonicalUrl of [
    "https://user:password@github.com/org/repo/issues/17",
    "https://github.com/org/repo/issues/17?access_token=private",
    "https://github.com/org/repo/issues/17?redirect=Bearer%20ghp_abcdefghijklmnopqrstuvwxyz123456",
    "https://github.com/org/repo/issues/17#cookie=session%3Dprivate",
  ]) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: { ...base, canonicalUrl } }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_INVALID"),
    );
  }
});

test("Provider metadata enforces key, item, array and aggregate bounds", async () => {
  const current = await fixture();
  const base = {
    type: "github.issue" as const,
    stableId: "org/repo#17",
    title: "Issue",
    body: "Body",
  };
  for (const metadata of [
    { author: "a".repeat(257) },
    { labels: Array.from({ length: 33 }, (_, index) => `label-${index}`) },
    { labels: ["a".repeat(257)] },
  ]) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: { ...base, metadata } }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_METADATA_INVALID"),
    );
  }
});

test("content-addressed writes are byte-idempotent and never overwrite older artifacts", async () => {
  const current = await fixture();
  const first = await captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "First" } });
  const firstReference = sourceArtifactReference(workItemId, first);
  const firstPath = path.join(current.artifactRoot, firstReference.path);
  const firstBytes = await readFile(firstPath);

  const repeated = await captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "First" } });
  assert.equal(repeated.artifactId, first.artifactId);
  assert.deepEqual(await readFile(firstPath), firstBytes);

  const second = await captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "Second" } });
  assert.notEqual(second.artifactId, first.artifactId);
  assert.deepEqual(await readFile(firstPath), firstBytes);
  await verifySourceArtifact(current.artifactRoot, workItemId, firstReference);

  await writeFile(firstPath, "{}\n", "utf8");
  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "First" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_ARTIFACT_CONFLICT"),
  );
});

test("concurrent identical captures converge on one complete Artifact without temporary files", async () => {
  const current = await fixture();
  const artifacts = await Promise.all(Array.from({ length: 8 }, () => captureRequirement({
    ...current,
    workItemId,
    source: { type: "user.prompt", text: "Concurrent requirement" },
  })));

  assert.equal(new Set(artifacts.map(({ artifactId }) => artifactId)).size, 1);
  const sourceDirectory = path.join(current.artifactRoot, ".wsspec", "work-items", workItemId, "source");
  const entries = await readdir(sourceDirectory);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /^[a-f0-9]{64}\.json$/u);
});

test("artifact verification rejects schema drift, non-canonical bytes and digest mismatch", async () => {
  const current = await fixture();
  const artifact = await captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "Verify me" } });
  const reference = sourceArtifactReference(workItemId, artifact);
  const target = path.join(current.artifactRoot, reference.path);

  const withUnknownField = { ...artifact, unexpected: true };
  await writeFile(target, `${canonicalize(withUnknownField)}\n`, "utf8");
  await assert.rejects(
    verifySourceArtifact(current.artifactRoot, workItemId, reference),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_SNAPSHOT_CHANGED"),
  );

  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await assert.rejects(
    verifySourceArtifact(current.artifactRoot, workItemId, reference),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_SNAPSHOT_CHANGED"),
  );
});
