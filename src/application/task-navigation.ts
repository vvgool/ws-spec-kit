import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { workItemPrefix } from "../domain/work-item-paths.js";
import { redactText } from "../adapters/process/redaction.js";
import { verifySourceArtifact, type SourceArtifactReference } from "../registry/connectors/requirement-source.js";
import { readEvents, type StoredEvent } from "../storage/events.js";
import { loadApplicationState, type ApplicationState } from "./state.js";

export const taskNavigationMarker = "<!-- wsspec:derived-task-navigation:v1 -->";
export const taskNavigationFiles = ["README.md", "01-原始需求.md"] as const;

function label(value: string): string {
  return redactText(value).replace(/[\r\n]/gu, " ").replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function nextGuidance(state: ApplicationState): string {
  const status = state.projection.workItem.status;
  if (status === "closed" || status === "cancelled") return "任务已结束，可查阅下方交付资料。";
  if (status === "paused") return "任务已暂停；先恢复任务，再继续执行。";
  if (status === "reconciliation_required") return "外部动作需要对账；请先检查动作状态。";
  if (Object.values(state.projection.stages).some((stage) => stage.status === "awaiting_approval")) return "请审核待确认的产物，再继续执行。";
  if (status === "blocked" || Object.values(state.projection.stages).some((stage) => stage.status === "failed")) return "请先查看任务诊断并处理阻塞。";
  if (status === "pending_publish") return "交付已验证，等待发布流程。";
  if (status === "verified") return "交付已验证，可按工作流完成收尾。";
  return "运行 wspec inspect 查看当前执行指引；以引擎返回的状态为准。";
}

/** A disposable view of authoritative state; never an execution input. */
export function renderTaskNavigation(state: ApplicationState, events: readonly StoredEvent[] = []): string {
  const lines = [taskNavigationMarker, `# ${label(state.item.title)}`, "", `- 任务 ID：${label(state.projection.workItemId)}`, `- 状态：${label(state.projection.workItem.status)}`, `- 工作流：${label(state.snapshot.workflowRef)}`, `- 下一步：${nextGuidance(state)}`, "", "## 阶段进度", ""];
  const stageNames: Record<string, string> = { intake: "原始需求", explore: "现状分析", clarify: "需求规格", design: "技术方案", plan: "实施计划", "write-tests": "编写测试", "verify-red": "验证失败测试", implement: "实现", "verify-green": "验证实现", "review-fix": "评审与修复", "edit-document": "编写文档", "verify-document": "文档校验", close: "归档" };
  const statusNames: Record<string, string> = { pending: "待开始", ready: "可执行", claimed: "已领取", running: "执行中", succeeded: "已完成", skipped: "已跳过", failed: "失败", awaiting_approval: "待确认" };
  for (const [id, stage] of Object.entries(state.projection.stages)) lines.push(`- ${label(stageNames[id] ?? id)}：${label(statusNames[stage.status] ?? stage.status)}`);
  lines.push("", "## 交付资料", "", "- [原始需求](01-%E5%8E%9F%E5%A7%8B%E9%9C%80%E6%B1%82.md)");
  const seen = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "artifact.authored" || event.workItemId !== state.projection.workItemId) continue;
    const result = event.result as { value?: { path?: unknown; artifactType?: unknown; contentHash?: unknown } } | null;
    const artifact = result?.value;
    if (artifact === undefined) continue;
    const legacyPath = typeof artifact.artifactType === "string" && /^[a-z][a-z0-9-]*$/u.test(artifact.artifactType)
      && typeof artifact.contentHash === "string" && /^sha256:[a-f0-9]{64}$/u.test(artifact.contentHash)
      ? `${workItemPrefix(state.item)}/artifacts/${artifact.artifactType}/${artifact.contentHash.slice(7)}.md`
      : undefined;
    const artifactPath = typeof artifact.path === "string" ? artifact.path : legacyPath;
    if (artifactPath === undefined) continue;
    // Historical and named task directories both use the canonical logical reference.
    const prefix = `${workItemPrefix(state.item)}/`;
    const relative = artifactPath.startsWith(prefix) ? artifactPath.slice(prefix.length) : undefined;
    if (!relative || !relative.startsWith("artifacts/") || relative.split("/").some((part) => part === ".." || part === "." || part === "") || relative.includes("\\") || seen.has(relative)) continue;
    seen.add(relative);
    const names: Record<string, string> = { specification: "需求规格", design: "技术方案", tasks: "实施计划", "review-result": "评审结果", "exploration-report": "现状分析" };
    const title = artifact.path === undefined && typeof artifact.artifactType === "string"
      ? names[artifact.artifactType] ?? artifact.artifactType
      : path.basename(relative, ".md").replace(/-[a-f0-9]{12}$/u, "");
    lines.push(`- [${label(title)}](${relative.split("/").map(encodeURIComponent).join("/")})`);
  }
  lines.push("", "> 此页面由任务状态和事件派生，可重新生成；不作为执行合同或验收证据。", "");
  return lines.join("\n");
}

