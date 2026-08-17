import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

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
  return findings.sort((left, right) => left.filename.localeCompare(right.filename) || left.line - right.line);
}

function literalText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return `${node.head.text}${node.templateSpans.map((span) => span.literal.text).join("")}`;
  return undefined;
}

const publicTextFields = new Set(["description", "message", "summary", "title"]);

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

interface ResolvedText {
  literals: Set<ts.Expression>;
  unresolved: boolean;
}

type TextEnvironment = Map<ts.Symbol, ResolvedText>;

function emptyText(unresolved = false): ResolvedText {
  return { literals: new Set(), unresolved };
}

function cloneText(value: ResolvedText): ResolvedText {
  return { literals: new Set(value.literals), unresolved: value.unresolved };
}

function cloneEnvironment(environment: TextEnvironment): TextEnvironment {
  return new Map([...environment].map(([symbol, value]) => [symbol, cloneText(value)]));
}

function mergeText(values: ResolvedText[]): ResolvedText {
  return {
    literals: new Set(values.flatMap((value) => [...value.literals])),
    unresolved: values.some((value) => value.unresolved),
  };
}

function mergeEnvironments(environments: TextEnvironment[]): TextEnvironment {
  const symbols = new Set(environments.flatMap((environment) => [...environment.keys()]));
  return new Map([...symbols].map((symbol) => [
    symbol,
    mergeText(environments.map((environment) => environment.get(symbol) ?? emptyText(true))),
  ]));
}

function replaceEnvironment(target: TextEnvironment, source: TextEnvironment): void {
  target.clear();
  for (const [symbol, value] of source) target.set(symbol, cloneText(value));
}

function sameEnvironment(left: TextEnvironment, right: TextEnvironment): boolean {
  if (left.size !== right.size) return false;
  for (const [symbol, leftValue] of left) {
    const rightValue = right.get(symbol);
    if (rightValue === undefined || leftValue.unresolved !== rightValue.unresolved || leftValue.literals.size !== rightValue.literals.size) return false;
    for (const literal of leftValue.literals) if (!rightValue.literals.has(literal)) return false;
  }
  return true;
}

function sourceProgram(filename: string, content: string): { source: ts.SourceFile; checker: ts.TypeChecker } {
  const scriptKind = filename.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, scriptKind);
  const options: ts.CompilerOptions = { allowJs: true, checkJs: false, noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === filename,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (candidate) => candidate === filename ? source : undefined,
    readFile: (candidate) => candidate === filename ? content : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  return { source, checker };
}

