import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  REPOSITORY_BASELINE_MANIFEST_URL,
  validateEligibilityCliArguments,
} from "./eligibility-cli";

test("eligibility CLI accepts no operator-controlled arguments", () => {
  assert.doesNotThrow(() => validateEligibilityCliArguments([]));
  for (const argument of [
    "--adopt-known-legacy=legacy-v1",
    "--adoption-actor=operator",
    "--eligibility-manifest=/tmp/operator.json",
    "--unknown",
  ]) {
    assert.throws(
      () => validateEligibilityCliArguments([argument]),
      /Unknown eligibility argument/,
    );
  }
});

test("eligibility CLI authority is the fixed repository manifest", async () => {
  const manifest = JSON.parse(
    await readFile(REPOSITORY_BASELINE_MANIFEST_URL, "utf8"),
  ) as { formatVersion: number; expected: unknown[] };
  assert.deepEqual(manifest, { formatVersion: 1, expected: [] });
});

const runtimeAllowlist = new Set([
  "eligibility-cli.ts",
  "catalog.ts",
  "eligibility.ts",
  "fingerprint.ts",
  "fingerprint-transaction.ts",
  "ownership.ts",
  "read-only-query.ts",
  "compare.ts",
  "model.ts",
]);

const forbiddenRuntimeCapability =
  /\b(?:BEGIN\s+READ\s+WRITE|CREATE\s+(?:SCHEMA|TABLE)|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|LOCK\s+TABLE|ACCESS\s+EXCLUSIVE|pg_advisory_lock|adoptKnownLegacy|baseline_adoptions)\b/i;
const runtimePackageSpecifier = "@workspace/db/destructive-test-runtime";
const sharedMigrationRuntimeSpecifier = "@workspace/db/migration-runtime";
const sharedMigrationRuntimeFiles = [
  "index.ts",
  "read-only-query.ts",
  "fingerprint-transaction.ts",
  "readiness.ts",
  "namespaces.ts",
  "model.ts",
  "catalog.ts",
  "fingerprint.ts",
  "ownership.ts",
  "ledger-identity.ts",
  "startup-admission.ts",
].map((file) => `lib/db/src/migration-runtime/${file}`);

type PackageManifest = {
  exports?: unknown;
};

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function splitPackageSpecifier(specifier: string): {
  packageName: string;
  exportName: string;
} {
  const segments = specifier.split("/");
  const packageSegmentCount = specifier.startsWith("@") ? 2 : 1;
  const packageName = segments.slice(0, packageSegmentCount).join("/");
  return {
    packageName,
    exportName: `./${segments.slice(packageSegmentCount).join("/")}`,
  };
}

