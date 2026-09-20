import assert from "node:assert/strict";
import test from "node:test";
import { readableWorkItemDirectory, workItemDirectory, workItemPrefix } from "../../src/domain/work-item-paths.js";

test("readable task names retain Chinese, stay bounded and distinguish identical titles", () => {
  const name = readableWorkItemDirectory("修复文档校验", "WSS-1");
  assert.match(name, /^修复文档校验-[a-f0-9]{12}$/u);
  assert.notEqual(name, readableWorkItemDirectory("修复文档校验", "WSS-2"));
  assert.equal(readableWorkItemDirectory("../ A \\ B .lock", "WSS-1").includes("."), false);
  assert.ok(readableWorkItemDirectory("很长的需求".repeat(100), "WSS-1").length <= 49);
});
test("legacy tasks retain their paths and invalid directory names are rejected", () => {
  assert.equal(workItemPrefix({ workItemId: "WSS-OLD" }), ".wsspec/work-items/WSS-OLD");
  for (const name of ["../escape", "/tmp/escape", "a/b", "a\\b", ".", ""]) {
    assert.throws(() => workItemDirectory({ workItemId: "WSS-1", execution: { directoryName: name } }));
  }
});
