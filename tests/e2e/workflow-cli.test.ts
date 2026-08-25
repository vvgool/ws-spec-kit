import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runWorkflowCommand } from "../../src/adapters/cli/workflow.js";
import { createApplication } from "../../src/application/application.js";
import { defaultProjectConfig, initRepository } from "../../src/storage/repository.js";
import { stringify } from "yaml";
import { createGitRepository, git } from "../integration/helpers/git.js";

test("Workflow 命令列出、展示、校验内置 Package，并且拒绝不存在的 Package", async () => {
  const root = await createGitRepository();
  const listed = await runWorkflowCommand({ root, argv: ["list"] }) as { workflows: Array<{ ref: string }> };
  assert.deepEqual(listed.workflows.map(({ ref }) => ref), [
    "builtin://workflows/documentation-delivery",
    "builtin://workflows/feature-delivery",
  ]);
  const shown = await runWorkflowCommand({ root, argv: ["show", "builtin://workflows/feature-delivery"] }) as { workflow: { ref: string } };
  assert.equal(shown.workflow.ref, "builtin://workflows/feature-delivery");
  const validated = await runWorkflowCommand({ root, argv: ["validate", "builtin://workflows/documentation-delivery"] }) as { valid: boolean };
  assert.equal(validated.valid, true);
  await assert.rejects(runWorkflowCommand({ root, argv: ["show", "builtin://workflows/missing"] }), /WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND/);
});

test("workflow eject 原子复制内置 Package 且拒绝覆盖已有目标", async () => {
  const root = await createGitRepository();
  const target = path.join(await mkdtemp(path.join(os.tmpdir(), "wspec-eject-")), "feature-delivery");
  const first = await runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] }) as { target: string };
  assert.equal(first.target, target);
  await assert.rejects(runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] }), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS");
});

test("workflow use 先校验后请求信任，未确认时不修改项目选择", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const target = path.join(root, ".wsspec", "workflows", "feature-delivery");
  await runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] });
  const before = await readFile(path.join(root, ".wsspec", "workflow.yaml"), "utf8");
  await assert.rejects(
    runWorkflowCommand({ root, argv: ["use", "project://workflows/feature-delivery"], interactive: false }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_WORKFLOW_TRUST_REQUIRED",
  );
  const blocked = await runWorkflowCommand({ root, argv: ["use", "project://workflows/feature-delivery"], interactive: true, actor: "reviewer" }) as { status: string; trust: { packageDigest: string; capabilityDigest: string } };
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.trust.packageDigest, /^sha256:/);
  assert.match(blocked.trust.capabilityDigest, /^sha256:/);
  assert.equal(await readFile(path.join(root, ".wsspec", "workflow.yaml"), "utf8"), before);
});

test("workflow 子命令拒绝多余参数，非法 profile 不创建信任请求", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const target = path.join(root, ".wsspec", "workflows", "feature-delivery");
  await runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] });
  const invalid = (error: unknown): boolean => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_ARGUMENT_INVALID";
  await assert.rejects(runWorkflowCommand({ root, argv: ["list", "--bogus", "value"] }), invalid);
  await assert.rejects(runWorkflowCommand({ root, argv: ["show", "builtin://workflows/feature-delivery", "extra"] }), invalid);
  await assert.rejects(runWorkflowCommand({ root, argv: ["use", "project://workflows/feature-delivery", "--profile", "invalid-profile"], interactive: true, actor: "reviewer" }), invalid);
  const common = await (await import("../integration/helpers/git.js")).git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  await assert.rejects(readFile(path.join(common, "wsspec", "trust", "workflow-packages.pending.ndjson"), "utf8"), /ENOENT/);
});

test("workflow use 未指定 Profile 时保留当前项目选择", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "workflow.yaml"), "version: 1\nactiveWorkflow:\n  ref: builtin://workflows/feature-delivery\n  version: 1\nprofile: governed\n", "utf8");
  const selected = await runWorkflowCommand({ root, argv: ["use", "builtin://workflows/feature-delivery"] }) as { profile: string };
  assert.equal(selected.profile, "governed");
});

test("workflow validate 按 Provider 从宿主 Global Skill 根解析绑定", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-provider-home-"));
  const target = path.join(root, ".wsspec", "workflows", "feature-delivery");
  await runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] });
  const workflow = path.join(target, "workflow.yaml");
  await writeFile(workflow, (await readFile(workflow, "utf8")).replaceAll("builtin://skills/requirement-exploration", "global://vendor/test"), "utf8");
  const globalSkill = path.join(home, ".agents", "skills", "vendor", "test");
  await mkdir(globalSkill, { recursive: true });
  await writeFile(path.join(globalSkill, "SKILL.md"), "# 测试 Skill\n", "utf8");

  const validated = await runWorkflowCommand({ root, home, argv: ["validate", "project://workflows/feature-delivery", "--provider", "codex"] }) as { valid: boolean };
  assert.equal(validated.valid, true);
  await assert.rejects(
    runWorkflowCommand({ root, home, argv: ["validate", "project://workflows/feature-delivery", "--provider", "generic"] }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SKILL_NOT_FOUND",
  );
});

test("workflow validate 复用 start 的严格 Project Config 校验", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "config.yaml"), "version: 1\nunknown: true\n", "utf8");

  await assert.rejects(
    runWorkflowCommand({ root, argv: ["validate", "builtin://workflows/feature-delivery"] }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SCHEMA_UNKNOWN_FIELD",
  );
});

