import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDriverSkillInstaller, installDriverSkill } from "../../src/adapters/skills/install.js";
import { createWriteFileAtomic } from "../../src/storage/files.js";

test("Codex Driver 安装只写入临时 HOME 的官方目录，并包含中文执行循环", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
  const result = await installDriverSkill({ agent: "codex", home });
  assert.equal(result.target, path.join(home, ".agents", "skills", "wsspeckit-driver"));
  const skill = await readFile(path.join(result.target, "SKILL.md"), "utf8");
  assert.match(skill, /新任务判断功能\/文档 Workflow/);
  assert.match(skill, /已有任务 inspect -> acquire/);
  assert.match(skill, /面向用户的说明、文档和交互文案默认使用中文/);
  assert.match(skill, /协议字段、类型名、URI、命令名和错误码保持英文/);
  await assert.rejects(access(path.join(home, ".cursor", "rules", "wsspeckit-driver.mdc")), /ENOENT/);
});

test("Driver 安装 dry-run 不创建目录，Generic 必须提供显式目标", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
  const preview = await installDriverSkill({ agent: "claude", home, dryRun: true });
  await assert.rejects(access(preview.target), /ENOENT/);
  await assert.rejects(installDriverSkill({ agent: "generic", home }), (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_ARGUMENT_REQUIRED");
});

test("安装器只升级具有完整 canonical 标识的既有 Driver", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
  const target = path.join(home, ".agents", "skills", "wsspeckit-driver");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), "---\nname: unrelated-skill\ndescription: name: wsspeckit-driver\n---\n\n正文\n", "utf8");
  await assert.rejects(
    installDriverSkill({ agent: "codex", home }),
    (error: unknown) => error instanceof Error && "code" in error && (error as Error & { code: string }).code === "WSSPEC_SKILL_INSTALL_CONFLICT",
  );
  const before = await readFile(path.join(target, "SKILL.md"), "utf8");
  assert.match(before, /unrelated-skill/);
  const ownedHome = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
  const ownedTarget = path.join(ownedHome, ".agents", "skills", "wsspeckit-driver", "SKILL.md");
  await installDriverSkill({ agent: "codex", home: ownedHome, dryRun: false });
  await installDriverSkill({ agent: "codex", home: ownedHome, dryRun: false });
  assert.match(await readFile(ownedTarget, "utf8"), /wsspeckit-driver-version: 1/);
});

test("同名 Driver 的损坏标识或正文篡改也必须拒绝覆盖", async (t) => {
  for (const mutate of [
    (content: string) => content.replace(/wsspeckit-driver-content-digest: sha256:[a-f0-9]+/u, "wsspeckit-driver-content-digest: sha256:forged"),
    (content: string) => content.replace("新任务判断功能/文档 Workflow", "被篡改的 Driver 正文"),
  ]) {
    await t.test(mutate.name || "altered", async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
      const target = path.join(home, ".agents", "skills", "wsspeckit-driver", "SKILL.md");
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

test("更新既有 Driver 写入失败时保留原有可发现入口", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
  const target = path.join(home, ".agents", "skills", "wsspeckit-driver", "SKILL.md");
  await installDriverSkill({ agent: "codex", home });
  const before = await readFile(target, "utf8");

  const install = createDriverSkillInstaller({ writeSkill: async () => { throw new Error("injected write failure"); } });
  await assert.rejects(
    install({
      agent: "codex",
      home,
    }),
    /injected write failure/,
  );

  assert.equal(await readFile(target, "utf8"), before);
});

test("原子 Driver 写入在 write、fsync 与 rename 故障时保留发现入口并清理临时文件", async (t) => {
  for (const phase of ["write", "file-sync", "rename"] as const) {
    await t.test(phase, async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
      const target = path.join(home, ".agents", "skills", "wsspeckit-driver", "SKILL.md");
      await installDriverSkill({ agent: "codex", home });
      const before = await readFile(target, "utf8");
      const writer = createWriteFileAtomic({
        open: async (filename, flags, mode) => {
          const handle = await open(filename, flags, mode);
          if (filename === path.dirname(target)) return handle;
          if (phase === "write") return { writeFile: async () => { throw new Error("injected write failure"); }, sync: handle.sync.bind(handle), close: handle.close.bind(handle) };
          if (phase === "file-sync") return { writeFile: handle.writeFile.bind(handle), sync: async () => { throw new Error("injected file sync failure"); }, close: handle.close.bind(handle) };
          return handle;
        },
        rename: async (source, destination) => {
          if (phase === "rename") throw new Error("injected rename failure");
          await rename(source, destination);
        },
      });
      const install = createDriverSkillInstaller({ writeSkill: writer });

      await assert.rejects(install({ agent: "codex", home }), /injected/);
      assert.equal(await readFile(target, "utf8"), before);
      assert.deepEqual((await readdir(path.dirname(target))).filter((name) => name.endsWith(".tmp")), []);
    });
  }
});

test("目录 fsync 故障后仍保留可发现 Driver 并清理临时文件", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-driver-home-"));
  const target = path.join(home, ".agents", "skills", "wsspeckit-driver", "SKILL.md");
  const writer = createWriteFileAtomic({
    open: async (filename, flags, mode) => {
      const handle = await open(filename, flags, mode);
      if (filename !== path.dirname(target)) return handle;
      return { writeFile: handle.writeFile.bind(handle), sync: async () => { throw new Error("injected directory sync failure"); }, close: handle.close.bind(handle) };
    },
  });
  const install = createDriverSkillInstaller({ writeSkill: writer });

  await assert.rejects(install({ agent: "codex", home }), /injected directory sync failure/);
  assert.match(await readFile(target, "utf8"), /name: wsspeckit-driver/);
  assert.deepEqual((await readdir(path.dirname(target))).filter((name) => name.endsWith(".tmp")), []);
});
