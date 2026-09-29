import assert from "node:assert/strict";
import test from "node:test";
import {
  admitDatabaseMigrationStartup,
  evaluateStartupReadinessOverride,
  STARTUP_READINESS_OVERRIDABLE_REASONS,
  STARTUP_READINESS_OVERRIDE_VARIABLE,
} from "./startup-admission";
import { DatabaseMigrationReadinessError, type MigrationDatabasePool } from "./readiness";
import { NON_PUBLIC_NAMESPACE_REASON } from "./namespaces";

const DRIFT = "MIGRATION_READINESS_CATALOG_DRIFT";
const now = new Date("2026-09-29T12:00:00Z");

test("override outcomes follow reason, expiry and format", () => {
  const cases: Array<[string | undefined, string | null, string]> = [
    [undefined, DRIFT, "absent"],
    ["  ", DRIFT, "absent"],
    [`${DRIFT}@2026-09-30T12:00:00Z`, DRIFT, "granted"],
    [`${DRIFT}@2026-09-30T12:00Z`, DRIFT, "granted"],
    [`${DRIFT}@2026-09-30T12:00:01Z`, DRIFT, "too-long"],
    [`${DRIFT}@2026-09-29T12:00:00Z`, DRIFT, "expired"],
    [`${DRIFT}@2026-09-28T12:00:00Z`, DRIFT, "expired"],
    [`${DRIFT}@2026-09-29T18:00:00Z`, "MIGRATION_READINESS_LEDGER_FRONTIER", "not-overridable"],
    [`MIGRATION_READINESS_INCOMPLETE_LEDGER:000003@2026-09-29T18:00:00Z`, "MIGRATION_READINESS_INCOMPLETE_LEDGER:000003", "not-overridable"],
    [`MIGRATION_READINESS_READ_FAILED@2026-09-29T18:00:00Z`, "MIGRATION_READINESS_READ_FAILED", "not-overridable"],
    [`MIGRATION_READINESS_READ_FAILED@2026-09-29T18:00:00Z`, DRIFT, "reason-mismatch"],
    [`${DRIFT}@2026-09-29T18:00:00Z`, "MIGRATION_READINESS_LEDGER_MISSING", "not-overridable"],
    [`${DRIFT}@2026-09-28T12:00:00Z`, "MIGRATION_READINESS_POSTGRES_FAMILY", "not-overridable"],
    [`${DRIFT}@2026-09-29T18:00:00`, DRIFT, "malformed"],
    [`${DRIFT}@2026-09-29T18:00:00+02:00`, DRIFT, "malformed"],
    [`${DRIFT}@2026-09-29`, DRIFT, "malformed"],
    [`${DRIFT}@1759154400`, DRIFT, "malformed"],
    [`${DRIFT}@2026-02-30T10:00:00Z`, DRIFT, "malformed"],
    [`catalog_drift@2026-09-29T18:00:00Z`, DRIFT, "malformed"],
    [`${DRIFT}`, DRIFT, "malformed"],
    [`${DRIFT}@2026-09-29T18:00:00Z@x`, DRIFT, "malformed"],
    [`${DRIFT}@2026-09-29T18:00:00Z`, null, "unused"],
    ["garbage", null, "malformed"],
  ];
  for (const [raw, reason, expected] of cases) {
    assert.equal(evaluateStartupReadinessOverride(raw, reason, now).outcome, expected, `${raw} vs ${reason}`);
  }
});

// Readiness reports a thrown MIGRATION_READINESS_* message as its reason (and
// any other error as READ_FAILED), so a client that fails its first query
// drives the real readiness code path.
function pool(result: "drift" | "connect-failure" | Error): MigrationDatabasePool {
  return {
    async connect() {
      if (result === "connect-failure") throw new Error("connect ECONNREFUSED");
      return {
        async query() {
          throw result === "drift" ? new Error(DRIFT) : result;
        },
        release() {},
      };
    },
  };
}

function admit(result: "drift" | "connect-failure" | Error, environment: NodeJS.ProcessEnv) {
  return admitDatabaseMigrationStartup(pool(result), environment, () => now);
}

