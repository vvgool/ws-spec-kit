import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnText } from "../../src/adapters/process/spawn-json.js";
import { doctorConnectors } from "../../src/application/doctor-connectors.js";
import type { ConnectorExecutable, ConnectorManifest } from "../../src/registry/connectors/types.js";

async function providerFixture(t: test.TestContext, input: {
  executable: ConnectorExecutable;
  version: string;
  authenticated: boolean;
  authDescendantMarker?: string;
  authMarker?: string;
  environmentMarker?: string;
  invocationLog?: string;
  versionDescendantMarker?: string;
}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wspec-provider-"));
  await chmod(root, 0o700);
  const executable = path.join(root, "provider");
  const expectedAuthArgv: Partial<Record<ConnectorExecutable, readonly string[]>> = {
    gh: ["auth", "status", "--active"],
    glab: ["auth", "status"],
  };
  const source = [
    `#!${process.execPath}`,
    "const { writeFileSync } = require('node:fs')",
    "const argv = process.argv.slice(2)",
    ...(input.invocationLog === undefined ? [] : [
      `require('node:fs').appendFileSync(${JSON.stringify(input.invocationLog)}, JSON.stringify(argv)+'\\n')`,
    ]),
    "if (argv.length === 1 && argv[0] === '--version') {",
    `  process.stdout.write(${JSON.stringify(input.version)})`,
    ...(input.versionDescendantMarker === undefined ? [] : [
      `  require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(input.versionDescendantMarker)},'survived'),300)`) }],{stdio:'ignore'}).unref()`,
    ]),
    "}",
    `else if (JSON.stringify(argv) === ${JSON.stringify(JSON.stringify(expectedAuthArgv[input.executable]))}) {`,
    ...(input.authDescendantMarker === undefined ? [] : [
      `  require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(input.authDescendantMarker)},'survived'),300)`) }],{stdio:'ignore'}).unref()`,
    ]),
    ...(input.authMarker === undefined ? [] : [`  writeFileSync(${JSON.stringify(input.authMarker)}, 'auth-ran')`]),
    ...(input.environmentMarker === undefined ? [] : [
      `  writeFileSync(${JSON.stringify(input.environmentMarker)}, JSON.stringify({HOME:process.env.HOME,GH_CONFIG_DIR:process.env.GH_CONFIG_DIR,GLAB_CONFIG_DIR:process.env.GLAB_CONFIG_DIR}))`,
    ]),
    `  process.stdout.write(${JSON.stringify(input.authenticated ? "authenticated" : "unauthenticated")})`,
    `  process.exitCode = ${input.authenticated ? 0 : 1}`,
    "} else { process.stderr.write('unexpected argv'); process.exitCode = 9 }",
    "",
  ].join("\n");
  await writeFile(executable, source, { encoding: "utf8", mode: 0o700 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return executable;
}

function manifest(input: { id: string; executable: ConnectorExecutable; minimumVersion?: string }): ConnectorManifest {
  const auth = input.executable === "git"
    ? { kind: "none" as const }
    : input.executable === "gh"
      ? { kind: "auth" as const, argv: ["auth", "status", "--active"], parser: { kind: "exit-code" as const }, outcomes: { authenticated: [0], unauthenticated: [1] } }
      : input.executable === "glab"
        ? { kind: "auth" as const, argv: ["auth", "status"], parser: { kind: "exit-code" as const }, outcomes: { authenticated: [0], unauthenticated: [1] } }
        : { kind: "unavailable" as const, reasonCode: "WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE" as const };
  return {
    id: input.id,
    capabilities: ["doctor"],
    securityClass: "external-read",
    executable: input.executable,
    minimumVersion: input.minimumVersion ?? "2.0.0",
    argvTemplates: [["write", "forbidden"]],
    doctor: {
      version: { kind: "version", argv: ["--version"], parser: { kind: "text-semver" } },
      auth,
    },
    envPolicy: { allow: [] },
    timeoutMs: 3_000,
    maxStdoutBytes: 4_096,
  } as unknown as ConnectorManifest;
}

test("audited provider fixtures expose bounded native version text", async (t) => {
  for (const [executable, version] of [
    ["git", "git version 2.1.0"],
    ["gh", "gh version 2.1.0"],
    ["glab", "glab version 2.1.0"],
    ["lark-cli", "lark-cli version 2.1.0"],
  ] as const) {
    const provider = await providerFixture(t, { executable, version, authenticated: true });
    const result = await spawnText({ executable: provider, argv: ["--version"], input: {}, timeoutMs: 3_000, maxStdoutBytes: 4_096 });
    assert.equal(result.value, version);
  }
});

test("Doctor reports four states from audited probes and never runs business argv", async (t) => {
  const old = await providerFixture(t, { executable: "gh", version: "gh version 1.5.0", authenticated: true });
  const signedOut = await providerFixture(t, { executable: "glab", version: "glab 2.1.0", authenticated: false });
  const ready = await providerFixture(t, { executable: "lark-cli", version: "lark-cli version 2.2.0", authenticated: true });
  const binaries = new Map<ConnectorExecutable, string>([["gh", old], ["glab", signedOut], ["lark-cli", ready]]);
  const health = await doctorConnectors({
    manifests: [
      manifest({ id: "missing", executable: "git" }),
      manifest({ id: "old", executable: "gh" }),
      manifest({ id: "signed-out", executable: "glab" }),
      manifest({ id: "ready", executable: "lark-cli" }),
    ],
    locateExecutable: async (executable) => binaries.get(executable),
  });

  assert.deepEqual(health.map(({ provider, status }) => ({ provider, status })), [
    { provider: "missing", status: "missing_binary" },
    { provider: "old", status: "unsupported_version" },
    { provider: "signed-out", status: "unauthenticated" },
    { provider: "ready", status: "unauthenticated" },
  ]);
  assert.equal(health[1]?.version, "1.5.0");
  assert.equal(health[3]?.version, "2.2.0");
});

test("Doctor never runs lark auth and leaves its temporary HOME unchanged", async (t) => {
  const invocationLog = path.join(os.tmpdir(), `wspec-lark-invocations-${crypto.randomUUID()}`);
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "wspec-lark-home-"));
  await chmod(temporaryHome, 0o700);
  t.after(async () => {
    await rm(invocationLog, { force: true });
    await rm(temporaryHome, { recursive: true, force: true });
  });
  const executable = await providerFixture(t, {
    executable: "lark-cli",
    version: "lark-cli version 2.2.0",
    authenticated: true,
    invocationLog,
  });
  const provider = { ...manifest({ id: "lark-offline", executable: "lark-cli" }), envPolicy: { allow: ["HOME"] } } as ConnectorManifest;

  const health = await doctorConnectors({
    manifests: [provider],
    environment: { HOME: temporaryHome },
    locateExecutable: async () => executable,
  });

  assert.deepEqual(health, [{
    provider: "lark-offline",
    status: "unauthenticated",
    version: "2.2.0",
    reasonCode: "WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE",
    diagnostic: "Authentication probe unavailable in side-effect-free Doctor.",
  }]);
  assert.deepEqual((await readFile(invocationLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), [["--version"]]);
  assert.deepEqual(await readdir(temporaryHome), []);
});

