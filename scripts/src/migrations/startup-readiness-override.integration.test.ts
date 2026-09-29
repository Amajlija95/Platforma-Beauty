/**
 * Disposable proof of the deployment-only startup readiness override.
 *
 * Spawns the checked-in API entrypoint with NODE_ENV=production against owned
 * disposable PostgreSQL 16 databases and proves: refusal without, or with a
 * wrong/expired/too-long, override; an exact override boots with no startup
 * DDL, no ledger change, no table writes and no background work, reports the
 * mode on health, and stops itself at expiry; a set but unused override warns.
 *
 * Run through the Phase 5 runner (suite startup-readiness-override), or with:
 * NODE_ENV=test pnpm --filter @workspace/scripts exec tsx \
 *   src/migrations/startup-readiness-override.integration.test.ts \
 *   --admin-url=<explicit-loopback-nondefault-postgres-admin-url> \
 *   --sql-log=<append-only-postgresql-stderr-log> [--evidence-dir=<directory>]
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { assertDestructiveTestRuntimeAllowed } from "@workspace/db/destructive-test-runtime";
import { admitDatabaseMigrationStartup } from "@workspace/db/migration-runtime";
import {
  explicitAdminUrlFromArgs,
  validateDisposableAdminUrl,
  withOwnedDisposableDatabase,
} from "../startup-equivalence/fixtures";
import { applyMigrations } from "./runner";
import { expectedDisposableTarget, registerDisposableTarget } from "./disposable-target-fixture";
import {
  assertNoDdlInBootWindow,
  assertPostgresLogSettings,
  assertProbeLogged,
} from "./postgres-log-evidence";

assertDestructiveTestRuntimeAllowed(process.env, "Startup readiness override integration tests");

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(thisDir, "../../..");
const apiEntrypoint = path.resolve(workspaceRoot, "artifacts/api-server/src/index.ts");
const tsxBin = path.resolve(workspaceRoot, "scripts/node_modules/.bin/tsx");
const backgroundWorkProbe = path.resolve(thisDir, "background-work-probe.mjs");
const sqlLogArgument = process.argv.find((argument) => argument.startsWith("--sql-log="));
assert.ok(sqlLogArgument, "An explicit --sql-log path is required for the readiness override proof.");
const sqlLogPath = path.resolve(workspaceRoot, sqlLogArgument.slice("--sql-log=".length));
const evidenceArgument = process.argv.find((argument) => argument.startsWith("--evidence-dir="));
const evidenceDir = evidenceArgument ? path.resolve(workspaceRoot, evidenceArgument.slice("--evidence-dir=".length)) : undefined;
const adminUrl = explicitAdminUrlFromArgs();
const OVERRIDE = "LUMERA_STARTUP_READINESS_OVERRIDE";
const DRIFT = "MIGRATION_READINESS_CATALOG_DRIFT";
const notOverridable = (reason: string) =>
  `${reason} (STARTUP_READINESS_OVERRIDE_REJECTED:not-overridable; only ${DRIFT} can be overridden)`;
const observations: Array<Record<string, unknown>> = [];

function requireAdminUrl(): string {
  assert.ok(adminUrl, "An explicit --admin-url is required for the readiness override proof.");
  return adminUrl;
}

function utcSeconds(offsetMs: number): string {
  return new Date(Math.ceil((Date.now() + offsetMs) / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  assert.ok(port > 0);
  return port;
}

interface ApiProcess {
  readonly child: ChildProcess;
  readonly port: number;
  output(): string;
  exited(): Promise<number | null>;
}

function startApi(databaseUrl: string, override: string | undefined, probeLog?: string): Promise<ApiProcess> {
  return availablePort().then((port) => {
    const chunks: string[] = [];
    const child = spawn(tsxBin, [apiEntrypoint], {
      cwd: workspaceRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? workspaceRoot,
        // Production is the only runtime in which the override exists.
        NODE_ENV: "production",
        LUMERA_DATABASE_URL: databaseUrl,
        PORT: String(port),
        BASE_PATH: "/api",
        SESSION_SECRET: "lumera-disposable-readiness-override-session-secret",
        AI_INTEGRATIONS_ANTHROPIC_BASE_URL: "http://127.0.0.1:9/disposable-not-used",
        AI_INTEGRATIONS_ANTHROPIC_API_KEY: "disposable-not-used",
        DOTENV_CONFIG_PATH: path.join(workspaceRoot, ".local", `no-dotenv-${randomUUID()}`),
        ...(override === undefined ? {} : { [OVERRIDE]: override }),
        ...(probeLog === undefined ? {} : {
          NODE_OPTIONS: `--import=${pathToFileURL(backgroundWorkProbe).href}`,
          LUMERA_BACKGROUND_PROBE_LOG: probeLog,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    return { child, port, output: () => chunks.join(""), exited: () => exit };
  });
}

async function healthOf(api: ApiProcess): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${api.port}/api/healthz`);
    if (response.ok) return await response.json() as Record<string, unknown>;
  } catch {
    // Not listening (yet).
  }
  return undefined;
}

async function waitForHealth(api: ApiProcess): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (api.child.exitCode !== null) throw new Error(`API exited before health (${api.child.exitCode}):\n${api.output()}`);
    const health = await healthOf(api);
    if (health) return health;
    await sleep(250);
  }
  throw new Error(`API did not reach health within 60 seconds:\n${api.output()}`);
}

async function stop(api: ApiProcess): Promise<void> {
  if (api.child.exitCode !== null) return;
  api.child.kill("SIGTERM");
  await Promise.race([api.exited(), sleep(10_000)]);
  if (api.child.exitCode === null) api.child.kill("SIGKILL");
}

/** Boot must be refused: the process exits and never serves health. */
async function expectRefusal(databaseUrl: string, override: string | undefined): Promise<{ exitCode: number | null; output: string }> {
  const api = await startApi(databaseUrl, override);
  try {
    const started = Date.now();
    while (Date.now() - started < 60_000 && api.child.exitCode === null) {
      assert.equal(await healthOf(api), undefined, `Refused boot unexpectedly served health:\n${api.output()}`);
      await sleep(250);
    }
    assert.notEqual(api.child.exitCode, null, "Refused boot did not exit within 60 seconds.");
    assert.notEqual(api.child.exitCode, 0);
    return { exitCode: api.child.exitCode, output: api.output() };
  } finally {
    await stop(api);
  }
}

