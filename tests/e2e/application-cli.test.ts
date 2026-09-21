import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultProjectConfig, initRepository } from "../../src/storage/repository.js";
import { createGitRepository } from "../integration/helpers/git.js";

interface CliResult { code: number | null; stdout: string; stderr: string }
interface RunningCli { result: Promise<CliResult> }

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function startCli(
  cwd: string,
  args: string[],
  home: string,
  entrypoint = path.join(repositoryRoot, "src/cli/main.ts"),
  environment: Record<string, string> = {},
): RunningCli {
  const child = spawn(process.execPath, ["--import", path.join(repositoryRoot, "node_modules/tsx/dist/loader.mjs"), entrypoint, ...args], {
    cwd,
    env: { ...process.env, HOME: home, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = new Promise<CliResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { result };
}

async function runCli(
  cwd: string,
  args: string[],
  home: string,
  entrypoint = path.join(repositoryRoot, "src/cli/main.ts"),
  environment: Record<string, string> = {},
): Promise<CliResult> {
  return startCli(cwd, args, home, entrypoint, environment).result;
}


test("公开 CLI 只暴露 Application 命令并将旧命令拒绝为未知命令", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  const help = await runCli(root, ["--help"], home);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /\binit\b/);
  assert.match(help.stdout, /\bstart\b/);
  assert.match(help.stdout, /\bacquire\b/);
  assert.match(help.stdout, /\bsubmit\b/);
  assert.match(help.stdout, /\bdecide\b/);
  assert.match(help.stdout, /\binspect\b/);
  assert.match(help.stdout, /\bworkflow\b/);
  assert.match(help.stdout, /\bagent install\b/);
  assert.doesNotMatch(help.stdout, /\bnew-file\b|\bclaim\b|\bresume\b/);

  for (const legacy of ["new", "resume", "claim"]) {
    const result = await runCli(root, [legacy], home);
    assert.equal(result.code, 1, legacy);
    assert.match(`${result.stdout}${result.stderr}`, /WSSPEC_COMMAND_UNKNOWN/, legacy);
  }

  const target = await runCli(root, ["agent", "install", "codex", "--target", path.join(home, "ignored"), "--dry-run"], home);
  assert.equal(target.code, 1);
  assert.match(target.stdout, /WSSPEC_ARGUMENT_INVALID/);

  for (const args of [["init", "extra"], ["start", "extra", "--prompt", "需求"], ["acquire", "WSS-EXTRA", "extra", "--actor", "agent"]]) {
    const result = await runCli(root, args, home);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stdout, /WSSPEC_ARGUMENT_INVALID/, args.join(" "));
  }
});

test("核心 CLI 的 value option 拒绝缺值、相邻 option 与重复项，并保持 dry-run 无写入", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  const cases: Array<{ args: string[]; code: string }> = [
    { args: ["start", "--prompt", "--provider"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["start", "--prompt", ""], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["start", "--prompt", "需求", "--prompt", "重复"], code: "WSSPEC_ARGUMENT_INVALID" },
    { args: ["submit", "WSS-CLI", "--step", "--attempt", "attempt-1", "--lease", "lease", "--result", "result.json", "--actor", "agent"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["submit", "WSS-CLI", "--step", "step", "--step", "again", "--attempt", "attempt-1", "--lease", "lease", "--result", "result.json", "--actor", "agent"], code: "WSSPEC_ARGUMENT_INVALID" },
    { args: ["decide", "--input", "--actor", "agent"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["decide", "--input", "decision.json", "--actor", "agent", "--actor", "again"], code: "WSSPEC_ARGUMENT_INVALID" },
    { args: ["agent", "install", "generic", "--target", "--dry-run"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["agent", "install", "generic", "--target", "", "--dry-run"], code: "WSSPEC_ARGUMENT_REQUIRED" },
    { args: ["agent", "install", "generic", "--target", "one", "--target", "two", "--dry-run"], code: "WSSPEC_ARGUMENT_INVALID" },
  ];

  for (const current of cases) {
    const result = await runCli(root, current.args, home);
    assert.equal(result.code, 1, current.args.join(" "));
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(current.code), current.args.join(" "));
  }
  await assert.rejects(access(path.join(root, "--dry-run", "SKILL.md")), /ENOENT/);
});

test("CLI start 暴露明确的外部 Source 合同并拒绝歧义组合", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  const accepted = [
    ["start", "--source-provider", "github", "--source-id", "https://github.example.com/acme/widget/issues/7"],
    ["start", "--source-id", "https://gitlab.example.com/group/service/-/issues/9", "--source-provider", "gitlab", "--source-url", "https://gitlab.example.com/group/service/-/issues/9"],
    ["start", "--source-provider", "feishu", "--source-id", "https://tenant.feishu.cn/docx/sourceDocumentToken123"],
  ];
  for (const args of accepted) {
    const result = await runCli(root, args, home);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stdout, /WSSPEC_REPOSITORY_NOT_INITIALIZED/u, args.join(" "));
    assert.doesNotMatch(result.stdout, /WSSPEC_ARGUMENT_INVALID/u, args.join(" "));
  }

  const rejected = [
    ["start", "--source-provider", "github"],
    ["start", "--source-id", "https://github.example.com/acme/widget/issues/7"],
    ["start", "--source-provider", "unknown", "--source-id", "https://example.com/item/1"],
    ["start", "--prompt", "歧义", "--source-provider", "github", "--source-id", "https://github.example.com/acme/widget/issues/7"],
    ["start", "--source-provider", "github", "--source-id", "https://github.example.com/acme/widget/issues/7", "--source-url", "https://github.example.com/acme/widget/issues/8"],
  ];
  for (const args of rejected) {
    const result = await runCli(root, args, home);
    assert.equal(result.code, 1, args.join(" "));
    const output = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    assert.equal(output.error.code, "WSSPEC_ARGUMENT_INVALID", args.join(" "));
    assert.match(output.error.message, /外部来源|start|Source|Provider/u, args.join(" "));
  }
});

