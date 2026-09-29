import type { StartupAdmission } from "@workspace/db/migration-runtime";

let admission: StartupAdmission = { mode: "normal", unusedOverride: null };

export function setStartupAdmission(value: StartupAdmission): void {
  admission = value;
}

/**
 * Whether this boot runs on the readiness override. Public health exposes only
 * this; the reason, expiry and database identity details stay in the log.
 */
export function isStartupReadinessOverrideActive(): boolean {
  return admission.mode === "readiness-override";
}
