import { createInterface } from "node:readline/promises";

import { ApprovalError, decideArtifactApproval } from "../../engine/approvals.js";
import { readControlPlane } from "../../storage/control-plane.js";

export async function runApprovalCommand(args: string[], decision: "approve" | "reject", terminal = process.stdin): Promise<void> {
  if (terminal.isTTY !== true || args.includes("--yes")) throw new ApprovalError("WSSPEC_INTERACTIVE_TTY_REQUIRED", "审批必须在真实 TTY 中现场确认，且不支持 --yes。");
  const [workItemId, requestId] = args;
  if (workItemId === undefined || requestId === undefined) throw new ApprovalError("WSSPEC_ARGUMENT_REQUIRED", "缺少 Work Item ID 或审批请求 ID。");
  const projection = await readControlPlane(process.cwd(), workItemId);
  const request = projection.approvals[requestId];
  if (request === undefined) throw new ApprovalError("WSSPEC_APPROVAL_NOT_PENDING", "审批请求不存在。");
  process.stdout.write(`${JSON.stringify({ workItemId, stageId: request.stageId, artifactPath: request.artifactPath, diff: request.artifactDiff, contentHash: request.contentHash, outputWorkspaceTreeDigest: request.workspaceTreeDigest, invalidationScope: [request.stageId] }, null, 2)}\n`);
  const readline = createInterface({ input: terminal, output: process.stdout });
  try {
    const answer = await readline.question(`输入 ${decision} 确认 ${requestId}: `);
    if (answer.trim() !== decision) throw new ApprovalError("WSSPEC_APPROVAL_CONFIRMATION_MISMATCH", "现场确认内容不匹配。");
  } finally {
    readline.close();
  }
  const record = await decideArtifactApproval({ cwd: process.cwd(), workItemId, requestId, decision, terminal });
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
