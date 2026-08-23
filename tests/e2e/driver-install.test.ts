import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDriverSkillInstaller, installDriverSkill, secureInstallDriverFile } from "../../src/adapters/skills/install.js";

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
  assert.match(skill, /已有任务或 Host 重启后的恢复固定执行 inspect -> acquire/);
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
  assert.match(first, /wsspeckit-driver-version: 6/);
});

test("安装器拒绝原地升级所有已登记的历史 canonical Driver", async (t) => {
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

        const updated = await readFile(path.join(target, "SKILL.md"), "utf8");
        assert.equal(updated, before);
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