// Match the artifact writer's pinned child cwd boundary. All writes use relative
// paths in that directory, so an ancestor rename cannot redirect the write.
const writer = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  let temporary;
  try {
    const request = JSON.parse(input);
    const current = await fs.lstat('.');
    const absolute = await fs.lstat(request.root);
    if (!current.isDirectory() || current.uid !== process.getuid() || (current.mode & 0o022) !== 0 || absolute.isSymbolicLink() || current.dev !== request.dev || current.ino !== request.ino || absolute.dev !== current.dev || absolute.ino !== current.ino || await fs.realpath(request.root) !== request.root) throw Error('unsafe directory');
    for (const [name, content] of Object.entries(request.files)) {
      if (!['README.md', '01-原始需求.md'].includes(name)) throw Error('invalid filename');
      let existing;
      try { existing = await fs.lstat(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== process.getuid() || (existing.mode & 0o022) !== 0) throw Error('unsafe existing file');
        const handle = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (stat.ino !== existing.ino || stat.dev !== existing.dev || stat.size > 2 * 1024 * 1024 || !(await handle.readFile('utf8')).startsWith(request.marker + '\n')) throw Error('unmanaged file');
        } finally { await handle.close(); }
      }
      temporary = '.' + name + '.' + require('node:crypto').randomUUID() + '.tmp';
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if (existing) {
        const latest = await fs.lstat(name);
        if (latest.ino !== existing.ino || latest.dev !== existing.dev || latest.mtimeMs !== existing.mtimeMs || latest.ctimeMs !== existing.ctimeMs) throw Error('file changed');
        await fs.rename(temporary, name);
      } else {
        await fs.link(temporary, name);
        await fs.unlink(temporary);
      }
      temporary = undefined;
    }
  } catch {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    process.exitCode = 1;
  }
});
`;

export async function refreshTaskNavigation(state: ApplicationState): Promise<void> {
  const root = path.resolve(state.itemRoot);
  const identity = await lstat(root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || await realpath(root) !== root) throw new Error("WSSPEC_ARTIFACT_CONFLICT: 任务导航目录不安全。");
  const events = await readEvents(state.projection.controlPlane);
  const reference: SourceArtifactReference = {
    artifactType: "requirement-source", schemaVersion: 1, artifactId: state.item.source.artifactId,
    path: `${workItemPrefix(state.item)}/${state.item.source.snapshot}`, revision: 1, contentHash: state.item.source.artifactDigest, mediaType: "application/json",
  };
  const prefix = workItemPrefix(state.item);
  const source = await verifySourceArtifact(root, state.projection.workItemId, reference, prefix, state.item.execution.directoryName);
  const files = {
    "README.md": renderTaskNavigation(state, events),
    "01-原始需求.md": `${taskNavigationMarker}\n# ${label(source.title)}\n\n${redactText(source.body)}\n\n> 原始需求的阅读副本；权威内容保存在 Source Artifact 中。\n`,
  };
  const child = spawn(process.execPath, ["-e", writer], { cwd: root, env: {}, stdio: ["pipe", "ignore", "ignore"] });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("WSSPEC_ARTIFACT_CONFLICT: 导航文件已被用户占用或无法安全更新。")));
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ root, dev: identity.dev, ino: identity.ino, marker: taskNavigationMarker, files }));
  });
}

/** Navigation failure must not undo or misreport a committed workflow action. */
export async function refreshTaskNavigationFor(root: string, workItemId: string): Promise<void> {
  try {
    const state = await loadApplicationState(root, workItemId);
    await refreshTaskNavigation(state);
    if (state.item.execution.materialized !== false) {
      const mirror = path.join(state.worktree, workItemPrefix(state.item));
      if (mirror !== state.itemRoot) await refreshTaskNavigation({ ...state, itemRoot: mirror });
    }
  } catch {
    process.stderr.write("任务状态已保存；导航文档未刷新，可通过 inspect 重试。\n");
  }
}