async function resolveExactPackageExport(
  specifier: string,
  importerPath: string,
  load: (path: string) => Promise<string>,
): Promise<string> {
  const { packageName, exportName } = splitPackageSpecifier(specifier);
  let directory = dirname(importerPath);
  let packageRoot: string | undefined;
  let manifest: PackageManifest | undefined;

  while (true) {
    const candidate = resolve(directory, "node_modules", packageName);
    const manifestPath = resolve(candidate, "package.json");
    try {
      manifest = JSON.parse(await load(manifestPath)) as PackageManifest;
      packageRoot = candidate;
      break;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  assert.ok(packageRoot, `package manifest not found: ${packageName}`);
  assert.ok(manifest, `package manifest not found: ${packageName}`);

  const packageExports = manifest.exports;
  assert.ok(
    packageExports
      && typeof packageExports === "object"
      && !Array.isArray(packageExports),
    `package exports must be an object: ${packageName}`,
  );
  const exportTarget = (packageExports as Record<string, unknown>)[exportName];
  assert.equal(
    typeof exportTarget,
    "string",
    `package export is not an exact string: ${specifier}`,
  );
  if (typeof exportTarget !== "string") {
    throw new Error(`package export is not an exact string: ${specifier}`);
  }
  assert.equal(
    exportTarget.startsWith("./"),
    true,
    `package export must stay within its package: ${specifier}`,
  );

  try {
    packageRoot = await realpath(packageRoot);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const target = resolve(packageRoot, exportTarget);
  const packageRelativeTarget = relative(packageRoot, target);
  assert.equal(
    isAbsolute(packageRelativeTarget) || packageRelativeTarget.startsWith(".."),
    false,
    `package export escapes its package: ${specifier}`,
  );
  return target;
}

function runtimeModuleSpecifiers(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const add = (value: ts.Expression | undefined): void => {
    if (value && ts.isStringLiteralLike(value)) specifiers.push(value.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const allNamedImportsAreTypeOnly = clause?.namedBindings
        && !clause.name
        && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((element) => element.isTypeOnly);
      if (!clause?.isTypeOnly && !allNamedImportsAreTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

async function auditRuntimeGraph(
  entry: string,
  allowedFiles: ReadonlySet<string>,
  load: (path: string) => Promise<string>,
): Promise<Set<string>> {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    assert.equal(allowedFiles.has(path), true, `unreviewed runtime dependency: ${path}`);
    const source = await load(path);
    assert.equal(
      forbiddenRuntimeCapability.test(source),
      false,
      `write-capable runtime dependency: ${path}`,
    );
    for (const specifier of runtimeModuleSpecifiers(source, path)) {
      if (specifier.startsWith("node:") || specifier === "pg") continue;
       if (specifier === runtimePackageSpecifier || specifier === sharedMigrationRuntimeSpecifier) {
        pending.push(await resolveExactPackageExport(specifier, path, load));
        continue;
      }
      assert.equal(specifier.startsWith("."), true, `unreviewed package import: ${specifier}`);
      pending.push(resolve(dirname(path), `${specifier}.ts`));
    }
  }
  return visited;
}

test("eligibility CLI runtime dependency graph is explicitly read-only", async () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = resolve(root, "../../..");
  const allowed = new Set([
    ...[...runtimeAllowlist].map((file) => resolve(root, file)),
    resolve(workspaceRoot, "lib/db/src/destructive-test-runtime.ts"),
    ...sharedMigrationRuntimeFiles.map((file) => resolve(workspaceRoot, file)),
  ]);
  const visited = await auditRuntimeGraph(
    resolve(root, "eligibility-cli.ts"),
    allowed,
    (path) => readFile(path, "utf8"),
  );
  assert.deepEqual(visited, allowed);
});

test("runtime dependency audit rejects writes introduced into the resolved package export", async () => {
  const sources = new Map([
    ["/virtual/entry.ts", `import "${runtimePackageSpecifier}";`],
    [
      "/virtual/node_modules/@workspace/db/package.json",
      JSON.stringify({
        exports: {
          "./destructive-test-runtime": "./src/destructive-test-runtime.ts",
        },
      }),
    ],
    [
      "/virtual/node_modules/@workspace/db/src/destructive-test-runtime.ts",
      'export const sql = "INSERT INTO baseline_adoptions VALUES (1)";',
    ],
  ]);
  await assert.rejects(
    () => auditRuntimeGraph(
      "/virtual/entry.ts",
      new Set(sources.keys()),
      async (path) => {
        const source = sources.get(path);
        if (source === undefined) {
          const error = new Error(`missing fixture: ${path}`) as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return source;
      },
    ),
    /write-capable runtime dependency: \/virtual\/node_modules\/@workspace\/db\/src\/destructive-test-runtime\.ts/,
  );
});

test("runtime dependency audit still rejects unrecognized package imports", async () => {
  const sources = new Map([
    ["/virtual/entry.ts", 'import "@workspace/unrecognized";'],
  ]);
  await assert.rejects(
    () => auditRuntimeGraph(
      "/virtual/entry.ts",
      new Set(sources.keys()),
      async (path) => sources.get(path)!,
    ),
    /unreviewed package import: @workspace\/unrecognized/,
  );
});

test("runtime dependency audit rejects an indirect write path without executing it", async () => {
  const sources = new Map([
    ["/virtual/entry.ts", 'import "./reader";'],
    ["/virtual/reader.ts", 'export * from "./writer";'],
    ["/virtual/writer.ts", 'export const sql = "INSERT INTO baseline_adoptions VALUES (1)";'],
  ]);
  await assert.rejects(
    () => auditRuntimeGraph(
      "/virtual/entry.ts",
      new Set(sources.keys()),
      async (path) => sources.get(path)!,
    ),
    /write-capable runtime dependency: \/virtual\/writer\.ts/,
  );
});