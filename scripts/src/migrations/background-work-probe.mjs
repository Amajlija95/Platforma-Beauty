// Test-only preload for startup-readiness-override.integration.test.ts; the
// application never imports it. It is loaded with NODE_OPTIONS=--import into
// the real API entrypoint and records, with its creation stack:
// - every Timeout and Immediate (setTimeout, setInterval, setImmediate and
//   timers/promises all create one), whichever API or module started it;
// - every SQL statement sent through pg's Client (pools and drizzle included).
// The proof then classifies each record by the functions on its stack.
import { createHook } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logPath = process.env.LUMERA_BACKGROUND_PROBE_LOG;

if (logPath) {
  Error.stackTraceLimit = 100;
  let recording = false;
  const record = (kind, detail) => {
    // appendFileSync creates no async resource, but guard re-entry anyway.
    if (recording) return;
    recording = true;
    try {
      const stack = (new Error().stack ?? "").split("\n").slice(2).map((line) => line.trim());
      appendFileSync(logPath, `${JSON.stringify({ kind, ...detail, stack })}\n`);
    } finally {
      recording = false;
    }
  };

  createHook({
    init(_asyncId, type) {
      if (type === "Timeout" || type === "Immediate") record("timer", { type });
    },
  }).enable();

  // Resolve pg exactly as @workspace/db does, so this patches the class the
  // application uses.
  const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const pg = createRequire(path.join(workspaceRoot, "lib/db/package.json"))("pg");
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function probedQuery(config, ...rest) {
    const text = typeof config === "string" ? config : config?.text;
    record("query", { text: String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, 160) });
    return query.call(this, config, ...rest);
  };
}
