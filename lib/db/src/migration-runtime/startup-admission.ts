import {
  assertDatabaseMigrationReady,
  DatabaseMigrationReadinessError,
  isDeploymentRuntime,
  type MigrationDatabasePool,
} from "./readiness";

/**
 * Owner-controlled, time-boxed permission to start a deployment even though
 * the pre-listen readiness check failed. Format: `<reason code>@<UTC expiry>`,
 * e.g. `MIGRATION_READINESS_CATALOG_DRIFT@2026-09-30T06:00:00Z`.
 */
export const STARTUP_READINESS_OVERRIDE_VARIABLE = "LUMERA_STARTUP_READINESS_OVERRIDE";
export const STARTUP_READINESS_OVERRIDE_MAX_MS = 24 * 60 * 60 * 1000;

const REASON_PATTERN = /^MIGRATION_READINESS_[A-Z0-9_]+(?::[A-Za-z0-9_.-]+)*$/u;
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/u;

export type StartupReadinessOverrideOutcome =
  | "absent"
  | "malformed"
  | "expired"
  | "too-long"
  | "reason-mismatch"
  | "granted"
  | "unused";

export interface StartupReadinessOverrideEvaluation {
  readonly outcome: StartupReadinessOverrideOutcome;
  readonly reason: string | null;
  readonly expiresAt: Date | null;
}

function parseOverride(raw: string): { reason: string; expiresAt: Date } | null {
  const parts = raw.trim().split("@");
  if (parts.length !== 2) return null;
  const [reason, expiry] = parts as [string, string];
  if (!REASON_PATTERN.test(reason) || !EXPIRY_PATTERN.test(expiry)) return null;
  const expiresAt = new Date(expiry);
  if (Number.isNaN(expiresAt.getTime())) return null;
  // Reject calendar overflow such as 2026-02-30 that Date silently normalizes.
  const canonical = expiresAt.toISOString();
  if (!canonical.startsWith(expiry.slice(0, 16))) return null;
  return { reason, expiresAt };
}

/**
 * Pure decision. `readinessReason` is null when readiness passed.
 */
export function evaluateStartupReadinessOverride(
  raw: string | undefined,
  readinessReason: string | null,
  now: Date,
): StartupReadinessOverrideEvaluation {
  if (raw === undefined || raw.trim() === "") return { outcome: "absent", reason: null, expiresAt: null };
  const parsed = parseOverride(raw);
  if (!parsed) return { outcome: "malformed", reason: null, expiresAt: null };
  const { reason, expiresAt } = parsed;
  if (readinessReason === null) return { outcome: "unused", reason, expiresAt };
  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining <= 0) return { outcome: "expired", reason, expiresAt };
  if (remaining > STARTUP_READINESS_OVERRIDE_MAX_MS) return { outcome: "too-long", reason, expiresAt };
  if (reason !== readinessReason) return { outcome: "reason-mismatch", reason, expiresAt };
  return { outcome: "granted", reason, expiresAt };
}

export type StartupAdmission =
  | { readonly mode: "normal"; readonly unusedOverride: StartupReadinessOverrideEvaluation | null }
  | { readonly mode: "readiness-override"; readonly reason: string; readonly expiresAt: Date };

/**
 * Pre-listen startup gate. Outside deployment runtimes it is exactly
 * `assertDatabaseMigrationReady`. In a deployment it additionally honours a
 * valid override for the exact reason readiness reports. Readiness itself stays
 * read-only; admission never runs DDL or writes the migration ledger.
 */
export async function admitDatabaseMigrationStartup(
  pool: MigrationDatabasePool,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<StartupAdmission> {
  if (!isDeploymentRuntime(environment)) {
    await assertDatabaseMigrationReady(pool);
    return { mode: "normal", unusedOverride: null };
  }
  const raw = environment[STARTUP_READINESS_OVERRIDE_VARIABLE];
  try {
    await assertDatabaseMigrationReady(pool);
  } catch (error) {
    if (!(error instanceof DatabaseMigrationReadinessError)) throw error;
    const evaluation = evaluateStartupReadinessOverride(raw, error.message, now());
    if (evaluation.outcome === "granted") {
      return { mode: "readiness-override", reason: evaluation.reason!, expiresAt: evaluation.expiresAt! };
    }
    if (evaluation.outcome !== "absent") {
      error.message = `${error.message} (STARTUP_READINESS_OVERRIDE_REJECTED:${evaluation.outcome})`;
    }
    throw error;
  }
  const evaluation = evaluateStartupReadinessOverride(raw, null, now());
  return { mode: "normal", unusedOverride: evaluation.outcome === "absent" ? null : evaluation };
}
