import assert from "node:assert/strict";
import test from "node:test";

import { doctorConnectors } from "../../src/application/doctor-connectors.js";
import type { ConnectorManifest, ConnectorExecutable } from "../../src/registry/connectors/types.js";

const probeScript = [
  "const operation=process.argv[1]",
  "const value=process.argv[2]",
  "if(operation==='version')process.stdout.write(JSON.stringify({version:value}))",
  "else if(operation==='auth')process.stdout.write(JSON.stringify({authenticated:value==='yes'}))",
  "else { process.stdout.write(JSON.stringify({unexpected:operation})); process.exitCode=9 }",
].join(";");

function manifest(input: {
  id: string;
  executable: ConnectorExecutable;
  version: string;
  authenticated: boolean;
  extra?: readonly (readonly string[])[];
}): ConnectorManifest {
  return {
    id: input.id,
    capabilities: ["doctor"],
    securityClass: "external-read",
    executable: input.executable,
    minimumVersion: "2.0.0",
    argvTemplates: [
      ["--input-type=module", "-e", probeScript, "version", input.version],
      ["--input-type=module", "-e", probeScript, "auth", input.authenticated ? "yes" : "no"],
      ...(input.extra ?? []),
    ],
    timeoutMs: 1_000,
    maxStdoutBytes: 4_096,
  };
}

test("Doctor reports exactly four health states using only version and read-only auth probes", async () => {
  const manifests = [
    manifest({ id: "missing", executable: "git", version: "3.0.0", authenticated: true }),
    manifest({ id: "old", executable: "gh", version: "1.5.0", authenticated: true, extra: [["write", "forbidden"]] }),
    manifest({ id: "signed-out", executable: "glab", version: "2.1.0", authenticated: false, extra: [["write", "forbidden"]] }),
    manifest({ id: "ready", executable: "lark-cli", version: "2.2.0", authenticated: true, extra: [["write", "forbidden"]] }),
  ];
  const located: ConnectorExecutable[] = [];
  const health = await doctorConnectors({
    manifests,
    locateExecutable: async (executable) => {
      located.push(executable);
      return executable === "git" ? undefined : process.execPath;
    },
  });

  assert.deepEqual(located, ["git", "gh", "glab", "lark-cli"]);
  assert.deepEqual(health.map(({ provider, status }) => ({ provider, status })), [
    { provider: "missing", status: "missing_binary" },
    { provider: "old", status: "unsupported_version" },
    { provider: "signed-out", status: "unauthenticated" },
    { provider: "ready", status: "available" },
  ]);
  assert.equal(health[1]?.version, "1.5.0");
  assert.equal(health[3]?.version, "2.2.0");
  assert.deepEqual(health.map((entry) => entry.status).every((status) => [
    "available", "unauthenticated", "unsupported_version", "missing_binary",
  ].includes(status)), true);
});
