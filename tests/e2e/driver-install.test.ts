import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setupDriverSkill, createDriverSkillSetup, inspectDriverSkill, createDriverSkillInstaller, installDriverSkill, secureInstallDriverFile } from "../../src/adapters/skills/install.js";

const historicalDriverDigests = {
  initial: {
    codex: "sha256:8804ee37451e7740a488c14291d048b57a21bdd7e2efb1b1beb70a46940030e3",
    claude: "sha256:3a592093e530e6e65c46d3d0cbde567fc4674135b250b0bd807e44dcb8ff8fb7",
    cursor: "sha256:d74438d605600c54633d2262a9558163a3f0d3a5c664983e4a20d4f84708b392",
    generic: "sha256:a2aeea6a8e14df5fb5477d5ec37eee0a7666f10976e80ac92a8087d1484b94c5",
  },
  chineseGuidance: {
    codex: "sha256:69b6ad68c123a711095377ffdf64d21225f4bafaab3a414497ffef6c5391773e",
    claude: "sha256:f7876f2691e037c3d5d9e469275e8f9adb110b6ed39f3ba7eb6f962e5d70cbb1",
    cursor: "sha256:2c5645323532c603f0e2b037bb3cd2cc1275d31abf0fa01180cc3ee436534a93",
    generic: "sha256:8248d34a1ac5306701a7d8ac5fbbea175b22ceb932fbcdc3d672a01e31127c25",
  },
} as const;

type HistoricalRevision = keyof typeof historicalDriverDigests;
type DriverAgent = keyof typeof historicalDriverDigests.initial;

async function temporaryHome(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-")));
}

function historicalDriver(agent: DriverAgent, revision: HistoricalRevision): string {
  const content = [
    "# WSSpecKit Driver",
    "",
    "新任务判断功能/文档 Workflow 并显式 start / 已有任务 inspect -> acquire -> 读取绑定 Skill -> 当前 Agent 执行 -> submit -> 重复",
    "",
    ...(revision === "chineseGuidance"
      ? ["面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。", ""]
      : []),
    "仅当需求明确为纯文档或无代码变更时，建议 `documentation-delivery`；其余默认 `feature-delivery`。创建时必须传递 `workflowRef`，允许用户覆盖，创建后不得自动切换。",
    "",
    `手动调用示例：\`wspec start --provider ${agent} --prompt "更新 README" --workflow builtin://workflows/documentation-delivery\`。`,
    "",
  ].join("\n");
  const digest = historicalDriverDigests[revision][agent];
  assert.equal(`sha256:${createHash("sha256").update(content).digest("hex")}`, digest);
  return [
    "---",
    "name: wsspeckit-driver",
    "wsspeckit-driver-version: 1",
    `wsspeckit-driver-content-digest: ${digest}`,
    "description: 使用 WSSpecKit 驱动软件交付 Workflow；新任务、已有任务或用户明确要求时调用。",
    "---",
    "",
    content,
  ].join("\n");
}

function targetFor(agent: DriverAgent, home: string): string {
  if (agent === "codex") return path.join(home, ".agents", "skills", "wsspeckit-driver");
  if (agent === "claude") return path.join(home, ".claude", "skills", "wsspeckit-driver");
  if (agent === "cursor") return path.join(home, ".cursor", "skills", "wsspeckit-driver");
  return path.join(home, "generic-driver");
}

async function install(agent: DriverAgent, home: string): Promise<void> {
  const target = targetFor(agent, home);
  await mkdir(target, { recursive: true });
  await installDriverSkill({ agent, home, ...(agent === "generic" ? { target } : {}) });
}