interface ProbeRecord {
  readonly kind: "timer" | "query";
  readonly type?: string;
  readonly text?: string;
  readonly stack: readonly string[];
}

// Functions whose timers and queries a readiness-override boot may create: the
// read-only readiness check, the two LISTEN listeners with their reconnects,
// and the override's own supervision and shutdown. Anything else on the stack
// is background work.
const allowedProbeFrames: ReadonlyArray<{ file: RegExp; functions?: readonly string[] }> = [
  { file: /\/lib\/db\/src\/migration-runtime\/[^/]+\.ts:/u },
  // Per-connection statement_timeout setup, run for whichever caller opened
  // the connection; that caller's own queries are still classified.
  { file: /\/lib\/db\/src\/pool-runtime\.ts:/u, functions: ["Object.onConnect"] },
  // This proof's own /api/healthz requests (response socket timers only).
  { file: /\/artifacts\/api-server\/src\/routes\/health\.ts:/u },
  {
    file: /\/artifacts\/api-server\/src\/lib\/salon-notification-events\.ts:/u,
    functions: ["startSalonNotificationEventListener", "stopSalonNotificationEventListener", "connectSharedListener",
      "connectListenerClient", "scheduleListenerReconnect", "destroyListenerConnection"],
  },
  {
    file: /\/artifacts\/api-server\/src\/lib\/catalog-cache\.ts:/u,
    functions: ["startCatalogCacheInvalidationListener", "stopCatalogCacheInvalidationListener", "CatalogCache.start",
      "CatalogCache.stop", "CatalogCache.connectListener", "CatalogCache.scheduleReconnect",
      "CatalogCache.handleListenerError", "CatalogCache.handleListenerEnd"],
  },
  {
    file: /\/artifacts\/api-server\/src\/index\.ts:/u,
    functions: ["superviseReadinessOverride", "shutDown", "clearScheduledTasks", "performCleanup", "flushAndExit"],
  },
];

