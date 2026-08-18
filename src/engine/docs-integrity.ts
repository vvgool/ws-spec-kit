import { readFile } from "node:fs/promises";
import path from "node:path";

export interface DocumentationProblem { code: string; file: string; message: string }

function matches(file: string, pattern: string): boolean {
  if (pattern === file || pattern === "**") return true;
  if (pattern.startsWith("*.")) return !file.includes("/") && file.endsWith(pattern.slice(1));
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -3) + "/");
  return false;
}

export async function checkDocumentationIntegrity(input: { root: string; files: string[]; allowedPaths: string[] }): Promise<{ ok: boolean; problems: DocumentationProblem[] }> {
  const problems: DocumentationProblem[] = [];
  for (const file of input.files) {
    const normalized = file.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..") || !input.allowedPaths.some((allowed) => matches(normalized, allowed))) {
      problems.push({ code: "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION", file, message: "文件不在文档工作流允许路径内。" });
      continue;
    }
    const bytes = await readFile(path.join(input.root, normalized));
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { problems.push({ code: "WSSPEC_DOC_INVALID_UTF8", file, message: "文档不是有效 UTF-8。" }); continue; }
    if (content.trim() === "") problems.push({ code: "WSSPEC_DOC_EMPTY", file, message: "文档正文为空。" });
    if (/^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(content)) problems.push({ code: "WSSPEC_DOC_CONFLICT_MARKER", file, message: "文档包含未解决的冲突标记。" });
  }
  return { ok: problems.length === 0, problems };
}