test("CLI start reaches the default GitHub/GitLab runtime and exposes fixed authentication failures", async (t) => {
  for (const scenario of [
    {
      provider: "github",
      executable: "gh",
      source: "https://github.example.com/unauthorized/widget/issues/7",
    },
    {
      provider: "gitlab",
      executable: "glab",
      source: "https://gitlab.example.com/unauthorized/service/-/issues/9",
    },
  ]) {
    await t.test(scenario.provider, async () => {
      const root = await createGitRepository();
      await initRepository(root);
      const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
      const bin = path.join(home, "bin");
      await mkdir(bin, { recursive: true });
      await cp(path.join(repositoryRoot, "tests/fixtures/bin", scenario.executable), path.join(bin, scenario.executable));
      const result = await runCli(root, [
        "start",
        "--source-provider", scenario.provider,
        "--source-id", scenario.source,
        "--profile", "standard",
      ], home, path.join(repositoryRoot, "src/cli/main.ts"), {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      });
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
      assert.equal(output.ok, false);
      assert.equal(output.error.code, "WSSPEC_ISSUE_UNAUTHENTICATED");
      assert.match(output.error.message, /未认证/u);
    });
  }
});

test("CLI 对 malformed result JSON 只输出固定 internal 错误且不泄露 parser 详情", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  const resultFile = "malformed-result.json";
  await writeFile(path.join(root, resultFile), "credential=cli-round4-secret", "utf8");

  const result = await runCli(root, ["submit", "WSS-PROBE", "--step", "probe", "--attempt", "probe", "--lease", "probe", "--result", resultFile], home);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, `${JSON.stringify({ ok: false, error: { code: "WSSPEC_INTERNAL_ERROR", message: "发生未预期的内部错误。" } })}\n`);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /cli-round4-secret|Unexpected token|not valid JSON/u);
});

test("CLI 对 delayed Start 与 rollback 双失败只输出固定安全消息", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  const secret = `cli-rollback-secret-${crypto.randomUUID()}`;
  const workItemsRoot = path.join(await realpath(root), ".git", "wsspec", "work-items");
  await initRepository(root);
  await writeFile(path.join(root, ".wsspec", "config.yaml"), `${JSON.stringify({
    ...defaultProjectConfig(),
    git: { worktrees: { enabled: true, root: `.worktrees/${secret}`, branchPrefix: "wspec/" } },
  }, null, 2)}\n`, "utf8");
  // Inject inside the child at the first application snapshot write after the
  // locator exists, so another mkdir cannot race the parent's directory swap.
  const entrypoint = path.join(home, "rollback-injection.mjs");
  const marker = path.join(home, "rollback-injected");
  await writeFile(entrypoint, `
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const originalMkdir = fs.mkdir;
let injected = false;
fs.mkdir = async function(directory, ...args) {
  if (!injected && typeof directory === 'string'
      && directory.startsWith(${JSON.stringify(workItemsRoot + path.sep)})
      && path.basename(directory) === 'snapshot') {
    const locatorPath = path.resolve(directory, '../../locator.json');
    let locator;
    try { locator = JSON.parse(await fs.readFile(locatorPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (locator) {
      injected = true;
      await fs.writeFile(locatorPath, JSON.stringify({ ...locator, ownerToken: ${JSON.stringify(secret)} }));
      await fs.writeFile(${JSON.stringify(marker)}, 'injected');
      throw new Error(${JSON.stringify(`credential=${secret}`)});
    }
  }
  return originalMkdir.call(this, directory, ...args);
};
syncBuiltinESMExports();
await import(${JSON.stringify(path.join(repositoryRoot, "src/cli/main.ts"))});
`, "utf8");
  const result = await runCli(root, ["start", "--prompt", "rollback fault injection"], home, entrypoint);
  assert.equal(await readFile(marker, "utf8"), "injected");

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: { code: "WSSPEC_START_ROLLBACK_FAILED", message: "Start 失败且无法安全回滚新建 Work Item。" },
  });
  assert.doesNotMatch(result.stdout, new RegExp(`${secret}|${workItemsRoot}|ENOTDIR|ENOENT|Git command failed|stack|details`, "u"));
});