function frameFunction(frame: string): string {
  return frame.replace(/^at (?:async )?/u, "").replace(/ \(.*$/u, "").replace(/ \[as [^\]]+\]$/u, "");
}

function isApplicationFrame(frame: string): boolean {
  return (frame.includes(`${workspaceRoot}/artifacts/`) || frame.includes(`${workspaceRoot}/lib/`))
    && !frame.includes("/node_modules/");
}

function isAllowedFrame(frame: string): boolean {
  return allowedProbeFrames.some(({ file, functions }) =>
    file.test(frame) && (!functions || functions.includes(frameFunction(frame))));
}

/**
 * Every probe record that is background work: a query whose stack has no
 * allowed function, or a timer whose stack has application frames but no
 * allowed function. Timers created purely inside libraries (pg-pool idle
 * timers, HTTP keep-alive) have no application frame and are not work.
 */
async function backgroundWorkViolations(probeLog: string): Promise<ProbeRecord[]> {
  const records = (await fs.readFile(probeLog, "utf8")).split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeRecord);
  assert.ok(records.some((record) => record.kind === "query"), "The probe recorded no SQL; it is not attached.");
  return records.filter((record) => {
    if (record.stack.some(isAllowedFrame)) return false;
    return record.kind === "query" || record.stack.some(isApplicationFrame);
  });
}

function describeViolations(violations: readonly ProbeRecord[]): string {
  return violations.slice(0, 10).map((violation) => `${violation.kind}${violation.text ? ` ${violation.text}` : ""}\n  ${
    violation.stack.filter(isApplicationFrame).slice(0, 6).join("\n  ")}`).join("\n");
}

async function probeLogPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lumera-override-probe-"));
  return path.join(directory, "background-work.jsonl");
}

/**
 * A migrated database renamed after migration: its ledger stays bound to the
 * old name, exactly like a database that is not the one the ledger was
 * written for.
 */
async function withRenamedMigratedDatabase<T>(callback: (connectionString: string) => Promise<T>): Promise<T> {
  const target = validateDisposableAdminUrl(requireAdminUrl());
  const admin = new pg.Pool({ connectionString: target.toString(), password: "", max: 1, connectionTimeoutMillis: 5_000 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const boundName = `lumera_override_bound_${suffix}`;
  const movedName = `lumera_override_moved_${suffix}`;
  const url = (name: string) => {
    const child = new URL(target.toString());
    child.pathname = `/${name}`;
    return child.toString();
  };
  let existing: string | undefined;
  try {
    const owner = (await admin.query<{ current_user: string }>("SELECT current_user")).rows[0]!.current_user;
    await admin.query(`CREATE DATABASE "${boundName}" OWNER "${owner}"`);
    existing = boundName;
    const bound = new pg.Pool({ connectionString: url(boundName), password: "", max: 2 });
    try {
      await registerDisposableTarget(admin, bound, boundName);
      await migrate(bound);
    } finally {
      await bound.end();
    }
    await admin.query(`ALTER DATABASE "${boundName}" RENAME TO "${movedName}"`);
    existing = movedName;
    return await callback(url(movedName));
  } finally {
    try {
      if (existing) await admin.query(`DROP DATABASE "${existing}"`);
    } finally {
      await admin.end();
    }
  }
}

function logLines(output: string, event: string): Array<Record<string, unknown>> {
  return output.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      return value.event === event ? [value] : [];
    } catch {
      return [];
    }
  });
}

function readinessErrorLine(output: string): string {
  const line = output.split("\n").find((candidate) => candidate.includes("MIGRATION_READINESS_"));
  assert.ok(line, `Refusal output did not name a readiness reason:\n${output}`);
  return line.trim();
}

async function logBytes(): Promise<Buffer> {
  return fs.readFile(sqlLogPath);
}

