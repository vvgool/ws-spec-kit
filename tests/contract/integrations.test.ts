import assert from "node:assert/strict";
import test from "node:test";

import { generateCodexIntegration } from "../../src/integrations/codex.js";
import { generateGenericIntegration } from "../../src/integrations/generic.js";

test("Codex and Generic integrations use the same CLI pull-loop contract", () => {
  for (const integration of [generateCodexIntegration(), generateGenericIntegration()]) {
    assert.match(integration, /wspec next .*--json/);
    assert.match(integration, /wspec context/);
    assert.match(integration, /wspec complete/);
    assert.doesNotMatch(integration, /runtime\.json|events\.jsonl|write.*control/i);
  }
});
