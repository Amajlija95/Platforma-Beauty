import assert from "node:assert/strict";
import test from "node:test";
import {
  admitDatabaseMigrationStartup,
  evaluateStartupReadinessOverride,
  STARTUP_READINESS_OVERRIDE_VARIABLE,
} from "./startup-admission";
import { DatabaseMigrationReadinessError, type MigrationDatabasePool } from "./readiness";

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
    [`${DRIFT}@2026-09-29T18:00:00Z`, "MIGRATION_READINESS_LEDGER_FRONTIER", "reason-mismatch"],
    [`MIGRATION_READINESS_INCOMPLETE_LEDGER:000003@2026-09-29T18:00:00Z`, "MIGRATION_READINESS_INCOMPLETE_LEDGER:000004", "reason-mismatch"],
    [`MIGRATION_READINESS_INCOMPLETE_LEDGER:000003@2026-09-29T18:00:00Z`, "MIGRATION_READINESS_INCOMPLETE_LEDGER:000003", "granted"],
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

// Readiness reports a thrown MIGRATION_READINESS_* message as its reason, so a
// client that fails its first query drives the real readiness code path.
function pool(result: "drift" | "connect-failure"): MigrationDatabasePool {
  return {
    async connect() {
      if (result === "connect-failure") throw new Error("connect ECONNREFUSED");
      return {
        async query() {
          throw new Error(DRIFT);
        },
        release() {},
      };
    },
  };
}

function admit(result: "drift" | "connect-failure", environment: NodeJS.ProcessEnv) {
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
