import assert from "node:assert/strict";
import test from "node:test";

import { defineConnectorManifest, ConnectorManifestError } from "../../src/registry/connectors/manifest.js";
import { ConnectorRegistry, ConnectorRegistryError } from "../../src/registry/connectors/registry.js";
import type { ConnectorManifest } from "../../src/registry/connectors/types.js";

function manifest(id: string, capabilities: string[]): ConnectorManifest {
  return {
    id,
    capabilities,
    securityClass: "external-read",
    executable: "gh",
    minimumVersion: "2.0.0",
    argvTemplates: [["issue", "list"]],
    doctor: {
      version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
      auth: {
        kind: "auth",
        argv: ["auth", "status", "--active"],
        parser: { kind: "exit-code" },
        outcomes: { authenticated: [0], unauthenticated: [1] },
      },
    },
    envPolicy: { allow: [] },
    timeoutMs: 1_000,
    maxStdoutBytes: 4_096,
  } as ConnectorManifest;
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
    .register({
      ...manifest("gitlab", ["issue.read"]),
      executable: "glab",
      doctor: {
        version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
        auth: {
          kind: "auth",
          argv: ["auth", "status"],
          parser: { kind: "exit-code" },
          outcomes: { authenticated: [0], unauthenticated: [1] },
        },
      },
    });

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

test("Manifest validates the complete runtime shape with one stable error code", () => {
  const valid = manifest("github", ["issue.read"]);
  const invalid: unknown[] = [
    { ...valid, securityClass: "root" },
    { ...valid, executable: "sh" },
    { ...valid, timeoutMs: 1.5 },
    { ...valid, maxStdoutBytes: 0 },
    { ...valid, argvTemplates: [["issue", 1]] },
    { ...valid, extra: true },
    { ...valid, doctor: undefined },
    { ...valid, envPolicy: { allow: ["GH_TOKEN"] } },
    { ...valid, doctor: { ...valid.doctor, version: { kind: "version", argv: ["issue", "create"], parser: { kind: "text-semver" } } } },
    { ...valid, doctor: { ...valid.doctor, auth: { kind: "none" } } },
    {
      ...valid,
      doctor: {
        ...valid.doctor,
        auth: { ...valid.doctor.auth, outcomes: { authenticated: [1], unauthenticated: [0] } },
      },
    },
  ];

  for (const candidate of invalid) {
    assert.throws(
      () => defineConnectorManifest(candidate),
      (error: unknown) => error instanceof ConnectorManifestError && error.code === "WSSPEC_CONNECTOR_MANIFEST_INVALID",
    );
  }
});

test("local git may explicitly omit auth while external providers require a probe", () => {
  const local = {
    ...manifest("local-git", ["repository.read"]),
    executable: "git",
    doctor: {
      version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
      auth: { kind: "none" },
    },
  } as ConnectorManifest;

  assert.equal(defineConnectorManifest(local).doctor.auth.kind, "none");
});

test("Manifest uses strict SemVer validation for minimum versions", () => {
  const valid = manifest("github", ["issue.read"]);
  assert.equal(defineConnectorManifest({ ...valid, minimumVersion: "999999999999999999999.0.0-0+build.1" }).minimumVersion, "999999999999999999999.0.0-0+build.1");

  for (const minimumVersion of ["1.0.0-01", "1.0.0-alpha.01", "1.0.0-alpha..1", "1.0.0+build..1", "01.0.0"]) {
    assert.throws(
      () => defineConnectorManifest({ ...valid, minimumVersion }),
      (error: unknown) => error instanceof ConnectorManifestError && error.code === "WSSPEC_CONNECTOR_MANIFEST_INVALID",
    );
  }
});

test("Manifest locks Doctor authentication probes to current read-only CLI contracts", () => {
  const lark = {
    ...manifest("lark", ["document.read"]),
    executable: "lark-cli",
    doctor: {
      version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
      auth: {
        kind: "auth",
        argv: ["auth", "status", "--verify"],
        parser: { kind: "exit-code" },
        outcomes: { authenticated: [0], unauthenticated: [1] },
      },
    },
  } as ConnectorManifest;
  assert.deepEqual(defineConnectorManifest(lark).doctor.auth, lark.doctor.auth);

  const deviations: ConnectorManifest[] = [
    { ...lark, doctor: { ...lark.doctor, auth: { ...lark.doctor.auth, argv: ["auth", "status", "--json"] } } } as ConnectorManifest,
    { ...manifest("github", ["issue.read"]), doctor: { ...manifest("github", ["issue.read"]).doctor, auth: { ...manifest("github", ["issue.read"]).doctor.auth, argv: ["auth", "status"] } } } as ConnectorManifest,
    {
      ...manifest("gitlab", ["issue.read"]),
      executable: "glab",
      doctor: {
        version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
        auth: { kind: "auth", argv: ["auth", "status", "--show-token"], parser: { kind: "exit-code" }, outcomes: { authenticated: [0], unauthenticated: [1] } },
      },
    } as ConnectorManifest,
  ];
  for (const deviation of deviations) assert.throws(() => defineConnectorManifest(deviation), ConnectorManifestError);
});