test("non-production ignores the override entirely", async () => {
  await assert.rejects(
    admit("drift", { NODE_ENV: "development", [STARTUP_READINESS_OVERRIDE_VARIABLE]: `${DRIFT}@2026-09-29T18:00:00Z` }),
    (error: unknown) => error instanceof DatabaseMigrationReadinessError && error.message === DRIFT,
  );
});

test("production grants only the exact current reason with a valid expiry", async () => {
  const admission = await admit("drift", {
    NODE_ENV: "production",
    [STARTUP_READINESS_OVERRIDE_VARIABLE]: `${DRIFT}@2026-09-29T18:00:00Z`,
  });
  assert.deepEqual(admission, {
    mode: "readiness-override",
    reason: DRIFT,
    expiresAt: new Date("2026-09-29T18:00:00Z"),
  });
});

test("production refuses without, or with a non-matching, override", async () => {
  await assert.rejects(admit("drift", { NODE_ENV: "production" }), { message: DRIFT });
  await assert.rejects(
    admit("drift", {
      NODE_ENV: "production",
      [STARTUP_READINESS_OVERRIDE_VARIABLE]: "MIGRATION_READINESS_LEDGER_FRONTIER@2026-09-29T18:00:00Z",
    }),
    { message: `${DRIFT} (STARTUP_READINESS_OVERRIDE_REJECTED:reason-mismatch)` },
  );
  await assert.rejects(
    admit("drift", { REPLIT_DEPLOYMENT: "1", [STARTUP_READINESS_OVERRIDE_VARIABLE]: `${DRIFT}@2026-09-30T13:00:00Z` }),
    { message: `${DRIFT} (STARTUP_READINESS_OVERRIDE_REJECTED:too-long)` },
  );
});

test("errors without a readiness reason are never overridable", async () => {
  await assert.rejects(
    admit("connect-failure", {
      NODE_ENV: "production",
      [STARTUP_READINESS_OVERRIDE_VARIABLE]: "MIGRATION_READINESS_READ_FAILED@2026-09-29T18:00:00Z",
    }),
    { message: "connect ECONNREFUSED" },
  );
});

test("only catalog drift is overridable; every other reason is refused even when named", async () => {
  const notOverridable = (reason: string) =>
    `${reason} (STARTUP_READINESS_OVERRIDE_REJECTED:not-overridable; only ${DRIFT} can be overridden)`;
  const failures: Array<[string, Error]> = [
    ["MIGRATION_READINESS_READ_FAILED", new Error("Connection terminated unexpectedly")],
    ["MIGRATION_READINESS_LEDGER_MISSING", Object.assign(new Error("relation does not exist"), { code: "42P01" })],
    ["MIGRATION_READINESS_NON_PUBLIC_NAMESPACE", new Error(NON_PUBLIC_NAMESPACE_REASON)],
    ["MIGRATION_READINESS_LEDGER_IDENTITY_MISMATCH:000001:databaseName",
      new Error("MIGRATION_READINESS_LEDGER_IDENTITY_MISMATCH:000001:databaseName")],
    ["MIGRATION_READINESS_INCOMPLETE_LEDGER:000003", new Error("MIGRATION_READINESS_INCOMPLETE_LEDGER:000003")],
    ["MIGRATION_READINESS_POSTGRES_FAMILY", new Error("MIGRATION_READINESS_POSTGRES_FAMILY")],
    ["MIGRATION_READINESS_FINGERPRINT_FORMAT", new Error("MIGRATION_READINESS_FINGERPRINT_FORMAT")],
  ];
  for (const [reason, failure] of failures) {
    await assert.rejects(admit(failure, { NODE_ENV: "production" }), { message: reason });
    for (const named of [reason, DRIFT]) {
      await assert.rejects(
        admit(failure, { NODE_ENV: "production", [STARTUP_READINESS_OVERRIDE_VARIABLE]: `${named}@2026-09-29T18:00:00Z` }),
        { message: notOverridable(reason) },
        `${reason} named as ${named}`,
      );
    }
  }
  assert.deepEqual(STARTUP_READINESS_OVERRIDABLE_REASONS, [DRIFT]);
});
