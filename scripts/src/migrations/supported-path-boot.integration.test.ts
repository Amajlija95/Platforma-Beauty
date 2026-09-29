/**
 * Disposable proof of the actual no-startup-DDL entrypoint path.
 *
 * This spawns the checked-in API entrypoint directly. The real index module,
 * workers, listeners, readiness guard and reconciliation are exercised without
 * a generated candidate.
 *
 * Run with an explicit disposable administrator URL:
 * NODE_ENV=test pnpm --filter @workspace/scripts exec tsx \
 *   src/migrations/supported-path-boot.integration.test.ts \
 *   --admin-url=<explicit-loopback-nondefault-postgres-admin-url> \
 *   --sql-log=<append-only-postgresql-stderr-log> \
 *   [--evidence-dir=<ignored-or-external-output-directory>]
 *
 * The PostgreSQL server must use log_statement=ddl (or mod/all),
 * log_destination including stderr, and log_line_prefix containing db=%d.
 * Versioned evidence is never overwritten unless
 * --regenerate-versioned-evidence is supplied explicitly.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { assertDestructiveTestRuntimeAllowed } from "@workspace/db/destructive-test-runtime";
import { beginFingerprintTransaction } from "../schema-drift/fingerprint-transaction";
import {
  explicitAdminUrlFromArgs,
  withOwnedDisposableDatabase,
} from "../startup-equivalence/fixtures";
import { applyMigrations } from "./runner";
import { expectedDisposableTarget } from "./disposable-target-fixture";
import { loadMigrations } from "./files";
import { inspectDeploymentEligibility } from "./deployment-eligibility";
import {
  assertNoDdlInBootWindow,
  assertPostgresLogSettings,
  assertProbeLogged,
  assertProofOutputDirectorySafe,
  proofOutputFromArgs,
  type PostgresLogSettings,
} from "./postgres-log-evidence";

assertDestructiveTestRuntimeAllowed(process.env, "Supported path boot integration tests");

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(thisDir, "../../..");
const apiEntrypoint = path.resolve(workspaceRoot, "artifacts/api-server/src/index.ts");
const tsxBin = path.resolve(workspaceRoot, "scripts/node_modules/.bin/tsx");
const sqlLogArgument = process.argv.find((argument) => argument.startsWith("--sql-log="));
assert.ok(sqlLogArgument, "An explicit --sql-log path is required for the disposable boot proof.");
const sqlLogPath = path.resolve(workspaceRoot, sqlLogArgument.slice("--sql-log=".length));
const proofOutput = proofOutputFromArgs(process.argv.slice(2), workspaceRoot);
const adminUrl = explicitAdminUrlFromArgs();
const proofRecords: Array<Record<string, unknown>> = [];

const ensureNames = [
  "ensureBusinessGrowthSchema",
  "ensureMediaSchema",
  "ensureShippingConfigSchema",
  "ensureMarketplacePerformanceIndexes",
  "ensureReferralSchema",
  "ensureWebPushSchema",
  "ensureBookingCommandSchema",
  "ensureEducationBundlePurchaseSchema",
] as const;

function requireAdminUrl(): string {
  assert.ok(adminUrl, "An explicit --admin-url is required for the disposable boot proof.");
  return adminUrl;
}

async function withDedicatedClient<T>(
  pool: pg.Pool,
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
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

async function readActualEntrypoint(): Promise<{ path: string; sourceHash: string }> {
  const source = await fs.readFile(apiEntrypoint, "utf8");
  for (const name of ensureNames) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), `Actual index still contains ${name}`);
  }
  assert.match(source, /import \{\n  admitDatabaseMigrationStartup,\n  STARTUP_READINESS_OVERRIDE_VARIABLE,\n\} from "@workspace\/db\/migration-runtime";/u);
  assert.match(source, /const startupAdmission = await admitDatabaseMigrationStartup\(pool\);/u);
  assert.match(source, /await reconcileKnownTestListings\(\);/u);
  return {
    path: apiEntrypoint,
    sourceHash: createHash("sha256").update(source).digest("hex"),
  };
}

test.after(async () => {
  const proof = {
    generatedAt: new Date().toISOString(),
    actualEntrypoint: "artifacts/api-server/src/index.ts",
    actualSourceSha256: proofRecords.find((record) => record.actualSourceSha256)?.actualSourceSha256 ?? null,
    exactRemovedEnsureSymbols: ensureNames,
    candidateHistory: {
      sourceSha256: "81779a45eb64d883a7031c6a95bde1cf905b125f63eb192b336359f16c4c1dc9",
      transformedCandidateSha256: "8937a8cc16fa85edc99d42a1007c8d7e8d94dd47b32a8ce51fbf70e1522f61c5",
      note: "Retained metadata from the disposable candidate proof; no candidate was generated in this actual-entrypoint run.",
    },
    ddlLogPath: sqlLogPath,
    proofOutput: {
      directory: proofOutput.directory,
      regeneratedVersionedEvidence: proofOutput.regeneratesVersionedEvidence,
    },
    phases: proofRecords,
    note: "Disposable proof only; not evidence about the published database.",
  };
  await assertProofOutputDirectorySafe(proofOutput, workspaceRoot);
  await fs.mkdir(proofOutput.directory, { recursive: true });
  await fs.writeFile(
    path.join(proofOutput.directory, "supported-paths-actual-proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(proofOutput.directory, "supported-paths-actual.log"),
    `${proofRecords.map((record) => `${record.phase}: PASS ${JSON.stringify(record)}`).join("\n")}\n`,
    "utf8",
  );
});

async function waitForHealth(baseUrl: string, child: ChildProcess, stderr: string[]): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    if (child.exitCode !== null) {
      throw new Error(`Candidate exited before health (${child.exitCode}): ${stderr.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/healthz`);
      if (response.ok) return;
    } catch {
      // The listener may not have started yet.
    }
    await sleep(250);
  }
  throw new Error(`Candidate did not reach health within 45 seconds: ${stderr.join("")}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(5_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function bootActualEntrypoint(databaseUrl: string): Promise<{ stderr: string }> {
  const port = await availablePort();
  const stderr: string[] = [];
  const child = spawn(tsxBin, [apiEntrypoint], {
    cwd: workspaceRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? workspaceRoot,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      LUMERA_DATABASE_URL: databaseUrl,
      PORT: String(port),
      BASE_PATH: "/api",
      SESSION_SECRET: "lumera-disposable-boot-proof-session-secret",
      DOTENV_CONFIG_PATH: path.join(proofOutput.directory, `no-dotenv-${randomUUID()}`),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  try {
    await waitForHealth(`http://127.0.0.1:${port}`, child, stderr);
    await sleep(1_000);
  } finally {
    await stopChild(child);
  }
  return { stderr: stderr.join("") };
}

async function expectActualReject(
  databaseUrl: string,
): Promise<{ stderr: string; reachedHealth: boolean }> {
  const port = await availablePort();
  const stderr: string[] = [];
  const child = spawn(tsxBin, [apiEntrypoint], {
    cwd: workspaceRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? workspaceRoot,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      LUMERA_DATABASE_URL: databaseUrl,
      PORT: String(port),
      BASE_PATH: "/api",
      SESSION_SECRET: "lumera-disposable-boot-proof-session-secret",
      DOTENV_CONFIG_PATH: path.join(proofOutput.directory, `no-dotenv-${randomUUID()}`),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  try {
    const started = Date.now();
    let reachedHealth = false;
    while (Date.now() - started < 10_000) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);
        reachedHealth = response.ok;
        if (reachedHealth) break;
      } catch {
        // Guard failure should happen before a listener is created.
      }
      await sleep(250);
    }
    assert.equal(reachedHealth, false, "Unsupported actual entrypoint unexpectedly reached health.");
    return { stderr: stderr.join(""), reachedHealth };
  } finally {
    await stopChild(child);
  }
}

async function catalogSignature(pool: pg.Pool): Promise<string> {
  const client = await pool.connect();
  try {
    await beginFingerprintTransaction(client);
    const classes = await client.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.schema_name,q.object_name,q.kind), '[]'::jsonb) AS value
      FROM (
        SELECT n.nspname AS schema_name,c.relname AS object_name,c.relkind AS kind,
          c.relnamespace::text AS namespace_oid
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
      ) q
    `);
    const functions = await client.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.schema_name,q.object_name,q.identity), '[]'::jsonb) AS value
      FROM (
        SELECT n.nspname AS schema_name,p.proname AS object_name,
          pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity,
          p.prokind AS kind
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public'
      ) q
    `);
    const triggers = await client.query(`
      SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.table_name,q.trigger_name), '[]'::jsonb) AS value
      FROM (
        SELECT c.relname AS table_name,t.tgname AS trigger_name,
          t.tgenabled AS enabled
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND NOT t.tgisinternal
      ) q
    `);
    const value = JSON.stringify({
      classes: classes.rows[0]?.value,
      functions: functions.rows[0]?.value,
      triggers: triggers.rows[0]?.value,
    });
    await client.query("COMMIT");
    return createHash("sha256").update(value).digest("hex");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Catalog fingerprint and rollback both failed");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function fastFunctionDefinition(): Promise<string> {
  const summaryPath = path.resolve(
    workspaceRoot,
    "docs/startup-ddl-equivalence/evidence/summary.json",
  );
  const summary = JSON.parse(await fs.readFile(summaryPath, "utf8")) as {
    startupRepeatDifference?: {
      catalogChanges?: Array<{ kind: string; identity: string; after?: { definition?: string } }>;
    };
  };
  const change = summary.startupRepeatDifference?.catalogChanges?.find((item) =>
    item.kind === "functions"
    && item.identity.includes("prevent_education_gift_voucher_snapshot_update"),
  );
  const definition = change?.after?.definition;
  assert.ok(definition, "Fast-path function definition evidence is missing");
  return definition;
}

interface LogSnapshot {
  readonly bytes: Buffer;
  readonly text: string;
}

interface BootLogEvidence {
  readonly logSettings: PostgresLogSettings;
  readonly preBootProbeTable: string;
  readonly postBootProbeTable: string;
  readonly bootWindowBytes: number;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function readLogSnapshot(): Promise<LogSnapshot> {
  const metadata = await fs.stat(sqlLogPath).catch((error: unknown) => {
    throw new Error(`PostgreSQL log is unavailable at the explicit --sql-log path: ${sqlLogPath}`, { cause: error });
  });
  assert.ok(metadata.isFile(), `--sql-log must name a regular PostgreSQL log file: ${sqlLogPath}`);
  const bytes = await fs.readFile(sqlLogPath);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("PostgreSQL log is not valid UTF-8 text and cannot prove zero startup DDL.", { cause: error });
  }
  return { bytes, text };
}

async function readPostgresLogSettings(pool: pg.Pool): Promise<PostgresLogSettings> {
  const result = await pool.query<{
    database_name: string;
    log_statement: string;
    log_line_prefix: string;
    log_destination: string;
    log_min_messages: string;
  }>(`
    SELECT current_database() AS database_name,
      current_setting('log_statement') AS log_statement,
      current_setting('log_line_prefix') AS log_line_prefix,
      current_setting('log_destination') AS log_destination,
      current_setting('log_min_messages') AS log_min_messages
  `);
  const row = result.rows[0];
  assert.ok(row, "Owned child database did not return PostgreSQL log settings.");
  return {
    databaseName: row.database_name,
    logStatement: row.log_statement,
    logLinePrefix: row.log_line_prefix,
    logDestination: row.log_destination,
    logMinMessages: row.log_min_messages,
  };
}

function probeTableName(): string {
  return `startup_log_probe_${randomUUID().replaceAll("-", "")}`;
}

async function writeDdlProbe(pool: pg.Pool, tableName: string): Promise<void> {
  const identifier = `public.${quoteIdentifier(tableName)}`;
  await pool.query(`CREATE TABLE ${identifier} (id integer)`);
  await pool.query(`DROP TABLE ${identifier}`);
}

async function waitForLoggedProbe(databaseName: string, tableName: string): Promise<LogSnapshot> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 10_000) {
    try {
      const snapshot = await readLogSnapshot();
      assertProbeLogged(snapshot.text, databaseName, tableName);
      return snapshot;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(
    `Database-tagged DDL probe was not flushed to PostgreSQL log within 10 seconds for ${databaseName}.`,
    { cause: lastError },
  );
}

async function captureBootLogEvidence<T>(
  pool: pg.Pool,
  databaseName: string,
  boot: () => Promise<T>,
): Promise<{ result: T; evidence: BootLogEvidence }> {
  const settings = await readPostgresLogSettings(pool);
  assertPostgresLogSettings(settings, databaseName);
  await readLogSnapshot();

  const preBootProbeTable = probeTableName();
  await writeDdlProbe(pool, preBootProbeTable);
  const bootStart = await waitForLoggedProbe(databaseName, preBootProbeTable);

  const result = await boot();

  const postBootProbeTable = probeTableName();
  await writeDdlProbe(pool, postBootProbeTable);
  const completed = await waitForLoggedProbe(databaseName, postBootProbeTable);
  assert.ok(
    completed.bytes.subarray(0, bootStart.bytes.length).equals(bootStart.bytes),
    "PostgreSQL log was rotated, replaced, or truncated during boot; it cannot prove zero startup DDL.",
  );
  const bootWindow = new TextDecoder("utf-8", { fatal: true }).decode(
    completed.bytes.subarray(bootStart.bytes.length),
  );
  // The post-boot DDL is an intentional liveness/flush control, never boot
  // evidence. The pre-boot control is before the byte cursor entirely.
  assertNoDdlInBootWindow(bootWindow, databaseName, postBootProbeTable);
  return {
    result,
    evidence: {
      logSettings: settings,
      preBootProbeTable,
      postBootProbeTable,
      bootWindowBytes: completed.bytes.length - bootStart.bytes.length,
    },
  };
}

function recordBootLogEvidence(evidence: BootLogEvidence): void {
  const record = proofRecords.at(-1);
  assert.ok(record, "Boot log evidence has no current proof phase.");
  const previous = Array.isArray(record.bootLogEvidence) ? record.bootLogEvidence : [];
  record.bootLogEvidence = [...previous, evidence];
}

async function runBootPath(
  databaseUrl: string,
  databaseName: string,
  pool: pg.Pool,
): Promise<void> {
  const signatureBefore = await catalogSignature(pool);
  const { result, evidence } = await captureBootLogEvidence(
    pool,
    databaseName,
    () => bootActualEntrypoint(databaseUrl),
  );
  assert.equal(result.stderr, "", `Candidate stderr:\n${result.stderr}`);
  assert.equal(await catalogSignature(pool), signatureBefore, "API boot changed the catalog.");
  recordBootLogEvidence(evidence);
}

test("catalog signatures are stable across pooled connections and search paths but detect real catalog changes", async () => {
  await withOwnedDisposableDatabase(requireAdminUrl(), async ({ pool, connectionString }) => {
    await pool.query(`
      CREATE TABLE public.catalog_signature_argument (id integer);
      CREATE FUNCTION public.catalog_signature_probe(value public.catalog_signature_argument)
        RETURNS integer LANGUAGE sql AS 'SELECT (value).id';
    `);
    const pools = [
      new pg.Pool({ connectionString, max: 1, options: "-c search_path=public,pg_catalog" }),
      new pg.Pool({ connectionString, max: 1, options: "-c search_path=pg_catalog" }),
    ];
    const sessionState = async (candidate: pg.Pool) => ({
      pid: (await candidate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      settings: (await candidate.query(`
        SELECT name, setting FROM pg_catalog.pg_settings
        WHERE name = ANY($1::text[]) ORDER BY name
      `, [[
        "search_path", "quote_all_identifiers", "TimeZone", "DateStyle",
        "IntervalStyle", "extra_float_digits", "bytea_output",
        "transaction_isolation", "transaction_read_only",
      ]])).rows,
    });
    try {
      const before = await Promise.all(pools.map(sessionState));
      assert.notEqual(before[0]!.pid, before[1]!.pid, "The regression requires distinct backend connections.");
      assert.notDeepEqual(before[0]!.settings, before[1]!.settings, "The session search paths must differ.");
      const identities = await Promise.all(pools.map(async (candidate) =>
        (await candidate.query(`
          SELECT pg_catalog.pg_get_function_identity_arguments(
            'public.catalog_signature_probe(public.catalog_signature_argument)'::regprocedure
          ) AS identity
        `)).rows[0].identity,
      ));
      assert.notEqual(identities[0], identities[1], "The fixture must expose search-path-dependent identity formatting.");
      const signatures = await Promise.all(pools.map(catalogSignature));
      assert.equal(signatures[0], signatures[1], "Pinned catalog fingerprints must not depend on session search_path.");
      const baseline = signatures[0]!;
      await pool.query("CREATE TABLE public.catalog_signature_added (id integer)");
      const withTable = await Promise.all(pools.map(catalogSignature));
      assert.equal(withTable[0], withTable[1]);
      assert.notEqual(withTable[0], baseline, "A real table addition must change the signature.");
      await pool.query("DROP TABLE public.catalog_signature_added");
      assert.deepEqual(await Promise.all(pools.map(catalogSignature)), [baseline, baseline]);
      await pool.query("CREATE FUNCTION public.catalog_signature_added() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
      const withFunction = await Promise.all(pools.map(catalogSignature));
      assert.equal(withFunction[0], withFunction[1]);
      assert.notEqual(withFunction[0], baseline, "A real function addition must change the signature.");
      await pool.query("DROP FUNCTION public.catalog_signature_added()");
      assert.deepEqual(await Promise.all(pools.map(catalogSignature)), [baseline, baseline]);
      assert.deepEqual(await Promise.all(pools.map(sessionState)), before, "Fingerprint transactions must preserve pooled session settings.");
    } finally {
      await Promise.all(pools.map((candidate) => candidate.end()));
    }
  });
});

test("fresh and verified existing supported paths boot through the actual entrypoint without startup DDL", async () => {
  const actual = await readActualEntrypoint();
  proofRecords.push({ phase: "A_FRESH_APPLY_BOOT", actualSourceSha256: actual.sourceHash });
  await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
      await withDedicatedClient(pool, (client) => applyMigrations(client, { expectedTargetIdentity: expectedDisposableTarget(pool) }));
      const eligibility = await withDedicatedClient(pool, (client) => inspectDeploymentEligibility(client));
      assert.equal(eligibility.path, "SUPPORTED_EXISTING");
      await runBootPath(connectionString, name, pool);
  });
});

test("canonical baseline with configured global references admits 000002 and boots", async () => {
  const actual = await readActualEntrypoint();
  proofRecords.push({ phase: "B1_EXISTING_GLOBAL_CONFIGURATION_BOOT", actualSourceSha256: actual.sourceHash });
  await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
      const migrations = await loadMigrations();
      await withDedicatedClient(pool, (client) => applyMigrations(client, { migrations: [migrations[0]!], expectedTargetIdentity: expectedDisposableTarget(pool) }));
      await pool.query(`
        INSERT INTO public.shop_settings
          (show_loyalty_points, points_per_100_rsd, low_stock_threshold,
           default_delivery_business_days, seller_company_name)
        VALUES (true, 3, 7, 5, 'Configured Disposable Seller')
      `);
      const transition = await withDedicatedClient(pool, (client) => applyMigrations(client, { expectedTargetIdentity: expectedDisposableTarget(pool) }));
      assert.deepEqual(transition.applied, ["000002", "000003", "000004"]);
      const eligibility = await withDedicatedClient(pool, (client) => inspectDeploymentEligibility(client));
      assert.equal(eligibility.path, "SUPPORTED_EXISTING");
      await runBootPath(connectionString, name, pool);
  });

  await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
    const migrations = await loadMigrations();
    await withDedicatedClient(pool, (client) => applyMigrations(client, { migrations: [migrations[0]!], expectedTargetIdentity: expectedDisposableTarget(pool) }));
    await pool.query(`
      UPDATE public.lumera_migration_ledger
      SET state='ADOPTED'
      WHERE migration_id='000001'
    `);
    const definition = await fastFunctionDefinition();
    await pool.query(definition);
    const transition = await withDedicatedClient(pool, (client) => applyMigrations(client, { expectedTargetIdentity: expectedDisposableTarget(pool) }));
    assert.deepEqual(transition.applied, ["000002", "000003", "000004"]);
    const eligibility = await withDedicatedClient(pool, (client) => inspectDeploymentEligibility(client));
    assert.equal(eligibility.path, "SUPPORTED_EXISTING");
    proofRecords.push({
      phase: "B1_ADOPTED_KNOWN_FAST_CATALOG_BOOT",
      actualSourceSha256: actual.sourceHash,
      ledgerState: "ADOPTED",
      catalogFixture: "known-fast-function-definition",
    });
    await runBootPath(connectionString, name, pool);
  });
});

test("runtime-populated tracked frontier repeats without bootstrap admission and boots", async () => {
  const actual = await readActualEntrypoint();
  proofRecords.push({ phase: "B2_TRACKED_RUNTIME_BOOT", actualSourceSha256: actual.sourceHash });
  await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
      await withDedicatedClient(pool, (client) => applyMigrations(client, { expectedTargetIdentity: expectedDisposableTarget(pool) }));
      await pool.query(`
        INSERT INTO public.users (id, first_name, last_name, email, password_hash, role)
        VALUES
          ('10000000-0000-4000-8000-000000000001','Tenant','One','tenant-one@disposable.invalid','x','CUSTOMER'),
          ('10000000-0000-4000-8000-000000000002','Tenant','Two','tenant-two@disposable.invalid','x','CUSTOMER')
      `);
      await pool.query(`
        INSERT INTO public.salons
          (id, owner_id, name, slug, city, municipality, address, phone, email,
           short_description, description, image_url, gallery)
        VALUES
          ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Tenant One Salon','tenant-one-salon','Belgrade','Stari Grad','One 1','+381600000001','one@disposable.invalid','One','One','', '[]'),
          ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Tenant Two Salon','tenant-two-salon','Novi Sad','Novi Sad','Two 2','+381600000002','two@disposable.invalid','Two','Two','', '[]')
      `);
      const before = await catalogSignature(pool);
      const repeat = await withDedicatedClient(pool, (client) => applyMigrations(client, { expectedTargetIdentity: expectedDisposableTarget(pool) }));
      assert.deepEqual(repeat.applied, []);
      assert.deepEqual(repeat.skipped, ["000001", "000002", "000003", "000004"]);
      assert.equal(await catalogSignature(pool), before);
      const eligibility = await withDedicatedClient(pool, (client) => inspectDeploymentEligibility(client));
      assert.equal(eligibility.path, "SUPPORTED_EXISTING");
      assert.equal(eligibility.mode, "TRACKED_RUNTIME");
      await runBootPath(connectionString, name, pool);
  });
});

test("missing baseline, unknown catalog and ambiguous history fail before process health", async () => {
  const actual = await readActualEntrypoint();
  proofRecords.push({ phase: "C_UNSUPPORTED_PREHEALTH_REJECTION", actualSourceSha256: actual.sourceHash });
  await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
      // A schema body without a ledger is an existing unknown state; the
      // Actual-entrypoint guard must reject it before listen/reconciliation.
      const migrations = await loadMigrations();
      await pool.query("BEGIN");
      await pool.query(migrations[0]!.body);
      await pool.query("COMMIT");
      const { result: rejection, evidence } = await captureBootLogEvidence(
        pool,
        name,
        () => expectActualReject(connectionString),
      );
      assert.match(rejection.stderr, /migration|ledger|unsupported|readiness/i);
      const ledger = await pool.query("SELECT to_regclass('public.lumera_migration_ledger') AS ledger");
      assert.equal(ledger.rows[0]?.ledger, null, "Guard created a ledger for an unsupported database.");
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.subscription_plans")).rows[0]?.count, 0);
      assert.equal((await withDedicatedClient(pool, (client) => inspectDeploymentEligibility(client))).path, "UNSUPPORTED");
      recordBootLogEvidence(evidence);
    });

    await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
      await withDedicatedClient(pool, (client) => applyMigrations(client, { expectedTargetIdentity: expectedDisposableTarget(pool) }));
      await pool.query("CREATE TABLE public.unexpected_boot_catalog_marker (id integer PRIMARY KEY)");
      const { result: rejection, evidence } = await captureBootLogEvidence(
        pool,
        name,
        () => expectActualReject(connectionString),
      );
      assert.match(rejection.stderr, /migration|catalog|unsupported|readiness/i);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.unexpected_boot_catalog_marker")).rows[0]?.count, 0);
      recordBootLogEvidence(evidence);
    });

    await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
      const migrations = await loadMigrations();
      await withDedicatedClient(pool, (client) => applyMigrations(client, { migrations: [migrations[0]!], expectedTargetIdentity: expectedDisposableTarget(pool) }));
      await pool.query(`
        INSERT INTO public.users (id, first_name, last_name, email, password_hash, role)
        VALUES ('30000000-0000-4000-8000-000000000001','Ambiguous','History','ambiguous@disposable.invalid','x','CUSTOMER')
      `);
      const before = await pool.query("SELECT count(*)::int AS count FROM public.lumera_migration_ledger");
      const { result: rejection, evidence } = await captureBootLogEvidence(
        pool,
        name,
        () => expectActualReject(connectionString),
      );
      assert.match(rejection.stderr, /migration|history|unsupported|readiness/i);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM public.lumera_migration_ledger")).rows[0]?.count, before.rows[0]?.count);
      recordBootLogEvidence(evidence);
    });

    await withOwnedDisposableDatabase(requireAdminUrl(), async ({ name, pool, connectionString }) => {
      const migrations = await loadMigrations();
      await withDedicatedClient(pool, (client) => applyMigrations(client, { migrations: [migrations[0]!], expectedTargetIdentity: expectedDisposableTarget(pool) }));
      await pool.query(`
        UPDATE public.lumera_migration_ledger
        SET state='FAILED', error='synthetic interrupted receipt', finished_at=clock_timestamp()
        WHERE migration_id='000001'
      `);
      const { result: rejection, evidence } = await captureBootLogEvidence(
        pool,
        name,
        () => expectActualReject(connectionString),
      );
      assert.match(rejection.stderr, /migration|failed|receipt|readiness/i);
      const failed = await pool.query("SELECT state,error FROM public.lumera_migration_ledger WHERE migration_id='000001'");
      assert.equal(failed.rows[0]?.state, "FAILED");
      assert.equal(failed.rows[0]?.error, "synthetic interrupted receipt");
      recordBootLogEvidence(evidence);
    });
});
