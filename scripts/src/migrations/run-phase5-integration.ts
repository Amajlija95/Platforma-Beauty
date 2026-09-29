/**
 * Owns the PostgreSQL instance used by Phase 5 migration proofs. It never
 * reads DATABASE_URL or libpq PG* connection settings: every test receives an
 * explicit loopback, non-5432 administrator URL and creates only owned child
 * databases through withOwnedDisposableDatabase.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { phase5DisposableIntegrationSuites } from "./phase5-test-inventory";
import { isDeploymentRuntime } from "./development-runtime";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const owner = "lumera_phase5_owner";
const ambientDatabaseKeys = [
  "DATABASE_URL",
  "LUMERA_DATABASE_URL",
  "LUMERA_MIGRATION_DATABASE_URL",
  "LUMERA_PHASE4_DISPOSABLE_DATABASE_URL",
  "LUMERA_PHASE4_DISPOSABLE_DB",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "PGSSLCERT",
  "PGSSLKEY",
] as const;

type Suite = (typeof phase5DisposableIntegrationSuites)[number];
type Result = {
  readonly suite: string;
  readonly file: string;
  readonly exitCode: number;
  readonly logPath: string;
  readonly tests: number;
  readonly passed: number;
  readonly skipped: number;
};

interface Options {
  readonly suites: readonly Suite[];
  readonly outputDir: string;
  readonly postgresBin?: string;
  readonly testTimeoutMs: number;
}

export function assertSafeRuntime(environment: NodeJS.ProcessEnv = process.env): void {
  if (isDeploymentRuntime(environment)) {
    throw new Error("Phase 5 disposable integration runner refuses production or deployment runtimes.");
  }
  // REPLIT_ENVIRONMENT can have a production-like value in an editor
  // workspace. It is not a deployment indicator by itself; the explicit
  // flags above and exclusively runner-created cluster establish the boundary.
}

export function parsePhase5IntegrationOptions(argv: readonly string[]): Options {
  const selected = new Set<string>();
  let outputDir: string | undefined;
  let postgresBin: string | undefined;
  let testTimeoutMs = 10 * 60_000;
  for (const argument of argv) {
    if (argument === "--") {
      continue;
    } else if (argument.startsWith("--suite=")) {
      for (const id of argument.slice("--suite=".length).split(",")) if (id) selected.add(id);
    } else if (argument.startsWith("--output-dir=")) {
      outputDir = argument.slice("--output-dir=".length);
    } else if (argument.startsWith("--postgres-bin=")) {
      postgresBin = argument.slice("--postgres-bin=".length);
    } else if (argument.startsWith("--test-timeout-ms=")) {
      testTimeoutMs = Number(argument.slice("--test-timeout-ms=".length));
    } else {
      throw new Error(`Unknown option: ${argument}. Use --suite=<id[,id]> --output-dir=<directory> --postgres-bin=<directory>.`);
    }
  }
  const suites = selected.size === 0
    ? [...phase5DisposableIntegrationSuites]
    : phase5DisposableIntegrationSuites.filter((suite) => selected.has(suite.id));
  if (selected.size > 0 && (suites.length === 0 || suites.length !== selected.size)) {
    const known = phase5DisposableIntegrationSuites.map((suite) => suite.id).join(", ");
    throw new Error(`Unknown --suite selection. Available suites: ${known}.`);
  }
  if (!Number.isSafeInteger(testTimeoutMs) || testTimeoutMs < 1_000 || testTimeoutMs > 30 * 60_000) {
    throw new Error("--test-timeout-ms must be an integer between 1000 and 1800000.");
  }
  return {
    suites,
    outputDir: outputDir ?? path.join(os.tmpdir(), `lumera-phase5-integration-${process.pid}-${randomBytes(5).toString("hex")}`),
    postgresBin,
    testTimeoutMs,
  };
}

function isWithin(directory: string, parent: string): boolean {
  const relative = path.relative(parent, directory);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function realpathWithMissingTail(target: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path.resolve(target);
  while (true) {
    try {
      return path.resolve(await realpath(cursor), ...missing.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`Cannot resolve output directory: ${target}`);
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function validatedOutputDirectory(value: string, root = workspaceRoot): Promise<string> {
  const outputDir = path.resolve(value);
  const [workspace, resolvedOutput] = await Promise.all([
    realpath(root),
    realpathWithMissingTail(outputDir),
  ]);
  // .local need not exist in a fresh checkout. Derive its boundary from the
  // canonical workspace, not from a symlink that could point into tracked paths.
  const local = path.join(workspace, ".local");
  if (isWithin(resolvedOutput, workspace) && !isWithin(resolvedOutput, local)) {
    throw new Error("Phase 5 output must be outside the workspace or inside ignored .local/.");
  }
  return outputDir;
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await access(command);
    return true;
  } catch {
    return false;
  }
}

export function serialLogWriter(logPath: string): { write(chunk: Buffer): void; flush(): Promise<void> } {
  // Reusing an output directory must not let a previous run's successful
  // summary satisfy validation when this run emits no test summary.
  let pending = writeFile(logPath, "");
  return {
    write(chunk) {
      pending = pending.then(() => appendFile(logPath, chunk));
    },
    flush() {
      return pending;
    },
  };
}

async function postgresPrograms(preferred?: string): Promise<{ initdb: string; postgres: string }> {
  const directories = [
    preferred,
    process.env.LUMERA_POSTGRES_16_BIN,
    "/usr/lib/postgresql/16/bin",
    "/usr/local/pgsql/bin",
  ].filter((value): value is string => Boolean(value));
  for (const directory of directories) {
    const initdb = path.join(directory, "initdb");
    const postgres = path.join(directory, "postgres");
    if (await commandAvailable(initdb) && await commandAvailable(postgres)) return { initdb, postgres };
  }
  // PATH lookup is intentionally a last resort for developer installations.
  return { initdb: "initdb", postgres: "postgres" };
}

async function run(program: string, args: readonly string[], logPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, [...args], { cwd: workspaceRoot, env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const writer = serialLogWriter(logPath);
    child.stdout?.on("data", (chunk: Buffer) => writer.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => writer.write(chunk));
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      try {
        await writer.flush();
        if (code === 0) resolve();
        else reject(new Error(`${path.basename(program)} failed (${signal ?? code ?? "unknown"}); inspect ${logPath}`));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function safeEnvironment(
  extra: NodeJS.ProcessEnv = {},
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: ambient.PATH,
    HOME: ambient.HOME ?? os.tmpdir(),
    LANG: "C.UTF-8",
    NODE_ENV: "test",
    // Preserve the workspace label: it is explicitly not a deployment marker.
    REPLIT_ENVIRONMENT: ambient.REPLIT_ENVIRONMENT,
    CI: ambient.CI ?? "true",
    ...extra,
  };
  for (const key of ambientDatabaseKeys) delete environment[key];
  return environment;
}

async function randomLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port || port === 5432) throw new Error("Could not allocate a non-default loopback port.");
  return port;
}

async function waitForPostgres(adminUrl: string, child: ChildProcess, startupLog: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Owned PostgreSQL exited during startup; inspect ${startupLog}`);
    }
    const client = new pg.Client({ connectionString: adminUrl, password: "", connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      const version = await client.query<{ server_version_num: string }>("SHOW server_version_num");
      if (!String(version.rows[0]?.server_version_num ?? "").startsWith("16")) {
        throw new Error(`Phase 5 integration requires PostgreSQL 16, got ${version.rows[0]?.server_version_num ?? "unknown"}.`);
      }
      await client.end();
      return;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (error instanceof Error && error.message.startsWith("Phase 5 integration requires")) throw error;
      await sleep(200);
    }
  }
  throw new Error(`Owned PostgreSQL did not accept connections within 30 seconds; inspect ${startupLog}`);
}

async function assertDatabaseLogging(adminUrl: string, sqlLog: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, password: "", connectionTimeoutMillis: 5_000 });
  const probe = `phase5_runner_log_probe_${randomBytes(6).toString("hex")}`;
  try {
    await client.connect();
    await client.query(`CREATE TABLE public."${probe}" (id integer)`);
    await client.query(`DROP TABLE public."${probe}"`);
  } finally {
    await client.end().catch(() => undefined);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const contents = await readFile(sqlLog, "utf8").catch(() => "");
    if (contents.includes("db=postgres") && contents.includes(probe)) return;
    await sleep(100);
  }
  throw new Error(`Owned PostgreSQL did not produce db-tagged SQL logging; inspect ${sqlLog}`);
}

async function stopPostgres(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", resolve)),
    sleep(10_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", resolve)),
      sleep(5_000),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Owned PostgreSQL did not stop after SIGTERM and SIGKILL.");
  }
}

async function verifyNoChildDatabases(adminUrl: string, initialDatabases: readonly string[]): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl, password: "", connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const databases = (await client.query<{ datname: string }>(
      "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname",
    )).rows.map((row) => row.datname);
    if (JSON.stringify(databases) !== JSON.stringify(initialDatabases)) {
      throw new Error(`Owned PostgreSQL still contains child databases: ${databases.filter((name) => !initialDatabases.includes(name)).join(", ") || "database set changed"}`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

function testSummary(output: string, logPath: string): Pick<Result, "tests" | "passed" | "skipped"> {
  const read = (name: string): number => {
    const match = new RegExp(`^(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, "mu").exec(output);
    if (!match) throw new Error(`Test output lacks a Node TAP/${name} summary; inspect ${logPath}`);
    return Number(match[1]);
  };
  const tests = read("tests");
  const passed = read("pass");
  const skipped = read("skipped");
  const failed = read("fail");
  if (tests === 0 || passed === 0 || skipped !== 0 || failed !== 0) {
    throw new Error(`Test output is not a complete passing proof (tests=${tests}, pass=${passed}, skipped=${skipped}, fail=${failed}); inspect ${logPath}`);
  }
  return { tests, passed, skipped };
}

async function stopTestProcess(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch (error: unknown) {
      if (!(error as NodeJS.ErrnoException).code || (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } else {
    child.kill(signal);
  }
}

async function runTestFile(
  suite: Suite,
  file: string,
  adminUrl: string,
  sqlLogPath: string,
  outputDir: string,
  timeoutMs: number,
  setActiveChild: (child: ChildProcess | undefined) => void,
): Promise<Result> {
  const safeName = `${suite.id}-${path.basename(file, ".ts")}`;
  const logPath = path.join(outputDir, `${safeName}.log`);
  const tsx = path.join(workspaceRoot, "scripts/node_modules/.bin/tsx");
  const args = [file, `--admin-url=${adminUrl}`];
  if (suite.id === "actual-entrypoint-boot" || suite.id === "startup-readiness-override") {
    args.push(`--sql-log=${sqlLogPath}`, `--evidence-dir=${outputDir}`);
  }
  const { exitCode, timedOut } = await new Promise<{ exitCode: number; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(tsx, args, {
      cwd: workspaceRoot,
      env: {
        ...safeEnvironment({ SESSION_SECRET: "lumera-phase5-disposable-test-session-secret" }),
        ...(suite.id === "phase4-migrations" ? {
          LUMERA_PHASE4_DISPOSABLE_DB: "1",
          LUMERA_PHASE4_DISPOSABLE_DATABASE_URL: adminUrl,
        } : {}),
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const writer = serialLogWriter(logPath);
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    setActiveChild(child);
    child.stdout?.on("data", (chunk: Buffer) => writer.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => writer.write(chunk));
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      setActiveChild(undefined);
      reject(error);
    });
    child.once("close", async (code) => {
      if (timeout) clearTimeout(timeout);
      setActiveChild(undefined);
      try {
        await writer.flush();
        resolve({ exitCode: code ?? 1, timedOut });
      } catch (error) {
        reject(error);
      }
    });
    timeout = setTimeout(() => {
      timedOut = true;
      void stopTestProcess(child).then(() => {
        setTimeout(() => void stopTestProcess(child, "SIGKILL").catch(reject), 5_000);
      }).catch(reject);
    }, timeoutMs);
  });
  if (timedOut) throw new Error(`Phase 5 suite timed out after ${timeoutMs}ms; inspect ${logPath}`);
  const summary = testSummary(await readFile(logPath, "utf8"), logPath);
  return { suite: suite.id, file, exitCode, logPath, ...summary };
}

export async function runPhase5Integration(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // This guard intentionally precedes even output-directory creation.
  assertSafeRuntime(environment);
  const parsed = parsePhase5IntegrationOptions(argv);
  const options = { ...parsed, outputDir: await validatedOutputDirectory(parsed.outputDir) };
  await mkdir(options.outputDir, { recursive: true });
  const outputProbe = path.join(options.outputDir, ".write-capability-probe");
  await writeFile(outputProbe, "ok\n");
  await rm(outputProbe);

  const manifestPath = path.join(options.outputDir, "phase5-integration-manifest.json");
  const initLog = path.join(options.outputDir, "postgres-init.log");
  const serverLog = path.join(options.outputDir, "postgres-server.log");
  const sqlLog = path.join(options.outputDir, "postgres-sql.log");
  const results: Result[] = [];
  let dataDir: string | undefined;
  let postgresChild: ChildProcess | undefined;
  let adminUrl: string | undefined;
  let initialDatabases: string[] = [];
  let failure: unknown;
  let ownedClusterRemoved = false;
  let activeTestChild: ChildProcess | undefined;
  let receivedSignal: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    receivedSignal ??= signal;
    const interruptedChild = activeTestChild;
    void stopTestProcess(interruptedChild).then(() => {
      setTimeout(() => void stopTestProcess(interruptedChild, "SIGKILL").catch(() => undefined), 5_000);
    }).catch(() => undefined);
    if (!interruptedChild) void stopPostgres(postgresChild).catch(() => undefined);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const programs = await postgresPrograms(options.postgresBin);
    dataDir = await mkdtemp(path.join(os.tmpdir(), "lumera-phase5-postgres16-"));
    await run(programs.initdb, ["--no-instructions", "--auth=trust", `--username=${owner}`, "--encoding=UTF8", "--locale=C", dataDir], initLog);
    const port = await randomLoopbackPort();
    adminUrl = `postgres://${owner}@127.0.0.1:${port}/postgres`;
    postgresChild = spawn(programs.postgres, [
      "-D", dataDir,
      "-h", "127.0.0.1",
      "-p", String(port),
      // Packaged PostgreSQL may default to a nonexistent /run/postgresql.
      // Socket files must belong to this disposable cluster as well.
      "-k", dataDir,
      "-c", "logging_collector=on",
      "-c", `log_directory=${options.outputDir}`,
      "-c", "log_filename=postgres-sql.log",
      "-c", "log_statement=ddl",
      "-c", "log_min_messages=log",
      "-c", "log_line_prefix=db=%d user=%u pid=%p ",
    ], { cwd: workspaceRoot, env: safeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    postgresChild.stdout?.on("data", (chunk: Buffer) => void appendFile(serverLog, chunk));
    postgresChild.stderr?.on("data", (chunk: Buffer) => void appendFile(serverLog, chunk));
    await waitForPostgres(adminUrl, postgresChild, serverLog);
    if (receivedSignal) throw new Error(`Phase 5 integration interrupted by ${receivedSignal}.`);
    await assertDatabaseLogging(adminUrl, sqlLog);
    if (receivedSignal) throw new Error(`Phase 5 integration interrupted by ${receivedSignal}.`);
    const client = new pg.Client({ connectionString: adminUrl, password: "" });
    await client.connect();
    initialDatabases = (await client.query<{ datname: string }>(
      "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname",
    )).rows.map((row) => row.datname);
    await client.end();

    for (const suite of options.suites) {
      for (const file of suite.files) {
        const result = await runTestFile(
          suite,
          file,
          adminUrl,
          sqlLog,
          options.outputDir,
          options.testTimeoutMs,
          (child) => { activeTestChild = child; },
        );
        results.push(result);
        if (receivedSignal) throw new Error(`Phase 5 integration interrupted by ${receivedSignal}.`);
        if (result.exitCode !== 0) throw new Error(`Phase 5 suite ${suite.id} failed; inspect ${result.logPath}`);
      }
    }
    await verifyNoChildDatabases(adminUrl, initialDatabases);
  } catch (error) {
    failure = error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const cleanupErrors: unknown[] = [];
    if (adminUrl && initialDatabases.length > 0) {
      try {
        await verifyNoChildDatabases(adminUrl, initialDatabases);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await stopPostgres(postgresChild);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (dataDir) {
      try {
        await rm(dataDir, { recursive: true, force: true });
        ownedClusterRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      postgres: { major: 16, host: "127.0.0.1", nonDefaultPort: true, ownedClusterRemoved },
      selectedSuites: options.suites.map((suite) => ({ id: suite.id, declaredTests: suite.declaredTests, files: suite.files })),
      results,
      logs: { initLog, serverLog, sqlLog },
      status: failure || cleanupErrors.length ? "failed" : "passed",
      error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
      cleanupErrors: cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Phase 5 integration manifest: ${manifestPath}\n`);
    if (cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors].filter(Boolean), "Phase 5 integration cleanup failed");
  }
  if (failure) throw failure;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPhase5Integration();
}