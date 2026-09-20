import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { refreshTaskNavigation, renderTaskNavigation } from "../../src/application/task-navigation.js";
import type { ApplicationState } from "../../src/application/state.js";
import { captureRequirement, sourceArtifactReference } from "../../src/registry/connectors/requirement-source.js";
import type { StoredEvent } from "../../src/storage/events.js";

const id = "WSS-01ARZ3NDEKTSV4RRFFQ69G5FAV";
function state(root: string): ApplicationState {
  return {
    itemRoot: root, projection: { workItemId: id, controlPlane: root, workItem: { status: "active" }, stages: { clarify: { status: "awaiting_approval" } } },
    item: { workItemId: id, title: "测试任务", execution: {}, source: {} }, snapshot: { workflowRef: "feature" },
  } as unknown as ApplicationState;
}

test("navigation renders only safe event artifact references and projection guidance", () => {
  const input = state("/unused");
  const event = (ref: string) => ({ eventType: "artifact.authored", workItemId: id, result: { value: { artifactType: "规格", path: ref } } }) as StoredEvent;
  const markdown = renderTaskNavigation(input, [event(`.wsspec/work-items/${id}/artifacts/spec/02-规格.md`), event(`.wsspec/work-items/${id}/artifacts/../../secret`)]);
  assert.match(markdown, /测试任务/);
  assert.match(markdown, /请审核/);
  assert.match(markdown, /02-%E8%A7%84%E6%A0%BC.md/);
  assert.doesNotMatch(markdown, /secret/);
  assert.match(markdown, /不作为执行合同/);
});

test("refresh preserves unmanaged and symlink targets and produces redacted source view", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "navigation-")));
  try {
    const itemRoot = path.join(root, ".wsspec", "work-items", id);
    await mkdir(itemRoot, { recursive: true });
    const source = await captureRequirement({ repositoryRoot: root, artifactRoot: root, workItemId: id, source: { type: "user.prompt", text: "需求标题\n实现功能\napiKey=private-value" } });
    const reference = sourceArtifactReference(id, source);
    const input = state(itemRoot);
    input.item.source = { type: source.type, artifactId: source.artifactId, snapshot: reference.path.split(`/${id}/`)[1]!, contentDigest: source.contentDigest, artifactDigest: reference.contentHash };
    await refreshTaskNavigation(input);
    assert.match(await readFile(path.join(itemRoot, "README.md"), "utf8"), /测试任务/);
    assert.doesNotMatch(await readFile(path.join(itemRoot, "01-原始需求.md"), "utf8"), /private-value/);
    input.projection.workItem.status = "closed";
    await refreshTaskNavigation(input);
    assert.match(await readFile(path.join(itemRoot, "README.md"), "utf8"), /任务已结束/);
    await writeFile(path.join(itemRoot, "README.md"), "user content");
    await assert.rejects(refreshTaskNavigation(input), /WSSPEC_ARTIFACT_CONFLICT/);
    assert.equal(await readFile(path.join(itemRoot, "README.md"), "utf8"), "user content");
    await rm(path.join(itemRoot, "README.md"));
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(itemRoot, "README.md"));
    await assert.rejects(refreshTaskNavigation(input), /WSSPEC_ARTIFACT_CONFLICT/);
    assert.equal(await readFile(outside, "utf8"), "outside");
    const alias = path.join(root, "alias");
    await symlink(itemRoot, alias);
    await assert.rejects(refreshTaskNavigation({ ...input, itemRoot: alias }), /WSSPEC_ARTIFACT_CONFLICT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy authored events without paths still appear in navigation", () => {
  const hash = "a".repeat(64);
  const event = { eventType: "artifact.authored", workItemId: id, result: { value: {
    artifactType: "design", contentHash: `sha256:${hash}`,
  } } } as StoredEvent;
  const markdown = renderTaskNavigation(state("/unused"), [event]);
  assert.match(markdown, /技术方案/u);
  assert.ok(markdown.includes(`artifacts/design/${hash}.md`));
});