async function ddlProbe(pool: pg.Pool, databaseName: string): Promise<{ table: string; bytes: Buffer }> {
  const table = `override_log_probe_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE TABLE public."${table}" (id integer)`);
  await pool.query(`DROP TABLE public."${table}"`);
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 10_000) {
    const bytes = await logBytes();
    try {
      assertProbeLogged(bytes.toString("utf8"), databaseName, table);
      return { table, bytes };
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`DDL probe ${table} was not flushed to the PostgreSQL log.`, { cause: lastError });
}

/** Asserts the database-tagged server log shows no DDL while `window` ran. */
async function withNoDdlWindow<T>(pool: pg.Pool, databaseName: string, window: () => Promise<T>): Promise<T> {
  const settings = (await pool.query(`
    SELECT current_database() AS "databaseName", current_setting('log_statement') AS "logStatement",
      current_setting('log_line_prefix') AS "logLinePrefix", current_setting('log_destination') AS "logDestination",
      current_setting('log_min_messages') AS "logMinMessages"
  `)).rows[0];
  assertPostgresLogSettings(settings, databaseName);
  const before = await ddlProbe(pool, databaseName);
  const result = await window();
  const after = await ddlProbe(pool, databaseName);
  assert.ok(after.bytes.subarray(0, before.bytes.length).equals(before.bytes), "PostgreSQL log was truncated during the window.");
  assertNoDdlInBootWindow(after.bytes.subarray(before.bytes.length).toString("utf8"), databaseName, after.table);
  return result;
}

async function ledgerSnapshot(pool: pg.Pool): Promise<string> {
  const result = await pool.query(`
    SELECT migration_id, xmin::text AS xmin, to_jsonb(l) AS row
    FROM public.lumera_migration_ledger l ORDER BY migration_id
  `);
  return JSON.stringify(result.rows);
}

async function userTableWrites(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_stat_clear_snapshot()");
    const result = await client.query<{ writes: string }>(`
      SELECT COALESCE(SUM(n_tup_ins + n_tup_upd + n_tup_del), 0)::text AS writes
      FROM pg_stat_user_tables WHERE schemaname = 'public'
    `);
    return Number(result.rows[0]?.writes ?? 0);
  } finally {
    client.release();
  }
}

async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await applyMigrations(client, { expectedTargetIdentity: expectedDisposableTarget(pool) });
  } finally {
    client.release();
  }
}

test.after(async () => {
  if (!evidenceDir) return;
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(evidenceDir, "startup-readiness-override-proof.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), observations, note: "Disposable proof only." }, null, 2)}\n`,
  );
});

