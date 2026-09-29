import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDatabaseMigrationReady,
  assertReadOnlyMigrationQuery,
  inspectDatabaseMigrationReady,
  migrationReadinessContract,
  type MigrationDatabasePool,
} from "./index";

test("migration readiness exposes immutable repository pins", () => {
  assert.deepEqual(migrationReadinessContract.requiredMigrationIds, ["000001", "000002", "000003", "000004"]);
  assert.notEqual(migrationReadinessContract.headStructuralFingerprint, migrationReadinessContract.structuralFingerprint);
  assert.notEqual(migrationReadinessContract.headPhysicalFingerprint, migrationReadinessContract.physicalFingerprint);
  assert.equal(
    migrationReadinessContract.baselineChecksum,
    "643a649989c3658c96ae16d90c003eeeeee542f76d94cb3a8b00f6328002fc60",
  );
  assert.equal(
    migrationReadinessContract.supportedStartupMigrationChecksum,
    "a8c910eb9bd60281aa80e343b4b1d6e02a45222293b123ab198fab4315d48e62",
  );
  assert.equal(
    migrationReadinessContract.structuralFingerprint,
    "938c62183adabae9fdab00c5d968c39feb3f216e521b9031d1642575f5875cad",
  );
  assert.equal(
    migrationReadinessContract.physicalFingerprint,
    "673f3810d49a4be6899482d44281607dac06d3e1012cd001e8348a45fdf5ea1f",
  );
  assert.throws(() => assertReadOnlyMigrationQuery("UPDATE public.users SET role = 'ADMIN'"));
  assert.doesNotThrow(() => assertReadOnlyMigrationQuery("SELECT 1"));
});

test("readiness returns a safe failure and does not create a ledger", async () => {
  const queries: string[] = [];
  let directConnectCalls = 0;
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("migration_id, checksum")) {
        const error = new Error("missing relation") as Error & { code: string };
        error.code = "42P01";
        throw error;
      }
      return { rows: [] };
    },
    connect() {
      directConnectCalls += 1;
      throw new Error("direct pg client must not be connected again");
    },
  };
  const report = await inspectDatabaseMigrationReady(client);
  assert.equal(report.ready, false);
  assert.equal(report.reason, "MIGRATION_READINESS_LEDGER_MISSING");
  assert.equal(directConnectCalls, 0);
  assert.equal(queries.some((query) => /\b(?:CREATE|INSERT|UPDATE|ALTER)\b/i.test(query)), false);
});

const headLedgerRow = {
  migration_id: "000004",
  checksum: migrationReadinessContract.jobPublicationMigrationChecksum,
  mode: "transactional",
  state: "APPLIED",
  error: null,
  started_at: "2026-01-01T00:00:04Z",
  finished_at: "2026-01-01T00:00:05Z",
};

const localTargetIdentity = async () => ({
  databaseName: "fixture",
  systemIdentifier: "123",
  transport: "unencrypted" as const,
});

test("readiness leases one dedicated pool client and releases it", async () => {
  const queries: string[] = [];
  let released = 0;
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("migration_id, checksum")) {
        return {
          rows: [
            {
              migration_id: "000001",
              checksum: migrationReadinessContract.baselineChecksum,
              mode: "transactional",
              state: "APPLIED",
              error: null,
              started_at: "2026-01-01T00:00:00Z",
              finished_at: "2026-01-01T00:00:01Z",
            },
            {
              migration_id: "000002",
              checksum: migrationReadinessContract.supportedStartupMigrationChecksum,
              mode: "transactional",
              state: "APPLIED",
              error: null,
              started_at: "2026-01-01T00:00:02Z",
              finished_at: "2026-01-01T00:00:03Z",
            },
            { ...headLedgerRow, migration_id: "000003", checksum: migrationReadinessContract.salonEntranceMigrationChecksum },
            headLedgerRow,
          ],
        };
      }
      return { rows: [] };
    },
    release() {
      released += 1;
    },
  };
  let poolQueries = 0;
  const pool = {
      async connect() {
        return client;
      },
      query() {
        poolQueries += 1;
        return Promise.resolve({ rows: [] });
      },
    } as unknown as MigrationDatabasePool;
  const report = await assertDatabaseMigrationReady(
    pool,
    async () => ({
      structuralFingerprint: migrationReadinessContract.headStructuralFingerprint,
      physicalFingerprint: migrationReadinessContract.headPhysicalFingerprint,
      formatVersion: 2,
      fingerprintVersion: 4,
      schemaFormatVersion: 1,
      postgresServerMajorVersion: 16,
      postgresServerVersionNum: 160010,
      postgresDeparserFormat: "postgresql-16-deparser-v1",
      normalizedObjectCount: migrationReadinessContract.headNormalizedObjectCount,
      enumCount: 103,
      triggerCount: 24,
      functionCount: 21,
    }),
    localTargetIdentity,
  );
  assert.equal(report.ready, true);
  assert.equal(released, 1);
  assert.equal(poolQueries, 0);
  assert.equal(queries.at(-1), "ROLLBACK");
});

function canonicalCatalogIdentity(postgresServerVersionNum: number) {
  return {
    structuralFingerprint: migrationReadinessContract.headStructuralFingerprint,
    physicalFingerprint: migrationReadinessContract.headPhysicalFingerprint,
    formatVersion: 2,
    fingerprintVersion: 4,
    schemaFormatVersion: 1,
    postgresServerMajorVersion: 16,
    postgresServerVersionNum,
    postgresDeparserFormat: "postgresql-16-deparser-v1",
    normalizedObjectCount: migrationReadinessContract.headNormalizedObjectCount,
    enumCount: 103,
    triggerCount: 24,
    functionCount: 21,
  };
}

