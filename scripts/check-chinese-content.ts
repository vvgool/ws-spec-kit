import { validateChineseContent } from "../src/resources/chinese-content.js";

const findings = await validateChineseContent({ root: process.cwd(), includeBuild: process.argv.includes("--build") });
if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${finding.filename}:${finding.line}: ${finding.text}\n`);
  process.exitCode = 1;
}
