import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowFixture,
  executeDocumentationWorkflow,
  interruptAfterAcquire,
} from "./helpers/workflow-fixture.js";

test("Documentation stays inside its immutable path, records trusted integrity, and resumes without TDD state", async () => {
  const fixture = await createWorkflowFixture({ documentation: true });
  const started = await fixture.app.start({
    root: fixture.root,
    source: { type: "prompt", text: "补充本地使用文档" },
    workflowRef: "builtin://workflows/documentation-delivery",
    profile: "quick",
  });
  const first = await fixture.acquire(started.workItemId, "docs-author");
  const resumed = await interruptAfterAcquire(fixture, started, first, "docs-author");

  const result = await executeDocumentationWorkflow(fixture, started, {
    first: resumed,
    actor: "docs-author",
    interruptAfterLoopSubmit: true,
  });

  assert.deepEqual(result.scopeViolations, {
    production: "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION",
    script: "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION",
    dependency: "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION",
    build: "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION",
  });
  assert.equal(result.workflowAfterProjectSwitch, "builtin://workflows/documentation-delivery");
  assert.equal(result.recovered.profile.selected, "quick");
  assert.equal(result.recovered.loops["review-fix"]?.iteration, 1);
  assert.equal(result.recoveryEvidence.loopStep, "commit");
  assert.equal(result.recoveryEvidence.loopAttemptsUsed, 2);
  for (const forbidden of ["write-tests", "verify-red", "implement", "verify-green"]) {
    assert.equal(Object.hasOwn(result.recovered.stages, forbidden), false);
  }
  assert.equal(Object.keys(result.recovered.evidence).some((key) => key.startsWith(`tdd:${started.workItemId}:`)), false);
  const integrity = result.recovered.evidence["verify-document:gate:docs.integrity"] as Record<string, unknown>;
  assert.equal(integrity.level, "trusted");
  assert.equal(integrity.result, "passed");
  assert.equal(result.recovered.workItem.status, "closed");
});
