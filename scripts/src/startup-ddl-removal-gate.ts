/**
 * Static release gate for the proposed post-migration API entrypoint.
 *
 * This is deliberately separate from the historical eight-owner inventory:
 * that inventory proves what the old entrypoint does, whereas this gate proves
 * that a candidate entrypoint no longer reaches those owners or any other
 * executable startup DDL.  It is source-only and never opens a database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  checkProductionStartupDdlInventory,
  EXPECTED_STARTUP_DDL_ROOTS,
  type StartupDdlInventoryReport,
} from "./production-startup-ddl-inventory";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface StartupDdlRemovalGateOptions {
  readonly repositoryRoot?: string;
  readonly rootFile?: string;
  readonly moduleSources?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  readonly readinessGuardNames?: readonly string[];
  readonly readinessGuardModules?: readonly string[];
}

export type StartupDdlRemovalGateViolationReason =
  | "startup-ddl-owner-reachable"
  | "startup-ddl-import"
  | "inventory-violation"
  | "missing-readiness-guard"
  | "missing-readiness-guard-import"
  | "readiness-guard-too-late"
  | "unsafe-top-level-evaluation";

export interface StartupDdlRemovalGateViolation {
  readonly reason: StartupDdlRemovalGateViolationReason;
  readonly detail: string;
  readonly path: readonly string[];
}

export interface StartupDdlRemovalGateReport {
  readonly pass: boolean;
  readonly startupRoot: string;
  readonly readinessGuard: string | undefined;
  readonly scannedModules: number;
  readonly violations: readonly StartupDdlRemovalGateViolation[];
  readonly inventory: StartupDdlInventoryReport;
}

function sourceFor(
  root: string,
  repositoryRoot: string,
  moduleSources: StartupDdlRemovalGateOptions["moduleSources"],
): string {
  if (moduleSources instanceof Map) {
    const value = moduleSources.get(root) ?? moduleSources.get(path.posix.normalize(root));
    if (value !== undefined) return value;
  } else if (moduleSources && root in moduleSources) {
    return (moduleSources as Readonly<Record<string, string>>)[root]!;
  }
  return readFileSync(path.resolve(repositoryRoot, root), "utf8");
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
}

function callName(expression: ts.Expression): string | undefined {
  const target = unwrap(expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) return target.name.text;
  return undefined;
}

function callFromStatement(statement: ts.Statement): ts.CallExpression | undefined {
  let expression: ts.Expression;
  if (ts.isExpressionStatement(statement)) {
    expression = statement.expression;
  } else if (
    ts.isVariableStatement(statement)
    && statement.declarationList.declarations.length === 1
    && statement.declarationList.declarations[0]!.initializer
  ) {
    // `const admission = await guard(pool);` binds the guard's result.
    expression = statement.declarationList.declarations[0]!.initializer;
  } else {
    return undefined;
  }
  if (ts.isAwaitExpression(expression)) expression = expression.expression;
  if (!ts.isCallExpression(expression)) return undefined;
  return expression;
}

function importedStartupNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (EXPECTED_STARTUP_DDL_ROOTS.includes(imported)) names.add(element.name.text);
      }
    }
  }
  return names;
}

function importedReadinessNames(
  sourceFile: ts.SourceFile,
  readinessNames: readonly string[],
  readinessModules: readonly string[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !readinessModules.includes(statement.moduleSpecifier.text)
      || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (readinessNames.includes(imported)) names.set(element.name.text, imported);
    }
  }
  return names;
}

function directRootStartupCalls(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    const call = callFromStatement(statement);
    if (!call) continue;
    const name = callName(call.expression);
    if (name && EXPECTED_STARTUP_DDL_ROOTS.includes(name)) names.push(name);
    if (ts.isPropertyAccessExpression(unwrap(call.expression))) {
      const property = unwrap(call.expression);
      if (ts.isPropertyAccessExpression(property)
        && EXPECTED_STARTUP_DDL_ROOTS.includes(property.name.text)) names.push(property.name.text);
    }
  }
  return names;
}

function topLevelUnsafeEvaluation(sourceFile: ts.SourceFile): string[] {
  const unsafe: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name === "eval" || name === "Function" || name === "require") unsafe.push(name);
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression
        && node.expression.getChildAt(1).kind === ts.SyntaxKind.QuestionDotToken) {
        unsafe.push("optional-call");
      }
      if (ts.isElementAccessExpression(node.expression)) unsafe.push("computed-call");
    }
    if (ts.isNewExpression(node) && callName(node.expression) === "Function") unsafe.push("new Function");
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) visit(statement);
  return unsafe;
}

function statementContainsListen(statement: ts.Statement): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (ts.isFunctionLike(node) && node !== statement)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "listen") found = true;
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
}

/**
 * Produce the source overlay used by candidate tests. It removes only AST
 * statements that directly invoke one of the eight legacy owners; it never
 * removes arbitrary text or SQL. A readiness guard is intentionally supplied
 * by the candidate test/application because its import path is deployment
 * specific.
 */
export function removeStartupDdlStatements(source: string, fileName = "index.ts"): string {
  const sourceFile = parse(source, fileName);
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => (node) => {
    const statements = node.statements.filter((statement) => {
      if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings
        && ts.isNamedImports(statement.importClause.namedBindings)) {
        const allLegacy = statement.importClause.namedBindings.elements.length > 0
          && statement.importClause.namedBindings.elements.every((element) =>
            EXPECTED_STARTUP_DDL_ROOTS.includes(element.propertyName?.text ?? element.name.text));
        if (allLegacy) return false;
      }
      const call = callFromStatement(statement);
      if (!call) return true;
      const target = unwrap(call.expression);
      return !(ts.isIdentifier(target) && EXPECTED_STARTUP_DDL_ROOTS.includes(target.text))
        && !(ts.isPropertyAccessExpression(target) && EXPECTED_STARTUP_DDL_ROOTS.includes(target.name.text));
    });
    return context.factory.updateSourceFile(node, statements);
  };
  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed.transformed[0]!);
  } finally {
    transformed.dispose();
  }
}