test("含 verify-red 的 Workflow 在 start 与 validate 时拒绝不完整 test Gate", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-incomplete-gate-home-"));
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "config.yaml"), [
    "version: 1",
    "testing:",
    "  pathRules: [node]",
    "  testAssetPaths: [tests/**]",
    "  productPaths: [src/**]",
    "",
  ].join("\n"), "utf8");
  const app = createApplication({ provider: "generic", home, terminal: { isTTY: true } });
  const incomplete = (error: unknown): boolean => error instanceof Error && "code" in error
    && (error as Error & { code: string }).code === "WSSPEC_TDD_GATE_CONFIGURATION_INVALID";

  await assert.rejects(app.start({ root, source: { type: "prompt", text: "缺 Gate" } }), incomplete);
  await assert.rejects(runWorkflowCommand({ root, argv: ["validate", "builtin://workflows/feature-delivery"] }), incomplete);
  assert.equal((await runWorkflowCommand({ root, argv: ["validate", "builtin://workflows/documentation-delivery"] }) as { valid: boolean }).valid, true);
});

test("init 写入的 test Gate 允许 start feature-delivery", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-init-gate-home-"));
  await initRepository(root);
  const app = createApplication({ provider: "generic", home, terminal: { isTTY: true } });

  const started = await app.start({ root, source: { type: "prompt", text: "init 模板" }, profile: "quick" });

  assert.match(started.workItemId, /^WSS-/u);
  assert.equal(started.workflowRef, "builtin://workflows/feature-delivery");
});

test("已初始化项目缺少 Config 时 validate、use 与 start 同样 fail closed，且 use 不修改选择", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-missing-config-home-"));
  const app = createApplication({ provider: "generic", home, terminal: { isTTY: true } });
  const workflowPath = path.join(root, ".wsspec", "workflow.yaml");
  const before = await readFile(workflowPath, "utf8");
  await unlink(path.join(root, ".wsspec", "config.yaml"));
  const missingConfig = (error: unknown): boolean => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_PROJECT_CONFIG_MISSING";

  await assert.rejects(runWorkflowCommand({ root, home, argv: ["validate", "builtin://workflows/feature-delivery"] }), missingConfig);
  await assert.rejects(runWorkflowCommand({ root, home, argv: ["use", "builtin://workflows/documentation-delivery"] }), missingConfig);
  assert.equal(await readFile(workflowPath, "utf8"), before);
  await assert.rejects(app.start({ root, source: { type: "prompt", text: "缺失配置" } }), missingConfig);
});

test("四类 Provider 在 validate、use 与 start 使用相同的 Project Skill 解析上下文", async (t) => {
  const scenarios = [
    { provider: "codex", root: (home: string) => path.join(home, ".agents", "skills"), additional: false },
    { provider: "claude", root: (home: string) => path.join(home, ".claude", "skills"), additional: false },
    { provider: "cursor", root: (home: string) => path.join(home, ".cursor", "skills"), additional: false },
    { provider: "generic", root: (home: string) => path.join(home, "additional-skills"), additional: true },
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario.provider, async () => {
      const root = await createGitRepository();
      const home = await mkdtemp(path.join(os.tmpdir(), `wspec-${scenario.provider}-home-`));
      await initRepository(root);
      const target = path.join(root, ".wsspec", "workflows", "feature-delivery");
      await runWorkflowCommand({ root, argv: ["eject", "builtin://workflows/feature-delivery", target] });
      const workflow = path.join(target, "workflow.yaml");
      await writeFile(workflow, (await readFile(workflow, "utf8")).replaceAll("builtin://skills/requirement-exploration", "global://vendor/test"), "utf8");
      const globalRoot = scenario.root(home);
      await mkdir(path.join(globalRoot, "vendor", "test"), { recursive: true });
      await writeFile(path.join(globalRoot, "vendor", "test", "SKILL.md"), "# 测试 Skill\n", "utf8");
      await writeFile(path.join(root, ".wsspec", "config.yaml"), stringify({
        ...defaultProjectConfig(),
        ...(scenario.additional === true ? { skills: { additionalGlobalRoots: [{ id: "global-root", path: globalRoot }] } } : {}),
      }, { lineWidth: 0 }), "utf8");
      await git(root, "add", ".wsspec");
      await git(root, "commit", "-m", `test: ${scenario.provider} global Skill`);

      const app = createApplication({ provider: scenario.provider, home, terminal: { isTTY: true }, workflowTrust: { interactive: true, actor: "reviewer" } });
      let request: { requestId: string; packageDigest: string; capabilityDigest: string } | undefined;
      await assert.rejects(
        app.start({ root, source: { type: "prompt", text: "Global Skill" }, workflowRef: "project://workflows/feature-delivery" }),
        (error: unknown) => {
          if (!(error instanceof Error) || !("code" in error) || (error as Error & { code: string }).code !== "WSSPEC_WORKFLOW_TRUST_REQUIRED") return false;
          request = (error as Error & { details?: typeof request }).details;
          return request !== undefined;
        },
      );
      await app.decide({ kind: "workflow_trust", root, requestId: request!.requestId, decision: "trusted", expectedPackageDigest: request!.packageDigest, expectedCapabilityDigest: request!.capabilityDigest, actor: "reviewer" });

      assert.equal((await runWorkflowCommand({ root, home, argv: ["validate", "project://workflows/feature-delivery", "--provider", scenario.provider] }) as { valid: boolean }).valid, true);
      assert.equal((await runWorkflowCommand({ root, home, interactive: true, actor: "reviewer", argv: ["use", "project://workflows/feature-delivery", "--provider", scenario.provider] }) as { status: string }).status, "selected");
      assert.equal((await app.start({ root, source: { type: "prompt", text: "Global Skill" }, workflowRef: "project://workflows/feature-delivery" })).workflowRef, "project://workflows/feature-delivery");
    });
  }
});