test("CLI acquire 将当前 host 配置缺失报告为 Global root 未绑定", async () => {
  const root = await createGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  const additionalRoot = path.join(home, "shared-skills");
  await initRepository(root);
  await mkdir(additionalRoot, { recursive: true });
  await writeFile(path.join(root, ".wsspec", "config.yaml"), `${JSON.stringify({
    ...defaultProjectConfig(),
    skills: { additionalGlobalRoots: [{ id: "shared", path: additionalRoot }] },
  }, null, 2)}\n`, "utf8");
  const started = await runCli(root, ["start", "--prompt", "缺失宿主配置", "--provider", "generic", "--profile", "quick"], home);
  assert.equal(started.code, 0);
  const startOutput = JSON.parse(started.stdout) as { result: { workItemId: string } };
  await rm(path.join(root, ".wsspec", "config.yaml"));

  const acquired = await runCli(root, ["acquire", startOutput.result.workItemId, "--actor", "codex"], home);

  assert.equal(acquired.code, 1);
  assert.equal(acquired.stderr, "");
  const output = JSON.parse(acquired.stdout) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "WSSPEC_GLOBAL_ROOT_NOT_CONFIGURED");
  assert.notEqual(output.error.message, "发生未预期的内部错误。");
  assert.doesNotMatch(acquired.stdout, /ENOENT|config\.yaml|stack|details/u);
});