test("a failed readiness check is overridable only by the exact reason with a valid expiry", async (t) => {
  await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
    await migrate(pool);
    // A real catalog difference, standing in for a provider-side catalog change.
    await pool.query("CREATE TABLE public.lumera_override_drift_probe (id integer)");

    await t.test("no override: refused as before", async () => {
      const refused = await expectRefusal(connectionString, undefined);
      const line = readinessErrorLine(refused.output);
      assert.match(line, new RegExp(`${DRIFT}(?! \\()`, "u"));
      observations.push({ case: "no-override", exitCode: refused.exitCode, message: line });
    });

    await t.test("wrong reason: refused", async () => {
      const refused = await expectRefusal(connectionString, `MIGRATION_READINESS_LEDGER_FRONTIER@${utcSeconds(60 * 60_000)}`);
      const line = readinessErrorLine(refused.output);
      assert.match(line, /STARTUP_READINESS_OVERRIDE_REJECTED:reason-mismatch/u);
      observations.push({ case: "wrong-reason", exitCode: refused.exitCode, message: line });
    });

    await t.test("expired override: refused", async () => {
      const refused = await expectRefusal(connectionString, `${DRIFT}@${utcSeconds(-60_000)}`);
      const line = readinessErrorLine(refused.output);
      assert.match(line, /STARTUP_READINESS_OVERRIDE_REJECTED:expired/u);
      observations.push({ case: "expired", exitCode: refused.exitCode, message: line });
    });

    await t.test("expiry more than 24 hours ahead: refused", async () => {
      const refused = await expectRefusal(connectionString, `${DRIFT}@${utcSeconds(25 * 60 * 60_000)}`);
      const line = readinessErrorLine(refused.output);
      assert.match(line, /STARTUP_READINESS_OVERRIDE_REJECTED:too-long/u);
      observations.push({ case: "too-long", exitCode: refused.exitCode, message: line });
    });

    await t.test("exact reason and valid expiry: serves without DDL, ledger writes, or background work", async () => {
      const expiresAt = utcSeconds(2 * 60 * 60_000);
      const ledgerBefore = await ledgerSnapshot(pool);
      const writesBefore = await userTableWrites(pool);
      const probeLog = await probeLogPath();
      const { health, output } = await withNoDdlWindow(pool, name, async () => {
        const api = await startApi(connectionString, `${DRIFT}@${expiresAt}`, probeLog);
        try {
          const health = await waitForHealth(api);
          // Longer than the old startup sweep needs to touch the database.
          await sleep(5_000);
          return { health: (await healthOf(api)) ?? health, output: api.output() };
        } finally {
          await stop(api);
        }
      });
      // Public health says only that the override is active; details stay in the log.
      assert.equal(health.status, "readiness-override");
      assert.equal("startupReadinessOverride" in health, false);
      const publicBody = JSON.stringify(health);
      assert.doesNotMatch(publicBody, /MIGRATION_READINESS_|STARTUP_READINESS_OVERRIDE/u);
      assert.equal(publicBody.includes(expiresAt.slice(0, 16)), false, publicBody);
      assert.deepEqual(health.schedulerJobs, []);
      const active = logLines(output, "STARTUP_READINESS_OVERRIDE_ACTIVE");
      assert.equal(active.length, 1, output);
      assert.equal(active[0]!.reason, DRIFT);
      assert.equal(active[0]!.expiresAt, new Date(expiresAt).toISOString());
      const violations = await backgroundWorkViolations(probeLog);
      assert.deepEqual(violations.length, 0, `Background work started under the override:\n${describeViolations(violations)}`);
      assert.doesNotMatch(output, /Initial scheduler sweep|Legacy media migration/u);
      assert.equal(await ledgerSnapshot(pool), ledgerBefore, "The override boot changed the migration ledger.");
      assert.equal(await userTableWrites(pool), writesBefore, "The override boot wrote application tables.");
      observations.push({ case: "granted", health, log: active[0], backgroundWorkViolations: violations.length });
    });

    await t.test("the running override stops the process at expiry", async () => {
      const expiresAt = utcSeconds(20_000);
      const api = await startApi(connectionString, `${DRIFT}@${expiresAt}`);
      try {
        await waitForHealth(api);
        const exitCode = await Promise.race([api.exited(), sleep(60_000).then(() => "timeout" as const)]);
        assert.equal(exitCode, 1, api.output());
        const expired = logLines(api.output(), "STARTUP_READINESS_OVERRIDE_EXPIRED");
        assert.equal(expired.length, 1, api.output());
        assert.ok(Date.now() >= new Date(expiresAt).getTime());
        observations.push({ case: "expires-while-running", exitCode, log: expired[0] });
      } finally {
        await stop(api);
      }
    });
  });
});

