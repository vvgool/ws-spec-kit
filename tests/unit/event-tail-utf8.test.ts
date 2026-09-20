import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repairIncompleteEventTail } from "../../src/storage/events.js";

test("repair truncates incomplete event tails by UTF-8 bytes without damaging Chinese event paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "event-utf8-"));
  try {
    const filename = path.join(root, "events.jsonl");
    const complete = '{"path":"任务/需求规格.md","emoji":"🧪"}\n';
    await writeFile(filename, complete + '{"partial":"中');
    assert.equal(await repairIncompleteEventTail(root), true);
    assert.deepEqual(await readFile(filename), Buffer.from(complete));
    assert.equal(await repairIncompleteEventTail(root), false);
    await writeFile(filename, complete + '{"complete":"中文"}');
    assert.equal(await repairIncompleteEventTail(root), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
