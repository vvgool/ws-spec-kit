import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
  const artifactRoot = path.join(repositoryRoot, "artifacts");
  await mkdir(artifactRoot);
  return { repositoryRoot, artifactRoot };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof SourceArtifactError && error.code === code;
}

function encodeLayers(value: string, layers: number): string {
  if (layers < 1) return value;
  let encoded = [...Buffer.from(value, "utf8")]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
  for (let index = 1; index < layers; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
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

test("local.file stores NFC identity while opening the caller's NFD or NFC spelling", async () => {
  const current = await fixture();
  await mkdir(path.join(current.repositoryRoot, "requirements"));
  const nfd = "requirements/Cafe\u0301.md";
  const nfc = nfd.normalize("NFC");
  await writeFile(path.join(current.repositoryRoot, nfd), "# Unicode path\n", "utf8");

  const fromNfd = await captureRequirement({ ...current, workItemId, source: { type: "local.file", path: nfd } });
  const fromNfc = await captureRequirement({ ...current, workItemId, source: { type: "local.file", path: nfc } });

  assert.equal(fromNfd.stableId, nfc);
  assert.equal(fromNfc.stableId, nfc);
  assert.equal(fromNfd.artifactId, fromNfc.artifactId);
});

test("local.file rejects a regular file with another hardlink name", async () => {
  const current = await fixture();
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "wsspec-source-hardlink-")), "outside.md");
  await writeFile(outside, "# Shared inode\n", "utf8");
  await link(outside, path.join(current.repositoryRoot, "linked.md"));

  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "local.file", path: "linked.md" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_PATH_INVALID"),
  );
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
    { author: "github_pat_abcdefghijklmnopqrstuvwxyz123456" },
    { author: "Basic dXNlcjpwYXNz" },
    { author: "Set-Cookie: sid=private" },
    { author: "xapp-1-private-slack-token" },
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

test("Provider metadata rejects high-entropy Lark access-token families without broad prefix false positives", async () => {
  const current = await fixture();
  const source = (owner: string): NormalizedRequirementSource => ({
    type: "feishu.document",
    stableId: "doccnAbCdEfGhIjKlMnOpQrS",
    canonicalUrl: "https://example.feishu.cn/docx/doccnAbCdEfGhIjKlMnOpQrS",
    title: "Document",
    body: "Body",
    metadata: { owner },
  });
  for (const token of [
    "t-A1b2C3d4E5f6G7h8I9j0K1l2",
    "u-Z9y8X7w6V5u4T3s2R1q0P9o8",
    "a-M1n2B3v4C5x6Z7l8K9j0H1g2",
  ]) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: source(token) }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_METADATA_INVALID"),
    );
  }

  for (const value of ["t-short", "u-aaaaaaaaaaaaaaaaaaaaaaaa", "contact-team", "doccnAbCdEfGhIjKlMnOpQrS"]) {
    const artifact = await captureRequirement({ ...current, workItemId, source: source(value) });
    assert.equal(artifact.metadata.owner, value);
  }
});

test("Provider metadata rejection never echoes attacker-controlled keys or values", async () => {
  const current = await fixture();
  const attackerKey = "attackerSecretKey";
  const attackerValue = "github_pat_abcdefghijklmnopqrstuvwxyz123456";
  let rejected: unknown;
  try {
    await captureRequirement({
      ...current,
      workItemId,
      source: {
        type: "github.issue",
        stableId: "org/repo#17",
        canonicalUrl: "https://github.com/org/repo/issues/17",
        title: "Issue",
        body: "Body",
        metadata: { [attackerKey]: attackerValue },
      },
    });
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected instanceof SourceArtifactError);
  assert.equal(rejected.code, "WSSPEC_SOURCE_METADATA_INVALID");
  assert.equal(rejected.message.includes(attackerKey), false);
  assert.equal(rejected.message.includes(attackerValue), false);
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
    "https://github.com/org/repo/issues/17?redirect=github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "https://github.com/org/repo/issues/17?Basic=dXNlcjpwYXNz",
    "https://github.com/org/repo/issues/17?xapp-1-private-slack-token=value",
    "https://github.com/org/repo/issues/17#cookie=session%3Dprivate",
    "https://github.com/org/repo/issues/17#Set-Cookie%3A%20sid%3Dprivate",
  ]) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: { ...base, canonicalUrl } }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_INVALID"),
    );
  }
});