test("passing readiness with the override still set runs normally and warns to remove it", async () => {
  await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
    await migrate(pool);
    const expiresAt = utcSeconds(60 * 60_000);
    const ledgerBefore = await ledgerSnapshot(pool);
    const probeLog = await probeLogPath();
    const { health, output } = await withNoDdlWindow(pool, name, async () => {
      const api = await startApi(connectionString, `${DRIFT}@${expiresAt}`, probeLog);
      try {
        await waitForHealth(api);
        await sleep(3_000);
        return { health: (await healthOf(api))!, output: api.output() };
      } finally {
        await stop(api);
      }
    });
    assert.equal(health.status, "ok");
    assert.equal("startupReadinessOverride" in health, false);
    assert.ok(Array.isArray(health.schedulerJobs) && health.schedulerJobs.length > 0, "Background jobs were not registered.");
    const unused = logLines(output, "STARTUP_READINESS_OVERRIDE_UNUSED");
    assert.equal(unused.length, 1, output);
    assert.equal(unused[0]!.reason, DRIFT);
    // Positive control: the same probe and classifier must see the normal
    // boot's background work, or an empty override result would prove nothing.
    const violations = await backgroundWorkViolations(probeLog);
    const fromBackgroundWork = violations.filter((violation) =>
      violation.stack.some((frame) => frameFunction(frame) === "startBackgroundWork"));
    assert.ok(fromBackgroundWork.some((violation) => violation.kind === "timer"), "Probe missed the normal boot's job timers.");
    assert.ok(violations.some((violation) => violation.kind === "query"), "Probe missed the normal boot's job queries.");
    assert.equal(logLines(output, "STARTUP_READINESS_OVERRIDE_ACTIVE").length, 0);
    assert.equal(await ledgerSnapshot(pool), ledgerBefore);
    observations.push({
      case: "unused",
      healthStatus: health.status,
      log: unused[0],
      positiveControl: {
        violations: violations.length,
        startBackgroundWorkTimers: fromBackgroundWork.filter((violation) => violation.kind === "timer").length,
        queries: violations.filter((violation) => violation.kind === "query").length,
      },
    });
  });
});

test("every reason other than catalog drift is refused even with an override naming it", async (t) => {
  const refuse = async (label: string, connectionString: string, reason: string) => {
    const refused = await expectRefusal(connectionString, `${reason}@${utcSeconds(60 * 60_000)}`);
    const line = readinessErrorLine(refused.output);
    assert.ok(line.includes(notOverridable(reason)), line);
    observations.push({ case: label, exitCode: refused.exitCode, message: line });
  };

  await t.test("empty database: LEDGER_MISSING refused", async () => {
    await withOwnedDisposableDatabase(requireAdminUrl(), async ({ connectionString }) => {
      await refuse("ledger-missing", connectionString, "MIGRATION_READINESS_LEDGER_MISSING");
    });
  });

  await t.test("schema outside public: NON_PUBLIC_NAMESPACE refused", async () => {
    await withOwnedDisposableDatabase(requireAdminUrl(), async ({ pool, connectionString }) => {
      await migrate(pool);
      await pool.query("CREATE SCHEMA lumera_override_extra_schema");
      await refuse("non-public-namespace", connectionString, "MIGRATION_READINESS_NON_PUBLIC_NAMESPACE");
    });
  });

  await t.test("ledger bound to another database: LEDGER_IDENTITY_MISMATCH refused", async () => {
    await withRenamedMigratedDatabase(async (connectionString) => {
      await refuse("ledger-identity-mismatch", connectionString,
        "MIGRATION_READINESS_LEDGER_IDENTITY_MISMATCH:000001:databaseName");
    });
  });

  await t.test("connection terminated after connect, before the first query: READ_FAILED refused", async () => {
    await withOwnedDisposableDatabase(requireAdminUrl(), async ({ pool, connectionString }) => {
      await migrate(pool);
      const reading = new pg.Pool({ connectionString, password: "", max: 1 });
      // The entrypoint cannot be stopped at this instant, so the same admission
      // it runs is driven directly with a connection the server has terminated.
      const terminating = {
        async connect() {
          const client = await reading.connect();
          client.on("error", () => undefined);
          const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          const terminated = await pool.query<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [pid]);
          assert.equal(terminated.rows[0]?.ok, true);
          await sleep(200);
          return { query: client.query.bind(client), release: () => client.release(true) };
        },
      };
      try {
        const reason = "MIGRATION_READINESS_READ_FAILED";
        for (const named of [reason, DRIFT]) {
          await assert.rejects(
            admitDatabaseMigrationStartup(terminating as never, {
              NODE_ENV: "production",
              [OVERRIDE]: `${named}@${utcSeconds(60 * 60_000)}`,
            }),
            (error: unknown) => {
              assert.equal((error as Error).message, notOverridable(reason));
              observations.push({ case: `read-failed-named-${named}`, message: (error as Error).message });
              return true;
            },
          );
        }
      } finally {
        await reading.end();
      }
    });
  });
});