test("每个公开 CLI route 至少保留一个可机器恢复的进程级领域失败", async (t) => {
  const initialized = await createGitRepository();
  const uninitialized = await createGitRepository();
  const nonRepository = await mkdtemp(path.join(os.tmpdir(), "wspec-non-repository-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "wspec-cli-home-"));
  await initRepository(initialized);

  const resultFile = "result.json";
  await writeFile(path.join(initialized, resultFile), `${JSON.stringify({
    version: 1,
    status: "completed",
    summary: "probe",
    modifiedFiles: [],
    artifacts: [],
    commands: [],
    evidence: [],
    externalWrites: [],
    remainingRisks: [],
  })}\n`, "utf8");
  const decisionFile = "decision.json";
  await writeFile(path.join(initialized, decisionFile), `${JSON.stringify({
    kind: "approval",
    workItemId: "WSS-MISSING",
    requestId: "missing",
    decision: "approved",
    expectedDigest: "sha256:missing",
  })}\n`, "utf8");
  const ejectTarget = path.join(await mkdtemp(path.join(os.tmpdir(), "wspec-eject-existing-")), "target");
  await mkdir(ejectTarget);
  const driverTarget = path.join(home, ".agents", "skills", "wsspeckit-driver");
  await mkdir(driverTarget, { recursive: true });
  await writeFile(path.join(driverTarget, "SKILL.md"), "---\nname: unrelated\n---\n", "utf8");

  const cases: Array<{ route: string; cwd: string; args: string[]; code: string }> = [
    { route: "init", cwd: nonRepository, args: ["init"], code: "WSSPEC_GIT_REPOSITORY_REQUIRED" },
    { route: "start", cwd: uninitialized, args: ["start", "--prompt", "需求"], code: "WSSPEC_REPOSITORY_NOT_INITIALIZED" },
    { route: "acquire", cwd: initialized, args: ["acquire", "WSS-MISSING", "--actor", "agent"], code: "WSSPEC_WORK_ITEM_NOT_FOUND" },
    { route: "submit", cwd: initialized, args: ["submit", "WSS-MISSING", "--step", "probe", "--attempt", "attempt-probe", "--lease", "probe", "--result", resultFile], code: "WSSPEC_WORK_ITEM_NOT_FOUND" },
    { route: "decide", cwd: initialized, args: ["decide", "--input", decisionFile, "--actor", "reviewer"], code: "WSSPEC_INTERACTIVE_TTY_REQUIRED" },
    { route: "inspect", cwd: initialized, args: ["inspect", "WSS-MISSING"], code: "WSSPEC_WORK_ITEM_NOT_FOUND" },
    { route: "workflow show", cwd: initialized, args: ["workflow", "show", "builtin://workflows/missing"], code: "WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND" },
    { route: "workflow eject", cwd: initialized, args: ["workflow", "eject", "builtin://workflows/feature-delivery", ejectTarget], code: "WSSPEC_WORKFLOW_EJECT_TARGET_EXISTS" },
    { route: "workflow validate", cwd: initialized, args: ["workflow", "validate", "builtin://workflows/missing"], code: "WSSPEC_WORKFLOW_PACKAGE_NOT_FOUND" },
    { route: "workflow use", cwd: uninitialized, args: ["workflow", "use", "builtin://workflows/feature-delivery"], code: "WSSPEC_REPOSITORY_NOT_INITIALIZED" },
    { route: "agent install", cwd: initialized, args: ["agent", "install", "codex"], code: "WSSPEC_SKILL_INSTALL_CONFLICT" },
  ];

  for (const current of cases) {
    await t.test(current.route, async () => {
      const result = await runCli(current.cwd, current.args, home);
      assert.equal(result.code, 1);
      const output = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; message: string } };
      assert.equal(output.ok, false, current.route);
      assert.equal(output.error.code, current.code, current.route);
      assert.notEqual(output.error.message, "发生未预期的内部错误。", current.route);
    });
  }

  await t.test("workflow list", async () => {
    const runtime = await mkdtemp(path.join(repositoryRoot, ".cli-runtime-"));
    try {
      await Promise.all([
        cp(path.join(repositoryRoot, "src"), path.join(runtime, "src"), { recursive: true }),
        cp(path.join(repositoryRoot, "resources"), path.join(runtime, "resources"), { recursive: true }),
        cp(path.join(repositoryRoot, "package.json"), path.join(runtime, "package.json")),
      ]);
      await writeFile(path.join(runtime, "resources", "catalog.yaml"), "version: 99\nskills: []\nworkflows: []\n", "utf8");
      const result = await runCli(initialized, ["workflow", "list"], home, path.join(runtime, "src/cli/main.ts"));
      assert.equal(result.code, 1);
      const output = JSON.parse(result.stdout) as { error: { code: string } };
      assert.equal(output.error.code, "WSSPEC_BUILTIN_CATALOG_INVALID");
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  });
});

test("agent status 在未初始化目录运行并返回接入指引，拒绝 install 专属参数", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-status-home-")));
  try {
    for (const selector of [["--client", "codex"], ["codex"]]) {
      const response = await runCli(home, ["agent", "status", ...selector], home);
      assert.equal(response.code, 0, response.stdout);
      const result = JSON.parse(response.stdout).result;
      assert.equal(result.status, "missing");
      assert.equal(result.hostLoaded, "unknown");
      assert.equal(result.target, path.join(home, ".agents/skills/wsspeckit-driver"));
    }
    const invalid = await runCli(home, ["agent", "status", "codex", "--dry-run"], home);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stdout, /WSSPEC_ARGUMENT_INVALID/);
    await assert.rejects(access(path.join(home, ".agents")), /ENOENT/);
  } finally { await rm(home, {recursive: true, force: true}); }
});

test("agent setup 一条命令完成目录创建和安装，支持预演与重复运行", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-setup-home-")));
  try {
    const args = ["agent", "setup", "--client", "codex"];
    const preview = await runCli(home, [...args, "--dry-run"], home);
    assert.equal(preview.code, 0, preview.stdout);
    assert.equal(JSON.parse(preview.stdout).result.status, "missing");
    await assert.rejects(access(path.join(home, ".agents")), /ENOENT/);
    for (let count = 0; count < 2; count++) {
      const result = await runCli(home, args, home);
      assert.equal(result.code, 0, result.stdout);
      assert.equal(JSON.parse(result.stdout).result.status, "current");
      assert.equal(JSON.parse(result.stdout).result.hostLoaded, "unknown");
    }
  } finally { await rm(home, {recursive: true, force: true}); }
});

