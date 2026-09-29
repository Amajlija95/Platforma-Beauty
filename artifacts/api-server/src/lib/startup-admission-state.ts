import type { StartupAdmission } from "@workspace/db/migration-runtime";

let admission: StartupAdmission = { mode: "normal", unusedOverride: null };

export function setStartupAdmission(value: StartupAdmission): void {
  admission = value;
}

export interface StartupReadinessOverrideHealth {
  state: "active" | "unused";
  reason: string | null;
  expiresAt: string | null;
  backgroundWork: "disabled" | "enabled";
}

/** Health view of the readiness override; undefined when none is set. */
export function startupReadinessOverrideHealth(): StartupReadinessOverrideHealth | undefined {
  if (admission.mode === "readiness-override") {
    return {
      state: "active",
      reason: admission.reason,
      expiresAt: admission.expiresAt.toISOString(),
      backgroundWork: "disabled",
    };
  }
  if (!admission.unusedOverride) return undefined;
  return {
    state: "unused",
    reason: admission.unusedOverride.reason,
    expiresAt: admission.unusedOverride.expiresAt?.toISOString() ?? null,
    backgroundWork: "enabled",
  };
}