test("Provider canonical URLs scan every decoded URL surface for Lark tokens", async () => {
  const current = await fixture();
  const base = {
    type: "feishu.document" as const,
    stableId: "doccnAbCdEfGhIjKlMnOpQrS",
    title: "Document",
    body: "Body",
    metadata: {},
  };
  const token = "t-a1b2c3d4e5f6g7h8i9j0k1l2";
  const encoded = encodeURIComponent(token);
  for (const canonicalUrl of [
    `https://${encoded}:safe@example.com/docx/legal-token`,
    `https://example.com/${encoded}/docx/legal-token`,
    `https://example.com/docx/legal-token?redirect=${encoded}`,
    `https://example.com/docx/legal-token#${encoded}`,
    `https://${encoded}.example.com/docx/legal-token`,
    "https://%74%2d%61%31%62%32%63%33%64%34%65%35%66%36%67%37%68%38%69%39%6a%30%6b%31%6c%32.example.com/docx/legal-token",
    `https://${token}-例.example.com/docx/legal-token`,
  ]) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: { ...base, canonicalUrl } }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_INVALID"),
    );
  }
});

test("Provider canonical URLs reject the reviewed double-encoded credential probes", async () => {
  const current = await fixture();
  const cases: Array<{ type: NormalizedRequirementSource["type"]; canonicalUrl: string }> = [
    {
      type: "feishu.document",
      canonicalUrl: `https://example.feishu.cn/docx/${encodeLayers("t-A1b2C3d4E5f6G7h8I9j0K1l2", 2)}`,
    },
    {
      type: "github.issue",
      canonicalUrl: `https://github.com/org/repo/issues/17?redirect=${encodeLayers("github_pat_abcdefghijklmnopqrstuvwxyz123456", 2)}`,
    },
    {
      type: "gitlab.issue",
      canonicalUrl: `https://gitlab.com/org/repo/-/issues/17#${encodeLayers("glpat-AbCdEfGhIjKlMnOpQrS", 2)}`,
    },
  ];
  for (const { type, canonicalUrl } of cases) {
    await assert.rejects(
      captureRequirement({
        ...current,
        workItemId,
        source: { type, stableId: "external-17", canonicalUrl, title: "Issue", body: "Body", metadata: {} },
      }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_INVALID"),
    );
  }
});

test("Provider canonical URL decoding rejects credentials through four layers and fails closed beyond the bound", async () => {
  const current = await fixture();
  const token = "u-Z9y8X7w6V5u4T3s2R1q0P9o8";
  const source = (canonicalUrl: string): NormalizedRequirementSource => ({
    type: "feishu.document",
    stableId: "doccnAbCdEfGhIjKlMnOpQrS",
    canonicalUrl,
    title: "Document",
    body: "Body",
    metadata: {},
  });
  for (const layers of [1, 2, 3, 4]) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: source(`https://example.feishu.cn/docx/${encodeLayers(token, layers)}`) }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_INVALID"),
    );
  }
  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: source(`https://example.feishu.cn/docx/${encodeLayers(token, 5)}`) }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_METADATA_INVALID"),
  );
  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: source("https://example.feishu.cn/docx/legal?literal=%25") }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_INVALID"),
  );
});

test("Provider canonical URL decoding scans split prefixes, query plus semantics and Unicode host surfaces", async () => {
  const current = await fixture();
  const base = {
    type: "feishu.document" as const,
    stableId: "doccnAbCdEfGhIjKlMnOpQrS",
    title: "Document",
    body: "Body",
    metadata: {},
  };
  for (const canonicalUrl of [
    "https://example.feishu.cn/docx/t%252dA1b2C3d4E5f6G7h8I9j0K1l2",
    "https://example.feishu.cn/docx/%2574%252DA1b2C3d4E5f6G7h8I9j0K1l2",
    "https://example.feishu.cn/docx/legal?redirect=Basic+dXNlcjpwYXNz",
    "https://t%252DA1b2C3d4E5f6G7h8I9j0K1l2-例.example.com/docx/legal",
  ]) {
    await assert.rejects(
      captureRequirement({ ...current, workItemId, source: { ...base, canonicalUrl } }),
      (error: unknown) => hasCode(error, "WSSPEC_SOURCE_INVALID"),
    );
  }
});

test("Provider canonical URL decoding preserves legal encoded and plus-valued surfaces", async () => {
  const current = await fixture();
  const canonicalUrl = "https://example.feishu.cn/docx/doccnAbCdEfGhIjKlMnOpQrS?title=%E4%BE%8B%E5%AD%90&q=a+b#section-1";
  const artifact = await captureRequirement({
    ...current,
    workItemId,
    source: {
      type: "feishu.document",
      stableId: "doccnAbCdEfGhIjKlMnOpQrS",
      canonicalUrl,
      title: "Document",
      body: "Body",
      metadata: {},
    },
  });
  assert.equal(artifact.canonicalUrl, canonicalUrl);
});

