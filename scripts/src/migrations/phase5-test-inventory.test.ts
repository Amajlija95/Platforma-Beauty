import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import {
  phase5DatabaseFreeTests,
  phase5DisposableIntegrationSuites,
  phase5TestInventory,
} from "./phase5-test-inventory";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) return name.expression.text;
  return undefined;
}

function hasForbiddenTestSkip(source: string): boolean {
  const sourceFile = ts.createSourceFile("required-evidence.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && (
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "skip")
        || (
          ts.isElementAccessExpression(node.expression)
          && ts.isStringLiteral(node.expression.argumentExpression)
          && node.expression.argumentExpression.text === "skip"
        )
      )
    ) {
      found = true;
      return;
    }
    if (
      ts.isObjectLiteralExpression(node)
      && node.properties.some((property) => (
        (ts.isPropertyAssignment(property)
          || ts.isShorthandPropertyAssignment(property)
          || ts.isMethodDeclaration(property)
          || ts.isGetAccessorDeclaration(property)
          || ts.isSetAccessorDeclaration(property))
        && propertyNameText(property.name) === "skip"
      ))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

test("required evidence skip policy rejects every supported Node test skip form", () => {
  for (const source of [
    "test.skip('required', () => {});",
    "test['skip']('required', () => {});",
    "test('required', { skip: true }, () => {});",
    "test('required', { ['skip']: true }, () => {});",
    "const skip = true; test('required', { skip }, () => {});",
  ]) {
    assert.equal(hasForbiddenTestSkip(source), true, source);
  }
  assert.equal(hasForbiddenTestSkip("test('required', () => {});"), false);
});

test("Phase 5 inventory covers the complete seven-commit range and latest boot fixes", async () => {
  assert.equal(phase5TestInventory.length, 29);
  assert.equal(
    phase5TestInventory.filter((entry) => entry.provenance === "343ea5ae").length,
    11,
    "The latest commit's eleven test entrypoints must remain explicitly inventoried.",
  );
  assert.ok(phase5TestInventory.some((entry) =>
    entry.path.endsWith("supported-state.integration.test.ts") && entry.declaredTests === 15));
  assert.ok(phase5TestInventory.some((entry) =>
    entry.path.endsWith("supported-convergence.integration.test.ts") && entry.declaredTests === 4));
  for (const entry of phase5TestInventory) {
    const entryPath = path.join(workspaceRoot, entry.path);
    await access(entryPath);
    if (entry.skipPolicy === "forbidden") {
      assert.equal(
        hasForbiddenTestSkip(await readFile(entryPath, "utf8")),
        false,
        `${entry.path} is required Phase 5 evidence and cannot declare any skip form.`,
      );
    }
  }
});

test("database-free and disposable commands have no orphaned Phase 5 entrypoints", async () => {
  const databaseFree = new Set(phase5DatabaseFreeTests);
  const disposable = new Set<string>(phase5DisposableIntegrationSuites.flatMap((suite) => suite.files));
  for (const entry of phase5TestInventory) {
    if (entry.execution === "database-free") assert.ok(databaseFree.has(entry.path), entry.path);
    if (entry.execution === "disposable-integration") assert.ok(disposable.has(entry.path), entry.path);
  }
  assert.deepEqual(
    phase5DisposableIntegrationSuites.map((suite) => suite.id),
    [
      "phase4-migrations",
      "equivalence-characterization",
      "target-identity",
      "supported-state",
      "supported-convergence",
      "adoption-boundary",
      "namespace-boundary",
      "actual-entrypoint-boot",
      "legacy-boot-refusal",
      "historical-data-regressions",
      "interrupted-recovery",
      "startup-readiness-override",
    ],
  );
});

test("the integration runner and package commands preserve the inventory wiring", async () => {
  const [runner, scriptsPackage, rootPackage] = await Promise.all([
    readFile(new URL("./run-phase5-integration.ts", import.meta.url), "utf8"),
    readFile(path.join(workspaceRoot, "scripts/package.json"), "utf8"),
    readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  ]);
  assert.match(runner, /phase5DisposableIntegrationSuites/u);
  assert.match(scriptsPackage, /"test:migrations:phase5:unit"/u);
  assert.match(scriptsPackage, /"test:migrations:phase5:integration"/u);
  assert.match(rootPackage, /"test:migrations:phase5:unit"/u);
  assert.match(rootPackage, /"test:migrations:phase5:integration"/u);
});