test("Codex Driver 安装只写入临时 HOME 的官方目录，并包含中文执行循环", async () => {
  const home = await temporaryHome();
  await mkdir(targetFor("codex", home), { recursive: true });
  const result = await installDriverSkill({ agent: "codex", home });
  assert.equal(result.target, path.join(home, ".agents", "skills", "wsspeckit-driver"));
  const skill = await readFile(path.join(result.target, "SKILL.md"), "utf8");
  assert.match(skill, /## Workflow 决策/);
  assert.match(skill, /已有任务或 Host 重启后的恢复先执行 inspect/);
  assert.match(skill, /面向用户的说明、文档和交互文案默认使用中文/);
  assert.match(skill, /协议字段、类型名、URI、命令名和错误码保持英文/);
  await assert.rejects(access(path.join(home, ".cursor", "rules", "wsspeckit-driver.mdc")), /ENOENT/);
});

test("Driver 安装 dry-run 不创建目录，Generic 必须提供显式目标", async () => {
  const home = await temporaryHome();
  await mkdir(targetFor("claude", home), { recursive: true });
  const preview = await installDriverSkill({ agent: "claude", home, dryRun: true });
  assert.equal(preview.dryRun, true);
  await assert.rejects(access(path.join(preview.target, "SKILL.md")), /ENOENT/);
  await assert.rejects(installDriverSkill({ agent: "generic", home }), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_ARGUMENT_REQUIRED");
});

test("安装器只幂等复验当前 canonical Driver", async () => {
  const home = await temporaryHome();
  const target = path.join(home, ".agents", "skills", "wsspeckit-driver");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), "---\nname: unrelated-skill\ndescription: name: wsspeckit-driver\n---\n\n正文\n", "utf8");
  await assert.rejects(
    installDriverSkill({ agent: "codex", home }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SKILL_INSTALL_CONFLICT",
  );
  const before = await readFile(path.join(target, "SKILL.md"), "utf8");
  assert.match(before, /unrelated-skill/);
  const ownedHome = await temporaryHome();
  const ownedTarget = path.join(ownedHome, ".agents", "skills", "wsspeckit-driver", "SKILL.md");
  await mkdir(path.dirname(ownedTarget), { recursive: true });
  await installDriverSkill({ agent: "codex", home: ownedHome, dryRun: false });
  const first = await readFile(ownedTarget, "utf8");
  await installDriverSkill({ agent: "codex", home: ownedHome, dryRun: false });
  assert.equal(await readFile(ownedTarget, "utf8"), first);
  assert.match(first, /wsspeckit-driver-version: 15/);
});

test("安装器拒绝原地升级历史 canonical Driver", async (t) => {
  for (const revision of ["initial", "chineseGuidance"] as const) {
    for (const agent of ["codex", "claude", "cursor", "generic"] as const) {
      await t.test(`${revision}/${agent}`, async () => {
        const home = await temporaryHome();
        const target = targetFor(agent, home);
        const before = historicalDriver(agent, revision);
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, "SKILL.md"), before, "utf8");

        await assert.rejects(
          installDriverSkill({ agent, home, ...(agent === "generic" ? { target } : {}) }),
          (error: unknown) => error instanceof Error
            && "code" in error
            && (error as Error & { code: string }).code === "WSSPEC_SKILL_INSTALL_CONFLICT",
        );
        assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), before);
      });
    }
  }
});

test("安装器拒绝未登记的自洽正文、未知版本和额外 ownership 字段", async (t) => {
  const unknownBody = "# WSSpecKit Driver\n\n未登记的自洽正文。\n";
  const unknownDigest = `sha256:${createHash("sha256").update(unknownBody).digest("hex")}`;
  const unknownCanonical = [
    "---",
    "name: wsspeckit-driver",
    "wsspeckit-driver-version: 1",
    `wsspeckit-driver-content-digest: ${unknownDigest}`,
    "description: 使用 WSSpecKit 驱动软件交付 Workflow；新任务、已有任务或用户明确要求时调用。",
    "---",
    "",
    unknownBody,
  ].join("\n");
  const known = historicalDriver("codex", "chineseGuidance");
  const cases = [
    ["unknown self-consistent body", unknownCanonical],
    ["unknown version", known.replace("wsspeckit-driver-version: 1", "wsspeckit-driver-version: 99")],
    ["extra ownership field", known.replace("name: wsspeckit-driver\n", "name: wsspeckit-driver\nunexpected: true\n")],
  ] as const;

  for (const [name, content] of cases) {
    await t.test(name, async () => {
      const home = await temporaryHome();
      const target = targetFor("codex", home);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "SKILL.md"), content, "utf8");

      await assert.rejects(
        install("codex", home),
        (error: unknown) => error instanceof Error
          && "code" in error
          && (error as Error & { code: string }).code === "WSSPEC_SKILL_INSTALL_CONFLICT",
      );
      assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), content);
    });
  }
});

