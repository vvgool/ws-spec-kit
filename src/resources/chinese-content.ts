import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface ChineseContentFinding { filename: string; line: number; text: string }
export interface ChineseContentInput { files?: Array<{ filename: string; content: string }>; root?: string }

const allowedEnglish = new Set([
  "WSSpecKit", "WSSpec", "Workflow", "Package", "Profile", "Skill", "Driver", "CLI", "JSON", "Git", "Markdown", "TTY", "Codex", "Claude", "Cursor", "Generic", "URI", "URL", "API", "Agent", "Work Item", "Step", "Artifact", "Gate", "Prompt", "Builtin", "dry-run",
]);

function proseFragments(line: string): string[] {
  const withoutCode = line.replace(/`[^`]*`/gu, "").replace(/https?:\/\/\S+/gu, "").replace(/(?:^|\s)(?:[./~][\w./-]*|[\w.-]+\/[\w./-]+)(?=\s|$)/gu, " ");
  return withoutCode.match(/[A-Za-z][A-Za-z .,'"()/-]*/gu) ?? [];
}

function isAllowed(fragment: string): boolean {
  const normalized = fragment.trim().replace(/[.,;:!?()"']/gu, "").replace(/\s+/gu, " ");
  return normalized === "" || allowedEnglish.has(normalized) || /^WSSPEC_[A-Z_]+$/.test(normalized);
}

function inspect(filename: string, content: string): ChineseContentFinding[] {
  const findings: ChineseContentFinding[] = [];
  let fenced = false;
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (line.trimStart().startsWith("```")) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const text of proseFragments(line)) if (!isAllowed(text)) findings.push({ filename, line: index + 1, text: text.trim() });
  }
  return findings;
}

async function filesUnder(root: string, directory: string): Promise<Array<{ filename: string; content: string }>> {
  const target = path.join(root, directory);
  try {
    const entries = await readdir(target, { withFileTypes: true, encoding: "utf8" });
    const files: Array<{ filename: string; content: string }> = [];
    for (const entry of entries) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await filesUnder(root, relative));
      else if (entry.isFile()) files.push({ filename: relative.split(path.sep).join("/"), content: await readFile(path.join(root, relative), "utf8") });
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function validateChineseContent(input: ChineseContentInput): Promise<ChineseContentFinding[]> {
  const files = input.files ?? (input.root === undefined ? [] : (await Promise.all([
    filesUnder(input.root, "docs"),
    filesUnder(input.root, "resources/skills"),
    filesUnder(input.root, "resources/templates"),
  ])).flat());
  return files.flatMap(({ filename, content }) => inspect(filename, content));
}
