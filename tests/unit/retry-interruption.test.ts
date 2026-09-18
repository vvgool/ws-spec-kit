import assert from "node:assert/strict";
import test from "node:test";
import { acquireRetry, failRetry, interruptedRetry } from "../../src/engine/control/retry.js";

test("interruptions do not spend failure budget and are idempotent", () => {
  let retry = acquireRetry(undefined, "implement", 2);
  for (let i = 0; i < 6; i++) {
    retry = interruptedRetry(retry);
    assert.equal(retry.attemptsUsed, 0);
    assert.deepEqual(interruptedRetry(retry), retry);
    retry = acquireRetry(retry, "implement", 2);
  }
  retry = failRetry(retry);
  assert.equal(retry.attemptsUsed, 1);
  retry = failRetry(acquireRetry(retry, "implement", 2));
  assert.equal(retry.status, "exhausted");
});

test("repeated interruptions still have a separate finite bound", () => {
  let retry = acquireRetry(undefined, "implement", 2);
  for (let i = 0; i < 20; i++) {
    retry = interruptedRetry(retry);
    if (i < 19) retry = acquireRetry(retry, "implement", 2);
  }
  assert.equal(retry.attemptsUsed, 0);
  assert.equal(retry.status, "exhausted");
  assert.throws(() => acquireRetry(retry, "implement", 2), /中断/u);
});