test("Provider canonical URL decoding fails closed without echoing attacker input", async () => {
  const current = await fixture();
  const attackerSurface = "%ZZ-attacker-path";
  let rejected: unknown;
  try {
    await captureRequirement({
      ...current,
      workItemId,
      source: {
        type: "feishu.document",
        stableId: "doccnAbCdEfGhIjKlMnOpQrS",
        canonicalUrl: `https://example.feishu.cn/docx/${attackerSurface}`,
        title: "Document",
        body: "Body",
        metadata: {},
      },
    });
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected instanceof SourceArtifactError);
  assert.equal(rejected.code, "WSSPEC_SOURCE_INVALID");
  assert.equal(rejected.message.includes(attackerSurface), false);
});

test("Provider canonical URLs preserve legitimate Feishu document tokens", async () => {
  const current = await fixture();
  const documentToken = "doccnAbCdEfGhIjKlMnOpQrS";
  const artifact = await captureRequirement({
    ...current,
    workItemId,
    source: {
      type: "feishu.document",
      stableId: documentToken,
      canonicalUrl: `https://example.feishu.cn/docx/${documentToken}`,
      title: "Document",
      body: "Body",
      metadata: { owner: "alice" },
    },
  });
  assert.equal(artifact.canonicalUrl, `https://example.feishu.cn/docx/${documentToken}`);
});

test("Provider metadata rejects aggregate overflow when every key, array and item is individually valid", async () => {
  const current = await fixture();
  const values = Array.from({ length: 32 }, (_, index) => `${index.toString().padStart(2, "0")}-${"a".repeat(253)}`);
  const metadata = {
    assignees: values,
    author: values[0]!,
    labels: values,
    repository: values[1]!,
    state: values[2]!,
  };

  await assert.rejects(
    captureRequirement({
      ...current,
      workItemId,
      source: { type: "github.issue", stableId: "org/repo#17", title: "Issue", body: "Body", metadata },
    }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_METADATA_INVALID"),
  );
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

test("content-addressed capture rejects a pre-seeded same-byte hardlink", async () => {
  const current = await fixture();
  const artifact = await captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "Hardlink seed" } });
  const reference = sourceArtifactReference(workItemId, artifact);
  const target = path.join(current.artifactRoot, reference.path);
  const outside = path.join(current.repositoryRoot, "outside-artifact.json");
  await writeFile(outside, await readFile(target));
  await unlink(target);
  await link(outside, target);
  assert.equal((await stat(target)).nlink, 2);

  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "Hardlink seed" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_ARTIFACT_CONFLICT"),
  );
});

test("artifact verification rejects post-capture mutation through a new hardlink name", async () => {
  const current = await fixture();
  const artifact = await captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "Immutable bytes" } });
  const reference = sourceArtifactReference(workItemId, artifact);
  const alias = path.join(current.repositoryRoot, "artifact-alias.json");
  await link(path.join(current.artifactRoot, reference.path), alias);

  await assert.rejects(
    verifySourceArtifact(current.artifactRoot, workItemId, reference),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_SNAPSHOT_CHANGED"),
  );
  await writeFile(alias, "{}\n", "utf8");

  await assert.rejects(
    verifySourceArtifact(current.artifactRoot, workItemId, reference),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_SNAPSHOT_CHANGED"),
  );
});

test("capture rejects a symlink artifact root before writing outside the repository", async () => {
  const current = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "wsspec-artifact-outside-"));
  const linkedRoot = path.join(current.repositoryRoot, "linked-artifacts");
  await symlink(outside, linkedRoot);

  await assert.rejects(
    captureRequirement({ ...current, artifactRoot: linkedRoot, workItemId, source: { type: "user.prompt", text: "Stay inside" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_PATH_INVALID"),
  );
  assert.deepEqual(await readdir(outside), []);
});

test("capture rejects a real artifact root outside the canonical repository", async () => {
  const current = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "wsspec-artifact-outside-"));

  await assert.rejects(
    captureRequirement({ ...current, artifactRoot: outside, workItemId, source: { type: "user.prompt", text: "Stay inside" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_PATH_INVALID"),
  );
});

test("capture rejects group or world writable artifact root components", async () => {
  const current = await fixture();
  await chmod(current.artifactRoot, 0o777);

  await assert.rejects(
    captureRequirement({ ...current, workItemId, source: { type: "user.prompt", text: "Safe permissions" } }),
    (error: unknown) => hasCode(error, "WSSPEC_SOURCE_PATH_INVALID"),
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
