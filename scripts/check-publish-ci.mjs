import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredJobs = ["Quality", "Contract tests", "Unit tests", "Integration tests", "End-to-end tests", "Package contents"];

export function assertPublishCi(input) {
  if (!/^[a-f0-9]{40}$/.test(input.head) || input.branch !== "main" || input.dirty !== "") {
    throw new Error("发布需要干净的 main 工作区。");
  }
  if ([input.tagHead, input.remoteMain, input.remoteTag].some(sha => sha !== input.head)) {
    throw new Error("本地版本标签、远程 main 和远程版本标签必须指向当前提交。");
  }
  const run = input.run;
  if (run?.headSha !== input.head || run.event !== "push" || run.headBranch !== "main"
    || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("当前提交的 main push CI 尚未全部成功，禁止发布。");
  }
  if (!Array.isArray(run.jobs) || requiredJobs.some(name => !run.jobs.some(job => job.name === name))
    || run.jobs.some(job => job.status !== "completed" || job.conclusion !== "success")) {
    throw new Error("CI 缺少必需作业，或存在失败、跳过、未完成的作业。");
  }
}

export function checkPublishCi(cwd = process.cwd()) {
  const run = (command, args) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = run("git", ["rev-parse", "HEAD"]);
  const branch = run("git", ["branch", "--show-current"]);
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=normal"]);
  if (branch !== "main" || dirty) throw new Error("发布需要干净的 main 工作区。");
  const { version } = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("发布版本不合法。");
  const tag = `refs/tags/v${version}`;
  const tagHead = run("git", ["rev-parse", `${tag}^{}`]);
  const refs = new Map(run("git", ["ls-remote", "origin", "refs/heads/main", tag, `${tag}^{}`])
    .split("\n").filter(Boolean).map(line => { const [sha, ref] = line.split(/\s+/); return [ref, sha]; }));
  const runs = JSON.parse(run("gh", ["run", "list", "--workflow", "ci.yml", "--branch", "main", "--event", "push", "--commit", head, "--limit", "1", "--json", "databaseId"]));
  if (!Number.isSafeInteger(runs[0]?.databaseId)) throw new Error("未找到当前提交的 CI，禁止发布。");
  const ci = JSON.parse(run("gh", ["run", "view", String(runs[0].databaseId), "--json", "headSha,headBranch,event,status,conclusion,jobs"]));
  assertPublishCi({ head, branch, dirty, tagHead, remoteMain: refs.get("refs/heads/main"), remoteTag: refs.get(`${tag}^{}`) ?? refs.get(tag), run: ci });
  console.log(`发布 CI 已通过：${head} / v${version} / run ${runs[0].databaseId}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkPublishCi(); }
  catch (error) {
    console.error(`发布检查失败：${error instanceof Error ? error.message.split("\n")[0] : "无法验证 CI"}`);
    process.exitCode = 1;
  }
}
