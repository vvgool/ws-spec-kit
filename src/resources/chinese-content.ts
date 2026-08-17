import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface ChineseContentFinding { filename: string; line: number; text: string }
export interface ChineseContentInput { files?: Array<{ filename: string; content: string }>; root?: string; includeBuild?: boolean }

const allowedEnglish = new Set([
  "WSSpecKit", "WSSpec", "WSSpecKit Driver", "WiesenSpecKit", "WiesenSpecKit M1", "Workflow", "Workflow Package", "Workflow Package Manifest", "Workflow Lock", "WorkflowPackage", "Profile", "Skill", "Package Skill", "Skill Lock", "Skill URI", "Skill Resolver home", "Driver", "Generic Driver", "CLI", "JSON", "Git", "Git diff", "Git common-dir", "Markdown", "TXT", "TTY", "Codex", "Claude", "Cursor", "Generic", "URI", "URL", "API", "Agent", "Application", "Application Snapshot", "Application locator", "Work Item", "Work Item ID", "Work Item manifest", "Work Item locator", "Work Item v", "Step", "Step outputs", "Stage", "Artifact", "Requirement Source Artifact", "Gate", "required Gate", "Prompt", "Builtin", "Builtin Workflow Package", "Claim", "Lease", "Attempt", "Attempt Lease", "Lock", "Project Config", "Public Schema", "Provider", "SKILL.md", "dry-run", "Red", "Green", "Review Finding", "inspect -", "acquire -", "Skill -", "submit -", "Start", "worktree root", "WSSPEC", "WiesenSpecKit M", "M",
]);

function proseFragments(line: string): string[] {
  const withoutCode = line.replace(/`[^`]*`/gu, "").replace(/https?:\/\/\S+/gu, "").replace(/(?:^|\s)(?:[./~][\w./-]*|[\w.-]+\/[\w./-]+)(?=\s|$)/gu, " ");
  return withoutCode.match(/[A-Za-z][A-Za-z .,'"()/-]*/gu) ?? [];
}

function isAllowed(fragment: string): boolean {
  const normalized = fragment.trim().replace(/[.,;:!?()"']/gu, "").replace(/\s+/gu, " ");
  return normalized === "" || allowedEnglish.has(normalized) || /^WSSPEC(?:_[A-Z_]+)?$/.test(normalized) || /^wspec(?:\s|$)/.test(normalized) || /^[a-z][A-Za-z0-9.-]*$/.test(normalized);
}

function inspect(filename: string, content: string): ChineseContentFinding[] {
  const findings: ChineseContentFinding[] = [];
  let fenced = false;
  let frontMatter = content.startsWith("---\n") || content.startsWith("---\r\n");
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (frontMatter) { if (index > 0 && line.trim() === "---") frontMatter = false; continue; }
    if (line.trimStart().startsWith("```")) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const text of proseFragments(line)) if (!isAllowed(text)) findings.push({ filename, line: index + 1, text: text.trim() });
  }
  return findings;
}

function sourceUserText(filename: string, content: string): ChineseContentFinding[] {
  const findings: ChineseContentFinding[] = [];
  const lines = content.split(/\r?\n/u);
  const driverStart = /(?:src|dist)\/adapters\/skills\/install\.(?:ts|js)$/u.test(filename) ? lines.findIndex((line) => line.startsWith("function body(")) : -1;
  const driverEnd = driverStart < 0 ? -1 : lines.findIndex((line, index) => index > driverStart && line.startsWith("function skill("));
  const cliHelp = /(?:src|dist)\/cli\/main\.(?:ts|js)$/u.test(filename);
  for (const [index, line] of lines.entries()) {
    const driverBody = driverStart >= 0 && index > driverStart && (driverEnd < 0 || index < driverEnd);
    if (!driverBody && !cliHelp && !/(?:new\s+\w*Error\(|\b(?:message|title)\s*:\s*["`])/u.test(line)) continue;
    for (const match of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/gu)) {
      const text = match[2]!
        .replace(/\\(["'`\\])/gu, "$1")
        .replace(/\$\{[^}]*\}/gu, "");
      if (/^WSSPEC_[A-Z_]+$/u.test(text)) continue;
      for (const fragment of proseFragments(text)) if (!isAllowed(fragment)) findings.push({ filename, line: index + 1, text: fragment.trim() });
    }
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
      else if (entry.isFile() && !entry.name.endsWith(".map")) files.push({ filename: relative.split(path.sep).join("/"), content: await readFile(path.join(root, relative), "utf8") });
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function validateChineseContent(input: ChineseContentInput): Promise<ChineseContentFinding[]> {
  const files = input.files ?? (input.root === undefined ? [] : (await Promise.all([
    filesUnder(input.root, "docs/user-facing"),
    filesUnder(input.root, "resources/skills"),
    filesUnder(input.root, "resources/templates"),
    filesUnder(input.root, "src/cli"),
    filesUnder(input.root, "src/adapters/cli"),
    filesUnder(input.root, "src/adapters/skills"),
    filesUnder(input.root, "src/application"),
    filesUnder(input.root, "src/registry/skills"),
    filesUnder(input.root, "src/workflow-package"),
    filesUnder(input.root, "src/storage"),
    ...(input.includeBuild === true ? [
      filesUnder(input.root, "dist/cli"),
      filesUnder(input.root, "dist/adapters/cli"),
      filesUnder(input.root, "dist/adapters/skills"),
      filesUnder(input.root, "dist/application"),
      filesUnder(input.root, "dist/registry/skills"),
      filesUnder(input.root, "dist/workflow-package"),
      filesUnder(input.root, "dist/storage"),
    ] : []),
  ])).flat());
  return files.flatMap(({ filename, content }) => /\.(?:ts|js)$/u.test(filename) ? sourceUserText(filename, content) : inspect(filename, content));
}
