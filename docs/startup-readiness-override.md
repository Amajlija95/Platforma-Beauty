# Startup readiness override (operator runbook)

A deployment refuses to start when the pre-listen database readiness check
fails. This is correct and should stay that way. The check can be wrong,
though. For example, a minor PostgreSQL update at the provider can change how
the catalog is rendered: the schema fingerprint then no longer matches even
though the schema is the same. For that case the owner can deliberately start
the application despite **one exact** readiness failure, for a **limited time**.

## Which reason can be overridden

Exactly one: `MIGRATION_READINESS_CATALOG_DRIFT`. The check reports it only
after the ledger is complete and bound to this database, the server is a
reviewed PostgreSQL 16 release with the reviewed deparser, and the fingerprint
algorithm versions match. What remains is a difference in the schema
fingerprint itself (structural or physical fingerprint, or the object, enum,
trigger or function counts).

**Every other reason can never be overridden**, whatever the variable says.
That includes:

- `MIGRATION_READINESS_READ_FAILED`: any error without its own reason, for
  example a connection the server terminated during the check;
- every `MIGRATION_READINESS_LEDGER_*` and `MIGRATION_READINESS_INCOMPLETE_LEDGER:*`
  reason, for example `LEDGER_MISSING` (empty database) and
  `LEDGER_IDENTITY_MISMATCH:*` (a database the ledger was not written for);
- `MIGRATION_READINESS_INVALID_LEDGER:*` and `MIGRATION_READINESS_LEDGER_FRONTIER`;
- `MIGRATION_READINESS_NON_PUBLIC_NAMESPACE`;
- `MIGRATION_READINESS_POSTGRES_FAMILY`: another PostgreSQL major version,
  server version number or deparser format;
- `MIGRATION_READINESS_FINGERPRINT_FORMAT`: another fingerprint algorithm
  version.

When the variable is set and the failure is one of these, the refusal says so:

```text
MIGRATION_READINESS_READ_FAILED (STARTUP_READINESS_OVERRIDE_REJECTED:not-overridable; only MIGRATION_READINESS_CATALOG_DRIFT can be overridden)
```

## When to use it

Use it only when all of the following are true:

- the deployment refuses to start;
- the refusal log names `MIGRATION_READINESS_CATALOG_DRIFT`;
- you have independently established that the database is fine and the check
  is wrong. For example, the schema is unchanged and only the provider's
  PostgreSQL patch version changed.

Never use it to boot a database with missing or failed migrations, one you do
not recognise, or one you have not examined. The override does not repair
anything. It only lets the process serve requests while the real cause is
fixed.

## How to use it

1. Confirm the refusal log names the one overridable reason:

   ```text
   DatabaseMigrationReadinessError: MIGRATION_READINESS_CATALOG_DRIFT
   ```

2. Set one deployment secret in the form `<reason code>@<UTC expiry>`:

   ```sh
   LUMERA_STARTUP_READINESS_OVERRIDE=MIGRATION_READINESS_CATALOG_DRIFT@2026-09-30T06:00:00Z
   ```

   - **The expiry is required.** It must be written in UTC with a trailing `Z`
     (`YYYY-MM-DDTHH:MM[:SS]Z`), and it must be in the future and **at most 24
     hours ahead** of the moment the process starts.
   - The reason code must be exactly `MIGRATION_READINESS_CATALOG_DRIFT`, and
     the check must report exactly that reason right now.

3. Restart the deployment.

The process still refuses to start in each of these cases:

- the variable is malformed;
- the expiry has passed;
- the expiry is more than 24 hours ahead;
- the code does not match;
- the current failure is any reason other than `MIGRATION_READINESS_CATALOG_DRIFT`.

The refusal message then shows why, for example
`MIGRATION_READINESS_CATALOG_DRIFT (STARTUP_READINESS_OVERRIDE_REJECTED:reason-mismatch)`.
Errors that carry no readiness reason are never overridable: an unreachable
database fails before the check, and an error during the check is
`MIGRATION_READINESS_READ_FAILED`, which is not overridable.

## What the override does

- It serves HTTP requests, including `/api/healthz`.
- At startup it logs `STARTUP_READINESS_OVERRIDE_ACTIVE` at error level with the
  reason and the expiry, and repeats that log every 5 minutes.
- The public `/api/healthz` reports only `"status": "readiness-override"`.
  The reason, the expiry and any database identity details appear only in
  the log.

- At the expiry the process logs `STARTUP_READINESS_OVERRIDE_EXPIRED` and shuts
  down with exit code 1. The platform restart is then refused, because the
  override has expired. To keep running, set a new expiry, but only if the
  failure is still understood.
- The two LISTEN listeners (salon notifications and catalog cache
  invalidation) keep running, because they serve live requests.

## What the override does not do

- It runs no DDL and never writes the migration ledger. The readiness check
  stays a read-only transaction.
- It starts no background work: no scheduled jobs, no interval workers, no
  startup sweep, no legacy media migration and no test-listing reconciliation.
  While the override is active, e-mail, SMS and push outboxes, reminders and
  maintenance do not run.
- It changes nothing outside production. In development and test the variable
  is not read at all.
- It does not change the schema, run migrations, or mark anything as verified.

## When readiness passes again

If readiness passes while the variable is still set, the application runs
normally, including background work. It then warns at startup and every 5
minutes:

```text
STARTUP_READINESS_OVERRIDE_UNUSED: readiness passed; remove LUMERA_STARTUP_READINESS_OVERRIDE
```

`/api/healthz` reports `"status": "ok"` and nothing about the variable. Remove
the variable at the next opportunity.

## Proof

The suite `startup-readiness-override` covers:

- refusal without an override, with a wrong code, with an expired expiry and
  with an expiry more than 24 hours ahead;
- refusal, even with an override naming the exact reason, of an empty
  database, a schema outside `public`, a ledger bound to another database and
  a connection terminated after connecting and before the first query;
- a successful override boot with no DDL in the server statement log, an
  unchanged ledger, no table writes, and public health without reason or
  expiry;
- a test-only probe (`scripts/src/migrations/background-work-probe.mjs`) that
  records the creation stack of every timer and every SQL statement in the
  override boot. Any timer or query not started by the readiness check, the two
  LISTEN listeners and their reconnects, or the override's own supervision
  fails the proof. The same probe must detect the normal boot's background
  work;
- shutdown at expiry;
- the unused warning.

It boots the real entrypoint with `NODE_ENV=production` against disposable
PostgreSQL 16 clusters and is run by `pnpm run test:migrations:phase5:integration`.

This document grants no authorization to change any production setting,
secret, database or deployment.