test("同名 Driver 的损坏标识或正文篡改也必须拒绝覆盖", async (t) => {
  for (const mutate of [
    (content: string) => content.replace(/wsspeckit-driver-content-digest: sha256:[a-f0-9]+/u, "wsspeckit-driver-content-digest: sha256:forged"),
    (content: string) => content.replace("## Workflow 决策", "## 被篡改的 Driver 正文"),
  ]) {
    await t.test(mutate.name || "altered", async () => {
      const home = await temporaryHome();
      const target = path.join(home, ".agents", "skills", "wsspeckit-driver", "SKILL.md");
      await mkdir(path.dirname(target), { recursive: true });
      await installDriverSkill({ agent: "codex", home });
      const altered = mutate(await readFile(target, "utf8"));
      await writeFile(target, altered, "utf8");

      await assert.rejects(
        installDriverSkill({ agent: "codex", home }),
        (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SKILL_INSTALL_CONFLICT",
      );
      assert.equal(await readFile(target, "utf8"), altered);
    });
  }
});

test("安全 helper 失败时不创建 Driver 文件", async () => {
  const home = await temporaryHome();
  const target = path.join(home, ".agents", "skills", "wsspeckit-driver", "SKILL.md");
  await mkdir(path.dirname(target), { recursive: true });

  const install = createDriverSkillInstaller({ secureInstall: async () => { throw new Error("injected helper failure"); } });
  await assert.rejects(
    install({
      agent: "codex",
      home,
    }),
    /injected helper failure/,
  );

  await assert.rejects(access(target), /ENOENT/);
});

test("缺失的目标目录 fail closed 且安装器不创建任何路径段", async () => {
  const home = await temporaryHome();
  const target = path.join(home, ".agents", "skills", "wsspeckit-driver");

  await assert.rejects(
    installDriverSkill({ agent: "codex", home }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_SKILL_INSTALL_CONFLICT",
  );
  await assert.rejects(access(target), /ENOENT/);
});

test("安全 helper 用已记录 inode 拒绝 parent swap 且外部目录零副作用", async () => {
  const home = await temporaryHome();
  const target = path.join(home, ".agents", "skills", "wsspeckit-driver");
  const moved = `${target}-authenticated`;
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-driver-helper-race-outside-")));
  await mkdir(target, { recursive: true });
  const install = createDriverSkillInstaller({
    secureInstall: async (request) => {
      await rename(target, moved);
      await symlink(outside, target, "dir");
      await secureInstallDriverFile(request);
    },
  });

  let failure: Error | undefined;
  await assert.rejects(
    install({ agent: "codex", home }),
    (error: unknown) => {
      if (error instanceof Error) failure = error;
      return error instanceof Error
        && "code" in error
        && (error as Error & { code: string }).code === "WSSPEC_SKILL_INSTALL_CONFLICT";
    },
  );
  assert.equal(failure?.message.includes(home), false);
  assert.equal(failure?.message.includes(outside), false);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(access(path.join(moved, "SKILL.md")), /ENOENT/);
});

test("安全 helper 拒绝在 JS 预检后新增的 hardlink", async () => {
  const home = await temporaryHome();
  const target = path.join(home, ".agents", "skills", "wsspeckit-driver");
  const outside = path.join(home, "outside-hardlink.md");
  await mkdir(target, { recursive: true });
  await installDriverSkill({ agent: "codex", home });
  const install = createDriverSkillInstaller({
    secureInstall: async (request) => {
      await link(path.join(target, "SKILL.md"), outside);
      try {
        await secureInstallDriverFile(request);
      } finally {
        await unlink(outside).catch(() => undefined);
      }
    },
  });

  await assert.rejects(
    install({ agent: "codex", home }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && (error as Error & { code: string }).code === "WSSPEC_SKILL_INSTALL_CONFLICT",
  );
});

async function driverStatus(agent: DriverAgent, home: string, target?: string) {
  return inspectDriverSkill({agent, home, ...(target === undefined ? {} : {target})});
}

test("Driver status 缺失不创建目录，且不宣称 Host 已加载", async () => {
  const home = await temporaryHome();
  const result = await driverStatus("codex", home);
  assert.equal(result.status, "missing");
  assert.equal(result.hostLoaded, "unknown");
  assert.ok(result.nextSteps.some(step => step.includes("agent setup")));
  assert.deepEqual(await readdir(home), []);
});

test("Driver status 区分当前安装、历史安装和自定义内容并保持只读", async () => {
  const home = await temporaryHome();
  await install("codex", home);
  const filename = path.join(targetFor("codex", home), "SKILL.md");
  const current = await driverStatus("codex", home);
  assert.equal(current.status, "current");
  assert.equal(current.installedVersion, 15);
  assert.equal(current.expectedVersion, 15);
  assert.equal(current.hostLoaded, "unknown");
  const old = historicalDriver("codex", "initial");
  await writeFile(filename, old);
  assert.equal((await driverStatus("codex", home)).status, "outdated");
  assert.equal(await readFile(filename, "utf8"), old);
  await writeFile(filename, "用户自定义 Skill");
  assert.equal((await driverStatus("codex", home)).status, "conflict");
  assert.equal(await readFile(filename, "utf8"), "用户自定义 Skill");
});

test("Driver status 不跟随链接目标或将非 generic target 当作有效参数", async () => {
  const home = await temporaryHome();
  const outside = await temporaryHome();
  await symlink(outside, path.join(home, ".agents"));
  assert.equal((await driverStatus("codex", home)).status, "conflict");
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(driverStatus("codex", home, outside), {code: "WSSPEC_ARGUMENT_INVALID"});
  await assert.rejects(driverStatus("generic", home), {code: "WSSPEC_ARGUMENT_REQUIRED"});
});

test("Driver status 区分空目录与不安全 Skill 文件，不改变检查对象", async () => {
  const home = await temporaryHome();
  const target = targetFor("codex", home);
  await mkdir(target, {recursive: true});
  assert.equal((await driverStatus("codex", home)).status, "missing");
  const filename = path.join(target, "SKILL.md");
  const external = path.join(home, "custom.md");
  await writeFile(external, "custom");
  await symlink(external, filename);
  assert.equal((await driverStatus("codex", home)).status, "conflict");
  assert.equal(await readFile(external, "utf8"), "custom");
  await unlink(filename);
  await writeFile(filename, "x".repeat(1_048_577));
  assert.equal((await driverStatus("codex", home)).status, "conflict");
  assert.equal((await readFile(filename)).length, 1_048_577);
});

async function setupDriver(input: { agent: DriverAgent; home: string; target?: string; dryRun?: boolean }) {
  return setupDriverSkill(input);
}

test("Driver setup 从空 HOME 安装并幂等，dry-run 不创建目录", async () => {
  const home = await temporaryHome();
  assert.equal((await setupDriver({agent: "codex", home, dryRun: true})).status, "missing");
  assert.deepEqual(await readdir(home), []);
  const result = await setupDriver({agent: "codex", home});
  assert.equal(result.status, "current");
  assert.equal(result.hostLoaded, "unknown");
  const filename = path.join(targetFor("codex", home), "SKILL.md");
  const before = await readFile(filename, "utf8");
  assert.equal((await setupDriver({agent: "codex", home})).status, "current");
  assert.equal(await readFile(filename, "utf8"), before);
});

test("Driver setup 支持四类客户端并保留冲突文件与历史版本", async () => {
  for (const agent of ["codex", "claude", "cursor", "generic"] as const) {
    const home = await temporaryHome();
    const target = targetFor(agent, home);
    const input = {agent, home, ...(agent === "generic" ? {target} : {})};
    assert.equal((await setupDriver(input)).status, "current");
    const filename = path.join(target, "SKILL.md");
    for (const content of ["custom", historicalDriver(agent, "initial")]) {
      await writeFile(filename, content);
      await assert.rejects(setupDriver(input), {code: "WSSPEC_SKILL_INSTALL_CONFLICT"});
      assert.equal(await readFile(filename, "utf8"), content);
    }
  }
});

test("Driver setup 不跟随缺失目标的祖先链接", async () => {
  const home = await temporaryHome();
  const outside = await temporaryHome();
  await symlink(outside, path.join(home, ".agents"));
  await assert.rejects(setupDriver({agent: "codex", home}), {code: "WSSPEC_SKILL_INSTALL_CONFLICT"});
  assert.deepEqual(await readdir(outside), []);
});

test("Driver setup 用 pinned authority 拒绝预检后的祖先置换", async () => {
  const home = await temporaryHome();
  const parent = path.join(home, ".agents");
  const moved = path.join(home, "moved");
  const outside = await temporaryHome();
  await mkdir(parent);
  const setup = createDriverSkillSetup({secureInstall: async request => {
    assert.equal(request.operation, "setup");
    await rename(parent, moved);
    await symlink(outside, parent);
    await secureInstallDriverFile(request);
  }});
  await assert.rejects(setup({agent: "codex", home}), {code: "WSSPEC_SKILL_INSTALL_CONFLICT"});
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(moved), []);
});

test("Driver v15 明确触发和只读边界，仍识别 v13 为历史版本", async () => {
  const home = await temporaryHome();
  await setupDriver({agent: "codex", home});
  const filename = path.join(targetFor("codex", home), "SKILL.md");
  const current = await readFile(filename, "utf8");
  assert.match(current, /wsspeckit-driver-version: 15/);
  const old = await readFile(new URL("../fixtures/drivers/codex-v13.md", import.meta.url), "utf8");
  await writeFile(filename, old);
  const status = await driverStatus("codex", home);
  assert.equal(status.status, "outdated");
  assert.equal(status.installedVersion, 13);
  await assert.rejects(setupDriver({agent: "codex", home}), {code: "WSSPEC_SKILL_INSTALL_CONFLICT"});
  assert.equal(await readFile(filename, "utf8"), old);
});

test("Driver setup 不在 helper 完成后接受新建的普通替换目录", async () => {
  const home = await temporaryHome();
  const parent = path.join(home, ".agents");
  await mkdir(parent);
  let replaced = false;
  const setup = createDriverSkillSetup({secureInstall: async request => {
    await secureInstallDriverFile(request);
    if (!replaced) {
      replaced = true;
      await rename(parent, path.join(home, "original"));
      await mkdir(targetFor("codex", home), {recursive: true});
    }
  }});
  await assert.rejects(setup({agent: "codex", home}), {code: "WSSPEC_SKILL_INSTALL_CONFLICT"});
  assert.deepEqual(await readdir(targetFor("codex", home)), []);
});

test("Driver 提供可直接提交的 complete 输入模板，无需逐个猜必填字段", async () => {
  const home = await temporaryHome();
  await install("codex", home);
  const content = await readFile(path.join(targetFor("codex", home), "SKILL.md"), "utf8");
  const sample = content.match(/输入模板：`([^`]+)`/u)?.[1];
  assert.ok(sample, "Driver must include a complete input example");
  const input = JSON.parse(sample) as { outputs: unknown[]; result: Record<string, unknown> };
  assert.deepEqual(input.outputs, []);
  const { validate } = await import("../../src/schemas/index.js");
  assert.doesNotThrow(() => validate("builtin.submit-result.v1", { ...input.result, artifacts: [] }));
  assert.match(content, /不能靠逐条补字段/u);
});