test("readiness admits reviewed PostgreSQL 16 patch releases with identical catalog metadata", async () => {
  for (const postgresServerVersionNum of [160010, 160011, 160012]) {
    const client = {
      async query(sql: string) {
        if (sql.includes("migration_id, checksum")) {
          return {
            rows: [
              {
                migration_id: "000001",
                checksum: migrationReadinessContract.baselineChecksum,
                mode: "transactional",
                state: "APPLIED",
                error: null,
                started_at: "2026-01-01T00:00:00Z",
                finished_at: "2026-01-01T00:00:01Z",
              },
              {
                migration_id: "000002",
                checksum: migrationReadinessContract.supportedStartupMigrationChecksum,
                mode: "transactional",
                state: "APPLIED",
                error: null,
                started_at: "2026-01-01T00:00:02Z",
                finished_at: "2026-01-01T00:00:03Z",
              },
              { ...headLedgerRow, migration_id: "000003", checksum: migrationReadinessContract.salonEntranceMigrationChecksum },
              headLedgerRow,
            ],
          };
        }
        return { rows: [] };
      },
    };
    const report = await inspectDatabaseMigrationReady(
      client,
      async () => canonicalCatalogIdentity(postgresServerVersionNum),
      localTargetIdentity,
    );
    assert.deepEqual(report, {
      ready: true,
      reason: null,
      migrationIds: ["000001", "000002", "000003", "000004"],
      ledger: "VALID",
      catalog: "CANONICAL",
    });
  }
});

test("readiness rejects schema drift and unsupported PostgreSQL majors", async () => {
  // Only a schema fingerprint difference reports CATALOG_DRIFT; server family
  // and fingerprint algorithm mismatches have their own non-overridable codes.
  for (const [identity, reason, catalog] of [
    [{
      ...canonicalCatalogIdentity(160010),
      structuralFingerprint: migrationReadinessContract.structuralFingerprint,
      physicalFingerprint: migrationReadinessContract.physicalFingerprint,
      normalizedObjectCount: 5060,
    }, "MIGRATION_READINESS_CATALOG_DRIFT", "DRIFTED"],
    [{
      ...canonicalCatalogIdentity(160011),
      structuralFingerprint: "schema-drift",
    }, "MIGRATION_READINESS_CATALOG_DRIFT", "DRIFTED"],
    [{
      ...canonicalCatalogIdentity(150010),
      postgresServerMajorVersion: 15,
      postgresDeparserFormat: "postgresql-15-deparser-v1",
    }, "MIGRATION_READINESS_POSTGRES_FAMILY", "UNKNOWN"],
    [{
      ...canonicalCatalogIdentity(170002),
      postgresServerMajorVersion: 17,
      structuralFingerprint: "schema-drift",
    }, "MIGRATION_READINESS_POSTGRES_FAMILY", "UNKNOWN"],
    [{
      ...canonicalCatalogIdentity(160010),
      fingerprintVersion: 5,
    }, "MIGRATION_READINESS_FINGERPRINT_FORMAT", "UNKNOWN"],
  ] as const) {
    const client = {
      async query(sql: string) {
        if (sql.includes("migration_id, checksum")) {
          return {
            rows: [
              {
                migration_id: "000001",
                checksum: migrationReadinessContract.baselineChecksum,
                mode: "transactional",
                state: "APPLIED",
                error: null,
                started_at: "2026-01-01T00:00:00Z",
                finished_at: "2026-01-01T00:00:01Z",
              },
              {
                migration_id: "000002",
                checksum: migrationReadinessContract.supportedStartupMigrationChecksum,
                mode: "transactional",
                state: "APPLIED",
                error: null,
                started_at: "2026-01-01T00:00:02Z",
                finished_at: "2026-01-01T00:00:03Z",
              },
              { ...headLedgerRow, migration_id: "000003", checksum: migrationReadinessContract.salonEntranceMigrationChecksum },
              headLedgerRow,
            ],
          };
        }
        return { rows: [] };
      },
    };
    const report = await inspectDatabaseMigrationReady(client, async () => identity, localTargetIdentity);
    assert.equal(report.ready, false);
    assert.equal(report.reason, reason);
    assert.equal(report.catalog, catalog);
  }
  for (const state of ["ADOPTED", "UNKNOWN"]) {
    let catalogReads = 0;
    const client = {
      async query(sql: string) {
        return { rows: sql.includes("migration_id, checksum") ? [
          { ...headLedgerRow, migration_id: "000001", checksum: migrationReadinessContract.baselineChecksum },
          { ...headLedgerRow, migration_id: "000002", checksum: migrationReadinessContract.supportedStartupMigrationChecksum },
          { ...headLedgerRow, migration_id: "000003", checksum: migrationReadinessContract.salonEntranceMigrationChecksum },
          { ...headLedgerRow, state },
        ] : [] };
      },
    };
    const report = await inspectDatabaseMigrationReady(client, async () => {
      catalogReads += 1;
      return canonicalCatalogIdentity(160010);
    }, localTargetIdentity);
    assert.equal(report.ready, false, `000004 ${state} must not satisfy readiness`);
    assert.equal(catalogReads, 0, "invalid receipt must refuse before the catalog reader");
  }
});