function sourceUserText(filename: string, content: string): ChineseContentFinding[] {
  const findings: ChineseContentFinding[] = [];
  const { source, checker } = sourceProgram(filename, content);
  const candidates = new Set<ts.Expression>();
  const unresolved = new Set<ts.Expression>();
  const driverFile = /(?:src|dist)\/adapters\/skills\/install\.(?:ts|js)$/u.test(filename);
  const cliHelp = /(?:src|dist)\/cli\/main\.(?:ts|js)$/u.test(filename);

  const symbolFor = (identifier: ts.Identifier): ts.Symbol | undefined => {
    if (ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier) {
      return checker.getShorthandAssignmentValueSymbol(identifier.parent) ?? checker.getSymbolAtLocation(identifier);
    }
    return checker.getSymbolAtLocation(identifier);
  };
  const resolve = (node: ts.Expression, environment: TextEnvironment): ResolvedText => {
    if (literalText(node) !== undefined) return { literals: new Set([node]), unresolved: false };
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return emptyText(false);
      const symbol = symbolFor(node);
      return symbol === undefined ? emptyText(true) : cloneText(environment.get(symbol) ?? emptyText(true));
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
      return resolve(node.expression, environment);
    }
    if (ts.isConditionalExpression(node)) return mergeText([resolve(node.whenTrue, environment), resolve(node.whenFalse, environment)]);
    return emptyText(false);
  };

  const add = (node: ts.Expression, environment: TextEnvironment): void => {
    const value = resolve(node, environment);
    for (const literal of value.literals) candidates.add(literal);
    if (value.unresolved) unresolved.add(node);
  };
  const addStringsBelow = (node: ts.Node): void => {
    if (ts.isExpression(node) && literalText(node) !== undefined) candidates.add(node);
    ts.forEachChild(node, addStringsBelow);
  };

  const bind = (name: ts.BindingName, value: ResolvedText, environment: TextEnvironment): void => {
    if (ts.isIdentifier(name)) {
      const symbol = symbolFor(name);
      if (symbol !== undefined) environment.set(symbol, cloneText(value));
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      bind(element.name, emptyText(false), environment);
    }
  };

  let analyzeStatement: (node: ts.Statement, environment: TextEnvironment) => void;
  let analyzeExpression: (node: ts.Expression, environment: TextEnvironment) => void;

  const analyzeFunction = (node: ts.FunctionLikeDeclaration, environment: TextEnvironment): void => {
    const functionEnvironment = cloneEnvironment(environment);
    for (const parameter of node.parameters) {
      if (parameter.initializer !== undefined) analyzeExpression(parameter.initializer, functionEnvironment);
      bind(parameter.name, parameter.initializer === undefined ? emptyText(false) : resolve(parameter.initializer, functionEnvironment), functionEnvironment);
    }
    if (node.body === undefined) return;
    if (ts.isBlock(node.body)) for (const statement of node.body.statements) analyzeStatement(statement, functionEnvironment);
    else analyzeExpression(node.body, functionEnvironment);
  };

  const analyzeLoop = (body: ts.Statement, environment: TextEnvironment, afterBody?: (loopEnvironment: TextEnvironment) => void): void => {
    const entry = cloneEnvironment(environment);
    let loopEnvironment = cloneEnvironment(entry);
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const bodyEnvironment = cloneEnvironment(loopEnvironment);
      analyzeStatement(body, bodyEnvironment);
      afterBody?.(bodyEnvironment);
      const next = mergeEnvironments([entry, bodyEnvironment]);
      if (sameEnvironment(loopEnvironment, next)) {
        replaceEnvironment(environment, next);
        return;
      }
      loopEnvironment = next;
    }
    for (const [symbol, value] of loopEnvironment) loopEnvironment.set(symbol, { literals: value.literals, unresolved: true });
    replaceEnvironment(environment, loopEnvironment);
  };

  analyzeExpression = (node, environment): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      analyzeExpression(node.right, environment);
      if (ts.isIdentifier(node.left)) {
        const symbol = symbolFor(node.left);
        if (symbol !== undefined) environment.set(symbol, resolve(node.right, environment));
      } else {
        analyzeExpression(node.left, environment);
      }
      return;
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      analyzeFunction(node, environment);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyName(property.name);
          if (name !== undefined && publicTextFields.has(name)) add(property.initializer, environment);
          analyzeExpression(property.initializer, environment);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          if (publicTextFields.has(property.name.text)) add(property.name, environment);
        } else if (ts.isSpreadAssignment(property)) {
          analyzeExpression(property.expression, environment);
        } else if (ts.isMethodDeclaration(property)) {
          analyzeFunction(property, environment);
        }
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.getText(source) === "completed" && node.arguments[2] !== undefined) add(node.arguments[2], environment);
      analyzeExpression(node.expression, environment);
      for (const argument of node.arguments) analyzeExpression(argument, environment);
      return;
    }
    if (ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      if (node.expression.getText(source).endsWith("Error")) {
        for (const argument of args) if (literalText(argument) !== undefined) add(argument, environment);
        const message = args.length === 1 ? args[0] : args[1];
        if (message !== undefined && literalText(message) === undefined) add(message, environment);
      }
      analyzeExpression(node.expression, environment);
      for (const argument of args) analyzeExpression(argument, environment);
      return;
    }
    ts.forEachChild(node, (child) => {
      if (ts.isFunctionExpression(child) || ts.isArrowFunction(child)) analyzeFunction(child, environment);
      else if (ts.isExpression(child)) analyzeExpression(child, environment);
    });
  };

  analyzeStatement = (node, environment): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer !== undefined) analyzeExpression(declaration.initializer, environment);
        bind(declaration.name, declaration.initializer === undefined ? emptyText(true) : resolve(declaration.initializer, environment), environment);
        if (cliHelp && declaration.name.getText(source) === "help" && declaration.initializer !== undefined) addStringsBelow(declaration.initializer);
      }
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      if (driverFile && (node.name?.text === "body" || node.name?.text === "skill") && node.body !== undefined) addStringsBelow(node.body);
      analyzeFunction(node, environment);
      return;
    }
    if (ts.isBlock(node)) {
      for (const statement of node.statements) analyzeStatement(statement, environment);
      return;
    }
    if (ts.isExpressionStatement(node)) {
      analyzeExpression(node.expression, environment);
      return;
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      if (node.expression !== undefined) analyzeExpression(node.expression, environment);
      return;
    }
    if (ts.isIfStatement(node)) {
      analyzeExpression(node.expression, environment);
      const thenEnvironment = cloneEnvironment(environment);
      analyzeStatement(node.thenStatement, thenEnvironment);
      const elseEnvironment = cloneEnvironment(environment);
      if (node.elseStatement !== undefined) analyzeStatement(node.elseStatement, elseEnvironment);
      replaceEnvironment(environment, mergeEnvironments([thenEnvironment, elseEnvironment]));
      return;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      analyzeExpression(node.expression, environment);
      analyzeLoop(node.statement, environment);
      return;
    }
    if (ts.isForStatement(node)) {
      if (node.initializer !== undefined) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const declaration of node.initializer.declarations) bind(declaration.name, declaration.initializer === undefined ? emptyText(true) : resolve(declaration.initializer, environment), environment);
        } else analyzeExpression(node.initializer, environment);
      }
      if (node.condition !== undefined) analyzeExpression(node.condition, environment);
      analyzeLoop(node.statement, environment, (loopEnvironment) => { if (node.incrementor !== undefined) analyzeExpression(node.incrementor, loopEnvironment); });
      return;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      analyzeExpression(node.expression, environment);
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) bind(declaration.name, emptyText(false), environment);
      } else if (ts.isIdentifier(node.initializer)) {
        const symbol = symbolFor(node.initializer);
        if (symbol !== undefined) environment.set(symbol, emptyText(false));
      }
      analyzeLoop(node.statement, environment);
      return;
    }
    if (ts.isTryStatement(node)) {
      const branches = [cloneEnvironment(environment)];
      analyzeStatement(node.tryBlock, branches[0]!);
      if (node.catchClause !== undefined) {
        const catchEnvironment = cloneEnvironment(environment);
        if (node.catchClause.variableDeclaration !== undefined) bind(node.catchClause.variableDeclaration.name, emptyText(false), catchEnvironment);
        analyzeStatement(node.catchClause.block, catchEnvironment);
        branches.push(catchEnvironment);
      }
      replaceEnvironment(environment, mergeEnvironments(branches));
      if (node.finallyBlock !== undefined) analyzeStatement(node.finallyBlock, environment);
      return;
    }
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) analyzeFunction(member, environment);
      return;
    }
    ts.forEachChild(node, (child) => {
      if (ts.isStatement(child)) analyzeStatement(child, environment);
      else if (ts.isExpression(child)) analyzeExpression(child, environment);
    });
  };

  const environment: TextEnvironment = new Map();
  for (const statement of source.statements) analyzeStatement(statement, environment);
  for (const candidate of candidates) {
    const text = literalText(candidate)!;
    if (/^WSSPEC_[A-Z_]+$/u.test(text)) continue;
    const line = source.getLineAndCharacterOfPosition(candidate.getStart(source)).line + 1;
    for (const fragment of proseFragments(text)) if (!isAllowed(fragment)) findings.push({ filename, line, text: fragment.trim() });
  }
  for (const expression of unresolved) {
    const line = source.getLineAndCharacterOfPosition(expression.getStart(source)).line + 1;
    findings.push({ filename, line, text: `无法安全解析公开文案：${expression.getText(source)}` });
  }
  return findings.sort((left, right) => left.filename.localeCompare(right.filename) || left.line - right.line);
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
