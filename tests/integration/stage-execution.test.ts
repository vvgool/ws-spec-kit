import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultExecutorRegistry, ExecutorRegistryError } from "../../src/registry/executors/registry.js";

test("the public execution registry exposes Application executors with compiler-owned security classes", () => {
  const registry = createDefaultExecutorRegistry();

  assert.equal(registry.require("agent.execute").securityClass, "agent");
  assert.equal(registry.require("connector.execute/requirement.capture").securityClass, "external-read");
  assert.equal(registry.require("connector.execute/git.commit").securityClass, "local-write");
  assert.equal(registry.require("control.close").securityClass, "control");
  assert.throws(
    () => registry.assertStep({ uses: "agent.execute", securityClass: "external-write" }),
    (error: unknown) => error instanceof ExecutorRegistryError && error.code === "WSSPEC_EXECUTOR_SECURITY_MISMATCH",
  );
  assert.throws(
    () => registry.require("legacy.stage.execute"),
    (error: unknown) => error instanceof ExecutorRegistryError && error.code === "WSSPEC_EXECUTOR_NOT_FOUND",
  );
});
