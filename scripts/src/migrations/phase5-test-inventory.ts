/**
 * The migration work landed over several commits, so keep its execution
 * inventory independent of a checkout's Git history (which is deliberately
 * shallow in CI). `declaredTests` is the number of top-level `test(...)`
 * declarations in the checked-in file, not a claim about dynamic subtests.
 */
export interface Phase5TestInventoryEntry {
  readonly path: string;
  readonly declaredTests: number;
  readonly execution: "database-free" | "disposable-integration" | "existing-phase4-command" | "superseded";
  readonly provenance: "80f822ac..343ea5ae" | "343ea5ae" | "phase5-followup";
  readonly skipPolicy?: "forbidden";
}

export const phase5TestInventory: readonly Phase5TestInventoryEntry[] = [
  { path: "scripts/src/migrations/target-identity.test.ts", declaredTests: 11, execution: "database-free", provenance: "phase5-followup", skipPolicy: "forbidden" },
  { path: "scripts/src/migrations/ledger-identity.test.ts", declaredTests: 3, execution: "database-free", provenance: "phase5-followup", skipPolicy: "forbidden" },
  { path: "lib/db/src/migration-runtime/startup-admission.test.ts", declaredTests: 6, execution: "database-free", provenance: "phase5-followup", skipPolicy: "forbidden" },
  { path: "scripts/src/migrations/startup-readiness-override.integration.test.ts", declaredTests: 2, execution: "disposable-integration", provenance: "phase5-followup", skipPolicy: "forbidden" },
  { path: "scripts/src/migrations/target-identity.integration.test.ts", declaredTests: 6, execution: "disposable-integration", provenance: "phase5-followup", skipPolicy: "forbidden" },
  { path: "artifacts/api-server/src/lib/business-growth-schema-boot-regression.test.ts", declaredTests: 1, execution: "disposable-integration", provenance: "343ea5ae" },
  { path: "lib/db/src/migration-runtime/contract.test.ts", declaredTests: 5, execution: "database-free", provenance: "343ea5ae" },
  { path: "lib/db/src/migration-runtime/namespaces.test.ts", declaredTests: 2, execution: "database-free", provenance: "343ea5ae" },
  { path: "scripts/src/migrations/adoption-boundary.integration.test.ts", declaredTests: 1, execution: "disposable-integration", provenance: "343ea5ae" },
  { path: "scripts/src/migrations/deployment-eligibility.test.ts", declaredTests: 10, execution: "database-free", provenance: "343ea5ae" },
  { path: "scripts/src/migrations/historical-operation-matrix.test.ts", declaredTests: 1, execution: "database-free", provenance: "343ea5ae", skipPolicy: "forbidden" },
  { path: "scripts/src/migrations/migration-runtime-parity.test.ts", declaredTests: 1, execution: "database-free", provenance: "343ea5ae" },
  { path: "scripts/src/migrations/migrations.integration.test.ts", declaredTests: 23, execution: "existing-phase4-command", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/migrations/migrations.test.ts", declaredTests: 14, execution: "database-free", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/migrations/namespace-boundary.integration.test.ts", declaredTests: 1, execution: "disposable-integration", provenance: "343ea5ae" },
  { path: "scripts/src/migrations/preflight.test.ts", declaredTests: 4, execution: "database-free", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/migrations/prepare-development.test.ts", declaredTests: 3, execution: "database-free", provenance: "343ea5ae" },
  { path: "scripts/src/migrations/postgres-log-evidence.test.ts", declaredTests: 5, execution: "database-free", provenance: "phase5-followup" },
  { path: "scripts/src/migrations/run-phase5-integration.test.ts", declaredTests: 8, execution: "database-free", provenance: "phase5-followup" },
  { path: "scripts/src/migrations/supported-convergence.integration.test.ts", declaredTests: 4, execution: "disposable-integration", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/migrations/supported-path-boot.integration.test.ts", declaredTests: 5, execution: "disposable-integration", provenance: "343ea5ae" },
  { path: "scripts/src/migrations/supported-state.integration.test.ts", declaredTests: 15, execution: "disposable-integration", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/schema-drift/eligibility-cli.test.ts", declaredTests: 6, execution: "database-free", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/startup-data/apply.test.ts", declaredTests: 13, execution: "disposable-integration", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/startup-ddl-removal-gate.test.ts", declaredTests: 6, execution: "database-free", provenance: "343ea5ae" },
  // This test proves the pre-removal startup-DDL inventory and correctly
  // rejects the Phase 5 entrypoint. It is retained as history, not runnable
  // Phase 5 evidence; the startup-ddl-removal gate is its replacement.
  { path: "scripts/src/startup-equivalence/crosswalk.test.ts", declaredTests: 7, execution: "superseded", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/startup-equivalence/fixtures.test.ts", declaredTests: 4, execution: "database-free", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/startup-equivalence/recovery.test.ts", declaredTests: 1, execution: "disposable-integration", provenance: "80f822ac..343ea5ae" },
  { path: "scripts/src/subscription-reconciliation/reconciliation.test.ts", declaredTests: 13, execution: "disposable-integration", provenance: "80f822ac..343ea5ae" },
];

export const phase5DatabaseFreeTests = phase5TestInventory
  .filter((entry) => entry.execution === "database-free")
  .map((entry) => entry.path);

export const phase5DisposableIntegrationSuites = [
  {
    id: "phase4-migrations",
    declaredTests: 23,
    files: ["scripts/src/migrations/migrations.integration.test.ts"],
  },
  {
    id: "equivalence-characterization",
    declaredTests: 4,
    files: ["scripts/src/startup-equivalence/fixtures.test.ts"],
  },
  {
    id: "target-identity",
    declaredTests: 6,
    files: ["scripts/src/migrations/target-identity.integration.test.ts"],
  },
  {
    id: "supported-state",
    declaredTests: 15,
    files: ["scripts/src/migrations/supported-state.integration.test.ts"],
  },
  {
    id: "supported-convergence",
    declaredTests: 4,
    files: ["scripts/src/migrations/supported-convergence.integration.test.ts"],
  },
  {
    id: "adoption-boundary",
    declaredTests: 1,
    files: ["scripts/src/migrations/adoption-boundary.integration.test.ts"],
  },
  {
    id: "namespace-boundary",
    declaredTests: 1,
    files: ["scripts/src/migrations/namespace-boundary.integration.test.ts"],
  },
  {
    id: "actual-entrypoint-boot",
    declaredTests: 5,
    files: ["scripts/src/migrations/supported-path-boot.integration.test.ts"],
  },
  {
    id: "legacy-boot-refusal",
    declaredTests: 1,
    files: ["artifacts/api-server/src/lib/business-growth-schema-boot-regression.test.ts"],
  },
  {
    id: "historical-data-regressions",
    declaredTests: 26,
    files: [
      "scripts/src/startup-data/apply.test.ts",
      "scripts/src/subscription-reconciliation/reconciliation.test.ts",
    ],
  },
  {
    id: "interrupted-recovery",
    declaredTests: 1,
    files: ["scripts/src/startup-equivalence/recovery.test.ts"],
  },
  {
    id: "startup-readiness-override",
    declaredTests: 2,
    files: ["scripts/src/migrations/startup-readiness-override.integration.test.ts"],
  },
] as const;