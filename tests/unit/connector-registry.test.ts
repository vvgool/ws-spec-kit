import assert from "node:assert/strict";
import test from "node:test";

import { ConnectorRegistry, ConnectorRegistryError } from "../../src/registry/connectors/registry.js";
import type { ConnectorManifest } from "../../src/registry/connectors/types.js";

function manifest(id: string, capabilities: string[]): ConnectorManifest {
  return {
    id,
    capabilities,
    securityClass: "external-read",
    executable: "gh",
    minimumVersion: "2.0.0",
    argvTemplates: [["--version"], ["auth", "status"]],
    timeoutMs: 1_000,
    maxStdoutBytes: 4_096,
  };
}

test("Registry rejects duplicate provider ids instead of replacing the first manifest", () => {
  const registry = new ConnectorRegistry().register(manifest("github", ["issue.read"]));

  assert.throws(
    () => registry.register(manifest("github", ["issue.write"])),
    (error: unknown) => error instanceof ConnectorRegistryError && error.code === "WSSPEC_CONNECTOR_PROVIDER_DUPLICATE",
  );
  assert.equal(registry.resolve("issue.read", "github").id, "github");
});

test("Registry resolves an exact capability/provider pair and rejects unknown capabilities", () => {
  const registry = new ConnectorRegistry()
    .register(manifest("github", ["issue.read", "issue.write"]))
    .register({ ...manifest("gitlab", ["issue.read"]), executable: "glab" });

  assert.equal(registry.resolve("issue.read", "gitlab").executable, "glab");
  assert.throws(
    () => registry.resolve("wiki.publish", "github"),
    (error: unknown) => error instanceof ConnectorRegistryError && error.code === "WSSPEC_CONNECTOR_CAPABILITY_NOT_FOUND",
  );
  assert.throws(
    () => registry.resolve("issue.read", "missing"),
    (error: unknown) => error instanceof ConnectorRegistryError && error.code === "WSSPEC_CONNECTOR_PROVIDER_NOT_FOUND",
  );
});
