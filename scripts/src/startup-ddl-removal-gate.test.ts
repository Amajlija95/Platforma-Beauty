import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertDestructiveTestRuntimeAllowed } from "@workspace/db/destructive-test-runtime";
import {
  checkStartupDdlRemovalGate,
  removeStartupDdlStatements,
} from "./startup-ddl-removal-gate";
import { loadRepositoryCrosswalk } from "./startup-migration-crosswalk";

assertDestructiveTestRuntimeAllowed(process.env, "Startup DDL removal gate tests");
const rootPath = "artifacts/api-server/src/index.ts";
const realRoot = readFileSync(new URL("../../artifacts/api-server/src/index.ts", import.meta.url), "utf8");

function candidateRoot(): string {
  return removeStartupDdlStatements(realRoot, rootPath);
}

function candidateSources(extra: Record<string, string> = {}): Record<string, string> {
  const sources: Record<string, string> = {};
  const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(filename);
      else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(entry.name)) {
        const relative = path.relative(workspaceRoot, filename).replaceAll(path.sep, "/");
        const absolute = path.resolve(filename);
        const contents = readFileSync(filename, "utf8");
        sources[relative] = contents;
        // The inventory resolver uses absolute package export targets when an
        // overlay is present. Keep both spellings so a full repository
        // candidate remains a faithful source overlay.
        sources[absolute] = contents;
      }
    }
  };
  collect(path.join(workspaceRoot, "artifacts"));
  collect(path.join(workspaceRoot, "lib"));
  return {
    ...sources,
      [rootPath]: candidateRoot(),
    ...extra,
  };
}

test("the real entrypoint passes after removing all eight startup owners", () => {
  const report = checkStartupDdlRemovalGate({ rootFile: rootPath });
  assert.equal(report.pass, true, report.violations.map((item) => item.detail).join("\n"));
  assert.equal(report.readinessGuard, "admitDatabaseMigrationStartup");
  assert.equal(report.inventory.owners.length, 0);
});

test("authenticated historical evidence never hides newly injected current startup DDL", () => {
  const { crosswalk } = loadRepositoryCrosswalk();
  assert.equal(crosswalk.inventory.recordCount, 1459);
  const sources = candidateSources();
  sources[rootPath] = `${sources[rootPath]}\nawait pool.query("CREATE TABLE phase_c_current_injection (id integer)");`;
  const report = checkStartupDdlRemovalGate({ rootFile: rootPath, moduleSources: sources });
  assert.equal(report.pass, false);
  assert.ok(report.violations.some((item) =>
    item.reason === "inventory-violation" || item.reason === "unsafe-top-level-evaluation"),
  JSON.stringify(report.violations));
  assert.equal(checkStartupDdlRemovalGate({ rootFile: rootPath }).pass, true);
});

test("an AST candidate with a read-only guard passes the removal gate", () => {
  const report = checkStartupDdlRemovalGate({
    rootFile: rootPath,
    moduleSources: candidateSources(),
  });
  assert.equal(report.pass, true, report.violations.map((item) => item.detail).join("\n"));
  assert.equal(report.readinessGuard, "admitDatabaseMigrationStartup");
  assert.equal(report.inventory.owners.length, 0);
});

test("a transitive owner wrapper remains blocked even when its name is hidden", () => {
  const source = candidateSources({
    "artifacts/api-server/src/legacy-wrapper.ts": `
      import { ensureMediaSchema as boot } from "./lib/media-schema";
      export async function run() { await boot(); }
    `,
  });
  source[rootPath] = `${source[rootPath]}\nimport { run } from "./legacy-wrapper";\nawait run();`;
  const report = checkStartupDdlRemovalGate({ rootFile: rootPath, moduleSources: source });
  assert.equal(report.pass, false, JSON.stringify(report.violations));
  assert.ok(report.violations.some((item) =>
    item.reason === "inventory-violation" || item.reason === "startup-ddl-owner-reachable"));
});

test("raw reachable DDL, unresolved dynamic SQL, and computed evaluation fail", () => {
  const source = candidateSources({
  });
  source[rootPath] = `${source[rootPath]}
    const sql = "CREATE TABLE bypass_gate (id uuid)";
    await client[methodName](sql);`;
  const report = checkStartupDdlRemovalGate({ rootFile: rootPath, moduleSources: source });
  assert.equal(report.pass, false);
  assert.ok(report.violations.some((item) =>
    item.reason === "inventory-violation" || item.reason === "unsafe-top-level-evaluation"));

  const evalSource = candidateSources();
  evalSource[rootPath] = `${evalSource[rootPath]}\nconst loader = eval("() => 1");`;
  const evalReport = checkStartupDdlRemovalGate({ rootFile: rootPath, moduleSources: evalSource });
  assert.equal(evalReport.pass, false);
  assert.ok(evalReport.violations.some((item) => item.reason === "unsafe-top-level-evaluation"));
});

test("a readiness guard after listen is rejected", () => {
  const source = candidateSources();
  const guardLine = "const startupAdmission = await admitDatabaseMigrationStartup(pool);\n";
  assert.ok(source[rootPath]!.includes(guardLine));
  source[rootPath] = source[rootPath]!.replace(guardLine, "")
    .concat("\nconst startupAdmission = await admitDatabaseMigrationStartup(pool);\n");
  const report = checkStartupDdlRemovalGate({ rootFile: rootPath, moduleSources: source });
  assert.equal(report.pass, false);
  assert.ok(report.violations.some((item) => item.reason === "readiness-guard-too-late"));
});

test("a same-named local readiness helper cannot satisfy the pinned guard import", () => {
  const source = candidateSources({
    "artifacts/api-server/src/local-readiness.ts": `
      export async function admitDatabaseMigrationStartup() {
        await client.query("SELECT 1");
        return { mode: "normal", unusedOverride: null };
      }
      export const STARTUP_READINESS_OVERRIDE_VARIABLE = "LUMERA_STARTUP_READINESS_OVERRIDE";
    `,
  });
  source[rootPath] = source[rootPath]!
    .replace(
      /import \{\s*admitDatabaseMigrationStartup,\s*STARTUP_READINESS_OVERRIDE_VARIABLE,\s*\} from "@workspace\/db\/migration-runtime";/u,
      'import { admitDatabaseMigrationStartup, STARTUP_READINESS_OVERRIDE_VARIABLE } from "./local-readiness";',
    );
  assert.match(source[rootPath]!, /from "\.\/local-readiness";/u);
  assert.doesNotMatch(source[rootPath]!, /@workspace\/db\/migration-runtime/u);
  const report = checkStartupDdlRemovalGate({ rootFile: rootPath, moduleSources: source });
  assert.equal(report.readinessGuard, "admitDatabaseMigrationStartup");
  assert.equal(report.pass, false, JSON.stringify(report.violations));
  assert.ok(report.violations.some((item) => item.reason === "missing-readiness-guard-import"));
});
test("binding the admission guard without calling it does not satisfy the gate", () => {
  const source = candidateSources();
  const guardLine = "const startupAdmission = await admitDatabaseMigrationStartup(pool);\n";
  source[rootPath] = source[rootPath]!.replace(guardLine, "const startupAdmission = admitDatabaseMigrationStartup;\n");
  const report = checkStartupDdlRemovalGate({ rootFile: rootPath, moduleSources: source });
  assert.equal(report.pass, false);
  assert.ok(report.violations.some((item) => item.reason === "missing-readiness-guard"), JSON.stringify(report.violations));
});
