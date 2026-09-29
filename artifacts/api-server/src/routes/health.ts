import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getPoolStatus } from "@workspace/db";
import { schedulerHealthSnapshot } from "../lib/scheduler-resilience";
import { isStartupReadinessOverrideActive } from "../lib/startup-admission-state";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const databasePool = getPoolStatus();
  if (process.env.LUMERA_BOOKING_LOAD === "1") {
    res.setHeader("x-lumera-database-statements", String(databasePool.statements));
  }
  const data = HealthCheckResponse.parse({
    status: isStartupReadinessOverrideActive() ? "readiness-override" : "ok",
    databasePool,
    schedulerJobs: schedulerHealthSnapshot(),
  });
  res.json(data);
});

export default router;