test("Doctor parses native text and applies SemVer prerelease and huge-number precedence", async (t) => {
  const authMarker = path.join(os.tmpdir(), `wspec-auth-marker-${crypto.randomUUID()}`);
  const prerelease = await providerFixture(t, { executable: "gh", version: "gh version 2.0.0-alpha.1+build.7", authenticated: true, authMarker });
  const hyphenated = await providerFixture(t, { executable: "glab", version: "glab version 2.0.0-alpha-y", authenticated: true });
  const huge = await providerFixture(t, { executable: "git", version: "git version 999999999999999999999.1.0+host", authenticated: true });
  const health = await doctorConnectors({
    manifests: [
      manifest({ id: "prerelease", executable: "gh", minimumVersion: "2.0.0" }),
      manifest({ id: "hyphenated", executable: "glab", minimumVersion: "2.0.0-alpha-z" }),
      manifest({ id: "huge", executable: "git", minimumVersion: "999999999999999999999.1.0" }),
    ],
    locateExecutable: async (executable) => executable === "gh" ? prerelease : executable === "glab" ? hyphenated : huge,
  });

  assert.deepEqual(health.map(({ provider, status, version }) => ({ provider, status, version })), [
    { provider: "prerelease", status: "unsupported_version", version: "2.0.0-alpha.1+build.7" },
    { provider: "hyphenated", status: "unsupported_version", version: "2.0.0-alpha-y" },
    { provider: "huge", status: "available", version: "999999999999999999999.1.0+host" },
  ]);
  await assert.rejects(access(authMarker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("Doctor cleans same-group descendants when version text has no SemVer", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const marker = path.join(os.tmpdir(), `wspec-version-survivor-${crypto.randomUUID()}`);
  const executable = await providerFixture(t, {
    executable: "git",
    version: "not-a-version",
    authenticated: true,
    versionDescendantMarker: marker,
  });

  const health = await doctorConnectors({
    manifests: [manifest({ id: "malformed-version", executable: "git" })],
    locateExecutable: async () => executable,
  });

  assert.deepEqual(health, [{ provider: "malformed-version", status: "unsupported_version" }]);
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(access(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  await rm(marker, { force: true });
});

test("Doctor finalizes old and supported version process groups before returning", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  for (const [name, version, status] of [
    ["old", "git version 1.5.0", "unsupported_version"],
    ["supported", "git version 2.2.0", "available"],
  ] as const) {
    await t.test(name, async () => {
      const marker = path.join(os.tmpdir(), `wspec-${name}-version-survivor-${crypto.randomUUID()}`);
      const executable = await providerFixture(t, {
        executable: "git",
        version,
        authenticated: true,
        versionDescendantMarker: marker,
      });

      const health = await doctorConnectors({
        manifests: [manifest({ id: `${name}-version`, executable: "git" })],
        locateExecutable: async () => executable,
      });

      assert.equal(health[0]?.status, status);
      await new Promise((resolve) => setTimeout(resolve, 450));
      await assert.rejects(access(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
      await rm(marker, { force: true });
    });
  }
});

test("Doctor finalizes a successful auth process group before returning available", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const marker = path.join(os.tmpdir(), `wspec-auth-survivor-${crypto.randomUUID()}`);
  const executable = await providerFixture(t, {
    executable: "gh",
    version: "gh version 2.2.0",
    authenticated: true,
    authDescendantMarker: marker,
  });

  const health = await doctorConnectors({
    manifests: [manifest({ id: "authenticated", executable: "gh" })],
    locateExecutable: async () => executable,
  });

  assert.deepEqual(health, [{ provider: "authenticated", status: "available", version: "2.2.0" }]);
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(access(marker), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  await rm(marker, { force: true });
});

test("Doctor passes only manifest-allowlisted absolute configuration paths", async (t) => {
  const environmentMarker = path.join(os.tmpdir(), `wspec-environment-${crypto.randomUUID()}`);
  const executable = await providerFixture(t, { executable: "gh", version: "gh version 2.1.0", authenticated: true, environmentMarker });
  const provider = {
    ...manifest({ id: "environment", executable: "gh" }),
    envPolicy: { allow: ["HOME", "GH_CONFIG_DIR"] },
  } as ConnectorManifest;
  const configHome = path.join(os.tmpdir(), `wspec-config-${crypto.randomUUID()}`);
  const health = await doctorConnectors({
    manifests: [provider],
    environment: {
      HOME: configHome,
      GH_CONFIG_DIR: configHome,
      GLAB_CONFIG_DIR: path.join(os.tmpdir(), `wspec-unrelated-${crypto.randomUUID()}`),
    },
    locateExecutable: async () => executable,
  });

  assert.equal(health[0]?.status, "available");
  assert.deepEqual(JSON.parse(await readFile(environmentMarker, "utf8")), { HOME: configHome, GH_CONFIG_DIR: configHome });
  await rm(environmentMarker, { force: true });
});

test("Doctor maps locator exceptions per provider and continues", async (t) => {
  const executable = await providerFixture(t, { executable: "lark-cli", version: "lark-cli version 2.1.0", authenticated: true });
  const health = await doctorConnectors({
    manifests: [
      manifest({ id: "locator-failed", executable: "git" }),
      manifest({ id: "ready-after-failure", executable: "lark-cli" }),
    ],
    locateExecutable: async (candidate) => {
      if (candidate === "git") throw new Error("sensitive locator detail");
      return executable;
    },
  });

  assert.deepEqual(health, [
    { provider: "locator-failed", status: "missing_binary", diagnostic: "Executable locator failed." },
    {
      provider: "ready-after-failure",
      status: "unauthenticated",
      version: "2.1.0",
      reasonCode: "WSSPEC_CONNECTOR_AUTH_PROBE_UNAVAILABLE",
      diagnostic: "Authentication probe unavailable in side-effect-free Doctor.",
    },
  ]);
});
