import type { MigrationDatabaseClient } from "./database-client";
import { pinMigrationFingerprintEnvironment } from "./fingerprint-transaction";
import { readOnlyMigrationClient } from "./read-only-query";
import {
  readPostgresFingerprintCompatibility,
  readPostgresSnapshot,
} from "./catalog";
import { fingerprintSnapshot } from "./fingerprint";
import { ownershipExceptions } from "./ownership";
import { assertPublicOnlyNamespaces, NON_PUBLIC_NAMESPACE_REASON } from "./namespaces";
import { POSTGRES_DEPARSE_FORMAT, SUPPORTED_POSTGRES_MAJOR_VERSIONS } from "./model";
import {
  ledgerIdentityFromTarget,
  ledgerIdentityMismatch,
  parseLedgerIdentity,
  readDatabaseTargetIdentity,
  type DatabaseTargetIdentity,
} from "./ledger-identity";

const BASELINE_CHECKSUM = "643a649989c3658c96ae16d90c003eeeeee542f76d94cb3a8b00f6328002fc60";
const SUPPORTED_STARTUP_MIGRATION_CHECKSUM =
  "a8c910eb9bd60281aa80e343b4b1d6e02a45222293b123ab198fab4315d48e62";
const BASELINE_STRUCTURAL = "938c62183adabae9fdab00c5d968c39feb3f216e521b9031d1642575f5875cad";
const BASELINE_PHYSICAL = "673f3810d49a4be6899482d44281607dac06d3e1012cd001e8348a45fdf5ea1f";
// Baseline pins above remain the immutable catalog after 000001.
// Readiness instead requires the catalog after the entire required frontier.
const HEAD_STRUCTURAL = "805c6d8d8a375ffd842b92ce018073627a9f82fe40d81537ceed1494f913f7e9";
const HEAD_PHYSICAL = "60400deed8e8d3521ebf2af5c2e3ae2c491be8dffa0dd654c644fe44930bf3ce";
const SALON_ENTRANCE_MIGRATION_CHECKSUM = "9bc21ec9bb74182314b498a91c606445d6564d7b070da4f04a22a43b195395c5";
const JOB_PUBLICATION_MIGRATION_CHECKSUM = "0e2e866fe285d43fb7a8b5508cb60c44df4e7d333961247c31879f2f2cd91083";
const REVIEWED_POSTGRES_MAJOR_VERSION = 16;

export interface DatabaseMigrationReadiness {
  readonly ready: boolean;
  readonly reason: string | null;
  readonly migrationIds: readonly string[];
  readonly ledger: "MISSING" | "VALID" | "INVALID";
  readonly catalog: "CANONICAL" | "DRIFTED" | "UNKNOWN";
}

export class DatabaseMigrationReadinessError extends Error {
  readonly report: DatabaseMigrationReadiness;

  constructor(report: DatabaseMigrationReadiness) {
    super(report.reason ?? "MIGRATION_READINESS_FAILED");
    this.name = "DatabaseMigrationReadinessError";
    this.report = report;
  }
}

export interface MigrationDatabasePool {
  connect(): Promise<MigrationDatabaseClient & { release(): void }>;
}

export interface CatalogIdentity {
  structuralFingerprint: string;
  physicalFingerprint: string;
  formatVersion: number;
  fingerprintVersion: number;
  schemaFormatVersion: number;
  postgresServerMajorVersion: number;
  postgresServerVersionNum: number;
  postgresDeparserFormat: string;
  normalizedObjectCount: number;
  enumCount: number;
  triggerCount: number;
  functionCount: number;
}

export type CatalogIdentityReader = (client: MigrationDatabaseClient) => Promise<CatalogIdentity>;
export type DatabaseTargetIdentityReader =
  (client: MigrationDatabaseClient) => Promise<DatabaseTargetIdentity>;

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

function isMissingRelation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "42P01";
}

/**
 * Read-only pre-listen gate for the API entry point.
 *
 * It does not create the ledger, run migrations, inspect tenant data, or
 * acknowledge baseline adoption. The caller owns this already-connected client;
 * the strict pool entrypoint below is responsible for leasing and releasing.
 */