export function checkStartupDdlRemovalGate(
  options: StartupDdlRemovalGateOptions = {},
): StartupDdlRemovalGateReport {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const rootFile = options.rootFile ?? "artifacts/api-server/src/index.ts";
  const rootSource = sourceFor(rootFile, repositoryRoot, options.moduleSources);
  const sourceFile = parse(rootSource, rootFile);
  const readinessNames = options.readinessGuardNames ?? ["assertDatabaseMigrationReady", "admitDatabaseMigrationStartup"];
  const readinessModules = options.readinessGuardModules ?? ["@workspace/db/migration-runtime"];
  const importedNames = importedStartupNames(sourceFile);
  const importedReadiness = importedReadinessNames(sourceFile, readinessNames, readinessModules);
  const directCalls = directRootStartupCalls(sourceFile);
  const violations: StartupDdlRemovalGateViolation[] = [];
  for (const name of importedNames) {
    violations.push({ reason: "startup-ddl-import", detail: `legacy startup owner binding ${name}`, path: [rootFile, name] });
  }
  for (const name of directCalls) {
    violations.push({ reason: "startup-ddl-owner-reachable", detail: `direct top-level call ${name}`, path: [rootFile, name] });
  }
  for (const name of topLevelUnsafeEvaluation(sourceFile)) {
    violations.push({ reason: "unsafe-top-level-evaluation", detail: `top-level ${name} is not statically bounded`, path: [rootFile, name] });
  }

  const inventory = checkProductionStartupDdlInventory({
    repositoryRoot,
    rootFile,
    moduleSources: options.moduleSources,
  });
  for (const violation of inventory.violations) {
    if (violation.reason === "missing-startup-ddl-root") continue;
    violations.push({
      reason: "inventory-violation",
      detail: `${violation.reason}: ${violation.detail}`,
      path: violation.path,
    });
  }
  if (inventory.owners.length > 0) {
    for (const owner of inventory.owners) {
      violations.push({
        reason: "startup-ddl-owner-reachable",
        detail: `reachable startup owner ${owner.ensureName}`,
        path: owner.path ?? [rootFile, owner.ensureName],
      });
    }
  }

  let readinessGuard: string | undefined;
  let guardIndex = -1;
  let importedReadinessGuard = false;
  let listenIndex = Number.POSITIVE_INFINITY;
  sourceFile.statements.forEach((statement, index) => {
    if (statementContainsListen(statement)) listenIndex = Math.min(listenIndex, index);
    const call = callFromStatement(statement);
    if (!call) return;
    const name = callName(call.expression);
    const importedName = name ? importedReadiness.get(name) : undefined;
    const matchesReadinessName = !!name && readinessNames.includes(name);
    if (name && (matchesReadinessName || importedName !== undefined)) {
      readinessGuard = importedName ?? name;
      importedReadinessGuard ||= importedName !== undefined;
      guardIndex = index;
    }
  });
  if (guardIndex < 0) {
    violations.push({ reason: "missing-readiness-guard", detail: `expected one of ${readinessNames.join(", ")}`, path: [rootFile] });
  } else if (!importedReadinessGuard) {
    violations.push({
      reason: "missing-readiness-guard-import",
      detail: `readiness guard must be imported from one of ${readinessModules.join(", ")}`,
      path: [rootFile, readinessGuard!],
    });
  } else if (guardIndex > listenIndex) {
    violations.push({ reason: "readiness-guard-too-late", detail: "readiness guard must run before app.listen", path: [rootFile] });
  }

  return {
    pass: violations.length === 0,
    startupRoot: rootFile,
    readinessGuard,
    scannedModules: inventory.scannedModules,
    violations,
    inventory,
  };
}

export function assertStartupDdlRemovalGate(
  options: StartupDdlRemovalGateOptions = {},
): StartupDdlRemovalGateReport {
  const report = checkStartupDdlRemovalGate(options);
  if (!report.pass) {
    throw new Error(`Startup DDL removal gate failed:\n${report.violations.map((item) =>
      `- ${item.reason}: ${item.detail}`).join("\n")}`);
  }
  return report;
}

export function formatStartupDdlRemovalGateReport(
  report: StartupDdlRemovalGateReport,
): string {
  const status = report.pass ? "PASS" : "FAIL";
  const lines = [
    `${status} startup DDL removal gate (${report.startupRoot}; ${report.scannedModules} modules scanned)`,
  ];
  for (const violation of report.violations) {
    lines.push(`- ${violation.reason}: ${violation.detail}`);
  }
  return lines.join("\n");
}

export function main(argumentsToParse = process.argv.slice(2)): number {
  if (argumentsToParse.length > 0) {
    process.stderr.write(
      "Startup DDL removal gate accepts no arguments; it checks the production API entrypoint.\n",
    );
    return 1;
  }
  try {
    const report = checkStartupDdlRemovalGate();
    const output = `${formatStartupDdlRemovalGateReport(report)}\n`;
    (report.pass ? process.stdout : process.stderr).write(output);
    return report.pass ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `Startup DDL removal gate failed to run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}