test("start intent routes explicit user intent and rejects ambiguous selection", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "wspec-intent-home-")));
  for (const [intent, workflow] of [["feature", "feature-delivery"], ["fix", "bugfix-delivery"], ["assessment", "assessment"], ["docs", "documentation-delivery"]]) {
    const output = await runCli(root, ["start", "--prompt", "验证意图入口", "--intent", intent!, "--profile", "quick"], home);
    assert.equal(output.code, 0, output.stdout);
    assert.equal(JSON.parse(output.stdout).result.workflowRef, `builtin://workflows/${workflow}`);
  }
  for (const args of [["--intent", "guess"], ["--intent", "fix", "--workflow", "builtin://workflows/feature-delivery"]]) {
    const output = await runCli(root, ["start", "--prompt", "歧义", ...args], home);
    assert.equal(output.code, 1);
    assert.match(output.stdout, /WSSPEC_ARGUMENT_INVALID/);
  }
});

test("agent project setup and remove preserve existing instructions", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const filename = path.join(root, "AGENTS.md");
  const original = "# 用户项目规则\n保持中文\n";
  await writeFile(filename, original);
  for (const args of [["setup", "--dry-run"], ["setup"], ["setup"], ["remove"]]) {
    const output = await runCli(root, ["agent", "project", ...args], root);
    assert.equal(output.code, 0, output.stdout);
    if (args.includes("--dry-run")) assert.equal(await readFile(filename, "utf8"), original);
  }
  assert.equal(await readFile(filename, "utf8"), original);
});

test("continue resumes the same grant and status reports the same Work Item", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const started = JSON.parse((await runCli(root, ["start", "--prompt", "只读评估", "--workflow", "builtin://workflows/assessment"], root)).stdout).result;
  const args = ["continue", started.workItemId, "--actor", "codex"];
  const first = await runCli(root, args, root);
  const second = await runCli(root, args, root);
  assert.equal(first.code, 0, first.stdout);
  assert.equal(second.code, 0, second.stdout);
  assert.deepEqual(JSON.parse(second.stdout).result, JSON.parse(first.stdout).result);
  const view = await runCli(root, ["status", started.workItemId], root);
  assert.equal(view.code, 0, view.stdout);
  assert.equal(JSON.parse(view.stdout).result.workItemId, started.workItemId);
});

test("complete accepts captured CLI JSON and output mapping through assessment completion", async () => {
  const root = await createGitRepository();
  await initRepository(root);
  const start = await runCli(root, ["start", "--prompt", "只读评估", "--intent", "assessment"], root);
  assert.equal(start.code, 0, start.stdout);
  const id = JSON.parse(start.stdout).result.workItemId;
  const first = await runCli(root, ["continue", id, "--actor", "codex"], root);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "wspec-completion-input-"));
  const packageFile = path.join(scratch, "grant.json");
  const inputFile = path.join(scratch, "completion.json");
  const result = {version: 1, status: "completed", summary: "完成", modifiedFiles: [], commands: [], evidence: [], externalWrites: [], remainingRisks: []};
  await writeFile(packageFile, first.stdout);
  await writeFile(inputFile, JSON.stringify({outputs: [], result}));
  const args = ["complete", id, "--actor", "codex", "--package", packageFile, "--input", inputFile];
  const second = await runCli(root, args, root);
  assert.equal(second.code, 0, second.stdout);
  const wp = JSON.parse(second.stdout).result.workPackage;
  assert.equal(wp.stepId, "assess");
  const draft = path.join(root, wp.artifactAuthoring.draftRoots[1], "assessment.md");
  await mkdir(path.dirname(draft), {recursive:true});
  await writeFile(draft, "# 评估\n基于已读取资料给出结论，真实部署验证尚未执行。\n");
  await writeFile(packageFile, second.stdout);
  await writeFile(inputFile, JSON.stringify({outputs: [{outputId: "assessment-report", contentFile: path.relative(root, draft)}], result}));
  const final = await runCli(root, args, root);
  assert.equal(final.code, 0, final.stdout);
  assert.equal(JSON.parse(final.stdout).result.action, "completed");
});

test("Host 禁止 Git 控制面写入时 start 返回明确权限错误且不创建任务", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await createGitRepository());
  await initRepository(root);
  const profile = `(version 1) (allow default) (deny file-write* (subpath ${JSON.stringify(path.join(root, ".git"))}))`;
  const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--import", path.join(repositoryRoot, "node_modules/tsx/dist/loader.mjs"), path.join(repositoryRoot, "src/cli/main.ts"), "start", "--intent", "assessment", "--prompt", "权限验收"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 1, stderr);
  const output = JSON.parse(stdout) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(output.error.code, "WSSPEC_FILESYSTEM_PERMISSION_DENIED");
  assert.match(output.error.message, /Host 沙箱/u);
  assert.equal(stdout.includes(root), false);
  await assert.rejects(access(path.join(root, ".git/wsspec/work-items")), /ENOENT/u);
});
