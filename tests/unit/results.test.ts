import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSubmitProfileDecision } from "../../src/engine/results.js";
import type { SubmitResult } from "../../src/protocol/application.js";
import type { RuntimeProjection } from "../../src/storage/control-plane.js";

function projection(): RuntimeProjection {
  return {
    profile: {
      mode: "quick",
      selected: "quick",
      provisional: false,
      reasonRuleIds: [],
      riskSignals: {
        levels: [],
        affectedPaths: [],
        modifiedPaths: [],
        issueLabels: [],
        fileTypes: [],
        plannedActions: [],
      },
    },
  } as unknown as RuntimeProjection;
}

function result(action: string): SubmitResult {
  return {
    version: 1,
    status: "completed",
    summary: "verified governed action",
    modifiedFiles: [],
    artifacts: [],
    commands: [],
    evidence: [],
    remainingRisks: [],
    externalWrites: [{ action }],
  };
}

test("git.commit receipt remains a local write without adding external-write risk", () => {
  const evaluated = evaluateSubmitProfileDecision({
    projection: projection(),
    result: result("git.commit"),
    stepId: "commit",
    workflow: "feature",
  });

  assert.deepEqual(evaluated.profile.riskSignals.plannedActions, []);
  assert.equal(evaluated.profile.selected, "quick");
  assert.equal(evaluated.decision, undefined);
});

test("Provider write receipts add external-write risk and require Governed", () => {
  for (const action of ["issue.update", "knowledge.publish"]) {
    const evaluated = evaluateSubmitProfileDecision({
      projection: projection(),
      result: result(action),
      stepId: "publish",
      workflow: "feature",
    });

    assert.deepEqual(evaluated.profile.riskSignals.plannedActions, ["external-write"], action);
    assert.equal(evaluated.decision?.selected, "governed", action);
    assert.ok(evaluated.decision?.reasonRuleIds.includes("sensitive-action"), action);
  }
});