export async function inspectDatabaseMigrationReady(
  client: MigrationDatabaseClient,
  injectedReader?: CatalogIdentityReader,
  injectedTargetIdentityReader?: DatabaseTargetIdentityReader,
): Promise<DatabaseMigrationReadiness> {
  const readCatalogIdentity = injectedReader ?? defaultCatalogIdentity;
  const readTargetIdentity = injectedTargetIdentityReader ?? readDatabaseTargetIdentity;
  let transactionStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionStarted = true;
    await pinMigrationFingerprintEnvironment(client);
    const readOnly = readOnlyMigrationClient(client);
    await assertPublicOnlyNamespaces(readOnly);
    const result = await readOnly.query(`
      SELECT pg_catalog.to_jsonb(ledger) AS ledger_row /* migration_id, checksum */
      FROM public.lumera_migration_ledger AS ledger
      ORDER BY migration_id
    `);
    const rows = result.rows.map(row => {
      const value = row.ledger_row ?? row;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("MIGRATION_READINESS_INVALID_LEDGER:unknown");
      }
      return value as Record<string, unknown>;
    });
    const targetIdentity = ledgerIdentityFromTarget(await readTargetIdentity(readOnly));
    const expected = new Map([
      ["000001", { checksum: BASELINE_CHECKSUM, mode: "transactional" }],
      ["000002", { checksum: SUPPORTED_STARTUP_MIGRATION_CHECKSUM, mode: "transactional" }],
      ["000003", { checksum: SALON_ENTRANCE_MIGRATION_CHECKSUM, mode: "transactional" }],
      ["000004", { checksum: JOB_PUBLICATION_MIGRATION_CHECKSUM, mode: "transactional" }],
    ]);
    const seen = new Set<string>();
    for (const row of rows) {
      const id = text(row.migration_id);
      const contract = expected.get(id);
      if (!contract || seen.has(id)) {
        throw new Error(`MIGRATION_READINESS_INVALID_LEDGER:${id}`);
      }
      seen.add(id);
      if (text(row.checksum) !== contract.checksum || text(row.mode) !== contract.mode) {
        throw new Error(`MIGRATION_READINESS_LEDGER_METADATA:${id}`);
      }
      const state = text(row.state);
      const startedAt = timestampMilliseconds(row.started_at);
      const finishedAt = timestampMilliseconds(row.finished_at);
      if (startedAt === null || finishedAt === null || finishedAt < startedAt) {
        throw new Error(`MIGRATION_READINESS_LEDGER_TIMESTAMPS:${id}`);
      }
      if ((id === "000001" && state !== "APPLIED" && state !== "ADOPTED")
        || (id !== "000001" && state !== "APPLIED")
        || state === "APPLYING" || state === "FAILED" || row.error != null) {
        throw new Error(`MIGRATION_READINESS_INCOMPLETE_LEDGER:${id}`);
      }
      const ledgerIdentity = parseLedgerIdentity({
        database_name: row.database_name,
        system_identifier: row.system_identifier,
        neon_project_id: row.neon_project_id,
        neon_branch_id: row.neon_branch_id,
      });
      if (ledgerIdentity.kind === "partial") {
        throw new Error(`MIGRATION_READINESS_LEDGER_IDENTITY_PARTIAL:${id}:${ledgerIdentity.component}`);
      }
      if (ledgerIdentity.kind === "unbound") {
        if (isDeploymentRuntime(process.env)) {
          throw new Error(`MIGRATION_READINESS_LEDGER_IDENTITY_UNBOUND:${id}:databaseName`);
        }
      } else {
        const component = ledgerIdentityMismatch(ledgerIdentity.identity, targetIdentity);
        if (component) {
          throw new Error(`MIGRATION_READINESS_LEDGER_IDENTITY_MISMATCH:${id}:${component}`);
        }
      }
    }
    if ([...expected.keys()].some(id => !seen.has(id))) throw new Error("MIGRATION_READINESS_LEDGER_FRONTIER");
    const identity = await readCatalogIdentity(readOnly);
    // Server family and fingerprint algorithm are checked before the schema
    // fingerprint so that only a genuine schema difference reports
    // CATALOG_DRIFT (the one reason the startup override may name).
    if (!isReviewedPostgresPatch(identity)) {
      throw new Error("MIGRATION_READINESS_POSTGRES_FAMILY");
    }
    if (!matchesFingerprintFormat(identity)) {
      throw new Error("MIGRATION_READINESS_FINGERPRINT_FORMAT");
    }
    if (!matchesCanonicalCatalog(identity)) {
      throw new Error("MIGRATION_READINESS_CATALOG_DRIFT");
    }
    await client.query("ROLLBACK");
    return {
      ready: true,
      reason: null,
      migrationIds: ["000001", "000002", "000003", "000004"],
      ledger: "VALID",
      catalog: "CANONICAL",
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    const code = error instanceof Error && error.message === NON_PUBLIC_NAMESPACE_REASON
      ? "MIGRATION_READINESS_NON_PUBLIC_NAMESPACE"
      : isMissingRelation(error)
      ? "MIGRATION_READINESS_LEDGER_MISSING"
      : error instanceof Error && /^MIGRATION_READINESS_[A-Z0-9_]+(?::[A-Za-z0-9_.-]+)*$/u.test(error.message)
      ? error.message
      : "MIGRATION_READINESS_READ_FAILED";
    return {
      ready: false,
      reason: code,
      migrationIds: [],
      ledger: code === "MIGRATION_READINESS_LEDGER_MISSING" ? "MISSING"
        : code.includes("LEDGER") ? "INVALID" : "MISSING",
      catalog: code === "MIGRATION_READINESS_CATALOG_DRIFT" ? "DRIFTED" : "UNKNOWN",
    };
  }
}

