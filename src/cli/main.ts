#!/usr/bin/env node

import { runApprovalCommand } from "./commands/approval.js";
import { runCommand } from "./commands/core.js";

const version = "0.1.0-alpha.1";
const help = `WSSpecKit\n\n用法：\n  wspec init\n  wspec new <work-item-id> <title> <prompt>\n  wspec new-file <work-item-id> <title> <path>\n  wspec next <work-item-id>\n  wspec status <work-item-id>\n  wspec claim <work-item-id> <stage-id> <actor>\n  wspec context <work-item-id> <stage-id>\n  wspec complete <work-item-id> <stage-id> <result-path>\n  wspec approve <work-item-id> <request-id>\n  wspec reject <work-item-id> <request-id>\n  wspec verify <work-item-id>\n  wspec close <work-item-id>\n  wspec recover <work-item-id>\n`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--version") process.stdout.write(`${version}\n`);
  else if (command === "--help" || command === "-h") process.stdout.write(help);
  else if (command === "approve" || command === "reject") await runApprovalCommand(args, command);
  else {
    const result = await runCommand(process.cwd(), [command ?? "", ...args], args.includes("--json"));
    process.stdout.write(`${JSON.stringify(result, null, args.includes("--json") ? 0 : 2)}\n`);
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && "code" in error ? String((error as Error & { code: unknown }).code) : "WSSPEC_INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
