import { readFile } from "node:fs/promises";

import { matchesRepositoryPath, resolveRepositoryRegularFile } from "../domain/repository-path.js";

export interface DocumentationProblem { code: string; file: string; message: string }

export async function checkDocumentationIntegrity(input: { root: string; files: string[]; allowedPaths: string[] }): Promise<{ ok: boolean; problems: DocumentationProblem[] }> {
  const problems: DocumentationProblem[] = [];
  for (const file of input.files) {
    const normalized = file;
    if (!input.allowedPaths.some((allowed) => matchesRepositoryPath(allowed, normalized))) {
      problems.push({ code: "WSSPEC_DOCUMENTATION_SCOPE_VIOLATION", file, message: "文件不在文档工作流允许路径内。" });
      continue;
    }
    let bytes: Buffer;
    try { bytes = await readFile(await resolveRepositoryRegularFile(input.root, normalized)); }
    catch { problems.push({ code: "WSSPEC_DOCUMENTATION_FILE_INVALID", file, message: "文档必须是仓库内的普通文件，且不能经过符号链接。" }); continue; }
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { problems.push({ code: "WSSPEC_DOC_INVALID_UTF8", file, message: "文档不是有效 UTF-8。" }); continue; }
    if (content.trim() === "") problems.push({ code: "WSSPEC_DOC_EMPTY", file, message: "文档正文为空。" });
    if (/^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(content)) problems.push({ code: "WSSPEC_DOC_CONFLICT_MARKER", file, message: "文档包含未解决的冲突标记。" });
  }
  return { ok: problems.length === 0, problems };
}