/**
 * Strict API-entrypoint assertion. Unlike the inspection helper, this cannot
 * accidentally allow boot to continue after a failed readiness check.
 */
export async function assertDatabaseMigrationReady(
  pool: MigrationDatabasePool,
  injectedReader?: CatalogIdentityReader,
  injectedTargetIdentityReader?: DatabaseTargetIdentityReader,
): Promise<DatabaseMigrationReadiness> {
  const client = await pool.connect();
  try {
    const report = await inspectDatabaseMigrationReady(client, injectedReader, injectedTargetIdentityReader);
    if (!report.ready) throw new DatabaseMigrationReadinessError(report);
    return report;
  } finally {
    try {
      client.release();
    } catch {
      // Preserve the readiness/query error; release is best-effort cleanup.
    }
  }
}

export function isDeploymentRuntime(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV === "production"
    || /^(?:1|true)$/iu.test(environment.REPLIT_DEPLOYMENT ?? "")
    || /^(?:1|true)$/iu.test(environment.REPL_DEPLOYMENT ?? "")
    || environment.REPLIT_DEPLOYMENT_ID !== undefined
    || environment.REPL_DEPLOYMENT_ID !== undefined;
}

async function defaultCatalogIdentity(
  client: MigrationDatabaseClient,
): Promise<CatalogIdentity> {
  const readOnly = readOnlyMigrationClient(client);
  const compatibility = await readPostgresFingerprintCompatibility(readOnly);
  const snapshot = await readPostgresSnapshot(readOnly);
  const fingerprint = fingerprintSnapshot(snapshot, ownershipExceptions, compatibility);
  return {
    structuralFingerprint: fingerprint.structuralFingerprint,
    physicalFingerprint: fingerprint.physicalFingerprint,
    formatVersion: fingerprint.formatVersion,
    fingerprintVersion: fingerprint.fingerprintVersion,
    schemaFormatVersion: fingerprint.schemaFormatVersion,
    postgresServerMajorVersion: fingerprint.postgresCompatibility.serverMajorVersion,
    postgresServerVersionNum: fingerprint.postgresCompatibility.serverVersionNum,
    postgresDeparserFormat: fingerprint.postgresCompatibility.deparserFormat,
    normalizedObjectCount: fingerprint.normalizedObjectCount,
    enumCount: fingerprint.enumCount,
    triggerCount: fingerprint.triggerCount,
    functionCount: fingerprint.functionCount,
  };
}

function timestampMilliseconds(value: unknown): number | null {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function matchesFingerprintFormat(identity: CatalogIdentity): boolean {
  return identity.formatVersion === 2
    && identity.fingerprintVersion === 4
    && identity.schemaFormatVersion === 1;
}

function matchesCanonicalCatalog(identity: CatalogIdentity): boolean {
  return identity.structuralFingerprint === HEAD_STRUCTURAL
    && identity.physicalFingerprint === HEAD_PHYSICAL
    && matchesFingerprintFormat(identity)
    && isReviewedPostgresPatch(identity)
    && identity.normalizedObjectCount === 5065
    && identity.enumCount === 103
    && identity.triggerCount === 24
    && identity.functionCount === 21;
}

/**
 * The migration fingerprints were reviewed against PostgreSQL 16.10. Runtime
 * patch admission may use another member of the reviewed major/deparser family,
 * but only after every catalog fingerprint and metadata check below matches.
 * The original 16.10 manifest metadata remains immutable.
 */
export function isReviewedPostgresPatch(
  identity: Pick<CatalogIdentity, "postgresServerMajorVersion" | "postgresServerVersionNum"
    | "postgresDeparserFormat">,
  expectedMajor = REVIEWED_POSTGRES_MAJOR_VERSION,
): boolean {
  return identity.postgresServerMajorVersion === expectedMajor
    && (SUPPORTED_POSTGRES_MAJOR_VERSIONS as readonly number[]).includes(
      identity.postgresServerMajorVersion,
    )
    && Number.isInteger(identity.postgresServerVersionNum)
    && Math.floor(identity.postgresServerVersionNum / 10000)
      === identity.postgresServerMajorVersion
    && identity.postgresDeparserFormat === POSTGRES_DEPARSE_FORMAT;
}

export const migrationReadinessContract = Object.freeze({
  baselineChecksum: BASELINE_CHECKSUM,
  supportedStartupMigrationChecksum: SUPPORTED_STARTUP_MIGRATION_CHECKSUM,
  structuralFingerprint: BASELINE_STRUCTURAL,
  physicalFingerprint: BASELINE_PHYSICAL,
  headStructuralFingerprint: HEAD_STRUCTURAL,
  headPhysicalFingerprint: HEAD_PHYSICAL,
  headNormalizedObjectCount: 5065,
  salonEntranceMigrationChecksum: SALON_ENTRANCE_MIGRATION_CHECKSUM,
  jobPublicationMigrationChecksum: JOB_PUBLICATION_MIGRATION_CHECKSUM,
  requiredMigrationIds: ["000001", "000002", "000003", "000004"] as const,
});
