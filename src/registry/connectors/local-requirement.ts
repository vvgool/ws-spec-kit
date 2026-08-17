import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../../domain/digests.js";
import type { RequirementSourceInput } from "../../protocol/application.js";

export interface CapturedLocalRequirement {
  type: "prompt" | "file";
  origin: string;
  text: string;
  contentDigest: string;
}

export class LocalRequirementError extends Error {
  constructor(readonly code: `WSSPEC_${string}`, message: string) {
    super(`${code}: ${message}`);
    this.name = "LocalRequirementError";
  }
}

export async function captureLocalRequirement(root: string, source: RequirementSourceInput): Promise<CapturedLocalRequirement> {
  let type: CapturedLocalRequirement["type"];
  let origin: string;
  let text: string;
  if (source.type === "prompt") {
    type = "prompt";
    origin = "prompt";
    text = source.text;
  } else if (source.type === "file") {
    type = "file";
    const absolute = path.resolve(root, source.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
      throw new LocalRequirementError("WSSPEC_SOURCE_PATH_INVALID", "需求文件必须位于当前仓库内。 ");
    }
    if (![".md", ".txt"].includes(path.extname(relative).toLowerCase())) {
      throw new LocalRequirementError("WSSPEC_SOURCE_TYPE_UNSUPPORTED", "只支持仓库内 Markdown 或 TXT 需求文件。 ");
    }
    const [realRoot, realSource] = await Promise.all([realpath(root), realpath(absolute)]);
    const realRelative = path.relative(realRoot, realSource);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new LocalRequirementError("WSSPEC_SOURCE_PATH_INVALID", "需求文件真实路径越出当前仓库。 ");
    }
    origin = relative.split(path.sep).join("/");
    text = await readFile(realSource, "utf8");
  } else {
    throw new LocalRequirementError("WSSPEC_SOURCE_TYPE_UNSUPPORTED", "当前阶段只支持 Prompt 和仓库内 Markdown/TXT 来源。 ");
  }
  if (text.trim() === "") throw new LocalRequirementError("WSSPEC_SOURCE_EMPTY", "需求来源不能为空。 ");
  return { type, origin, text, contentDigest: sha256(text) };
}
