import app from "./app";
import { closePool, databasePoolStats, pool } from "@workspace/db";
import {
  admitDatabaseMigrationStartup,
  STARTUP_READINESS_OVERRIDE_VARIABLE,
} from "@workspace/db/migration-runtime";
import { logger } from "./lib/logger";
import { setStartupAdmission } from "./lib/startup-admission-state";
import { retryFailedRetryableEmails } from "./lib/brevo";
import { processUpcomingEducationSessions } from "./lib/education-sessions";
import {
  startSalonNotificationEventListener,
  stopSalonNotificationEventListener,
} from "./lib/salon-notification-events";
import { runEducationGalleryCleanup } from "./routes/marketplace";
import { cleanupExpiredImageAssets } from "./routes/image-media";
import { runMediaUploadCleanup } from "./routes/media";
import { migrateLegacyMediaReferences } from "./lib/media-migration";
import {
  catalogCacheStats,
  startCatalogCacheInvalidationListener,
  stopCatalogCacheInvalidationListener,
} from "./lib/catalog-cache";
import { runCommunicationArchiveBatch } from "./lib/communication-archive";
import { registerFatalHandlers } from "./lib/process-lifecycle";
import { runAutomationWorker } from "./lib/automation-worker";
import { runDeliveryReportRecoveryAlerts, runDeliveryReportSilenceAlerts, runMalformedWebhookAlerts } from "./lib/delivery-report-alerts";
import {
  createResilientScheduledJob,
  runSchedulerStartupSweep,
} from "./lib/scheduler-resilience";
import { runBrevoWebhookCoverageMonitor } from "./lib/monitoring";
import { expireBeautyJobListings } from "./lib/beauty-jobs-maintenance";
import { runBeautyJobDeliveryFailureAlerts } from "./lib/beauty-jobs-delivery-monitor";
import { reconcileKnownTestListings } from "./lib/test-listing-reconciliation";
import { runReferralMaintenance } from "./lib/referral-service";
import { assertAnthropicIntegrationConfigured } from "@workspace/integrations-anthropic-ai";
import { runSystemPushWorker } from "./lib/web-push";
import { drainSmsOutbox } from "./lib/sms";
import { runProductWaitlistNotificationWorker } from "./lib/product-waitlist-worker";
import { runRetailSubscriptionWorker } from "./lib/retail-subscription-worker";
import { runRetailCartReminderSweep } from "./lib/retail-cart-reminders";
import { runRetailReviewInvitationSweep } from "./lib/review-invitations";
import { runAftercareWorker } from "./lib/aftercare-worker";
import {
  runAppointmentReminderSweep,
  runAppointmentReviewInvitationSweep,
} from "./lib/appointment-customer-events";
import { enqueueEducationReminderSweep, processEducationOutbox } from "./lib/education-outbox";
import { runFeaturedPlacementPaymentReminderSweep } from "./lib/featured-placement-payment-reminders";
import { runEducationSubscriptionLifecycle } from "./lib/education-subscription-worker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// The Anthropic client is now resolved lazily, on the AI growth-advisor
// request path, so that importing this app does not require a Replit-only
// integration variable in CI. Real deployments must still discover a missing
// integration when they start, not when a salon owner first asks the advisor
// a question, so the boot-time check the old import-time throw provided is
// kept here -- deliberately production-only, matching how this file already
// gates other production-only startup work below.
if (process.env.NODE_ENV === "production") {
  assertAnthropicIntegrationConfigured();
}

// Schema and initial data are prepared by explicit numbered migrations.
// Refuse missing receipts or catalog drift before any startup data mutation,
// listener, scheduler, or HTTP request; startup never repairs the database.
// Only in a deployment, an owner-set, time-boxed override naming the exact
// failing reason admits a boot without background work (see
// docs/startup-readiness-override.md).
const startupAdmission = await admitDatabaseMigrationStartup(pool);
setStartupAdmission(startupAdmission);
if (startupAdmission.mode === "readiness-override") {
  logger.error(
    {
      event: "STARTUP_READINESS_OVERRIDE_ACTIVE",
      reason: startupAdmission.reason,
      expiresAt: startupAdmission.expiresAt.toISOString(),
      backgroundWork: "disabled",
    },
    "STARTUP_READINESS_OVERRIDE_ACTIVE: readiness failed and the owner override admitted this boot; background work disabled until restart",
  );
} else {
  await reconcileKnownTestListings();
}

void startSalonNotificationEventListener().catch((error: unknown) => {
  logger.error({ err: error }, "Salon notification event listener failed to start");
});
void startCatalogCacheInvalidationListener().catch((error: unknown) => {
  logger.error({ err: error }, "Catalog cache invalidation listener failed to start");
});
const server = app.listen(port, "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

// Every recurring job, timer, startup sweep, and background data repair lives
// here so a readiness-override boot can serve requests without any of them.
function startBackgroundWork(): () => void {
  const transactionalEmailOutbox = createResilientScheduledJob({
    job: "transactional-email-outbox",
    run: retryFailedRetryableEmails,
  });
  const educationSessionMaintenance = createResilientScheduledJob({
    job: "education-session-maintenance",
    run: processUpcomingEducationSessions,
  });
  const educationOutboxDeliveries = createResilientScheduledJob({ job: "education-outbox-deliveries", run: processEducationOutbox });
  const educationReminderSweep = createResilientScheduledJob({ job: "education-reminder-sweep", run: enqueueEducationReminderSweep });
  const featuredPlacementPaymentReminders = createResilientScheduledJob({
    job: "featured-placement-payment-reminders",
    run: runFeaturedPlacementPaymentReminderSweep,
  });
  const educationSubscriptionLifecycle = createResilientScheduledJob({
    job: "education-subscription-lifecycle",
    run: runEducationSubscriptionLifecycle,
  });
  const educationGalleryCleanup = createResilientScheduledJob({
    job: "education-gallery-cleanup",
    run: runEducationGalleryCleanup,
  });
  const mediaUploadCleanup = createResilientScheduledJob({
    job: "media-upload-cleanup",
    run: runMediaUploadCleanup,
  });
  const compatibilityImageCleanup = createResilientScheduledJob({
    job: "compatibility-image-cleanup",
    run: cleanupExpiredImageAssets,
  });
  const communicationArchive = createResilientScheduledJob({
    job: "communication-archive",
    run: runCommunicationArchiveBatch,
  });
  const automationWorker = createResilientScheduledJob({
    job: "automation-worker",
    run: runAutomationWorker,
  });
  const deliveryReportSilenceAlerts = createResilientScheduledJob({
    job: "delivery-report-silence-alerts",
    run: runDeliveryReportSilenceAlerts,
  });
  const deliveryReportRecoveryAlerts = createResilientScheduledJob({
    job: "delivery-report-recovery-alerts",
    run: runDeliveryReportRecoveryAlerts,
  });

  const brevoWebhookCoverageMonitor = createResilientScheduledJob({
    job: "brevo-webhook-coverage-monitor",
    run: runBrevoWebhookCoverageMonitor,
  });
  const malformedWebhookAlerts = createResilientScheduledJob({
    job: "malformed-webhook-alerts",
    run: runMalformedWebhookAlerts,
  });
  const beautyJobsExpirySweep = createResilientScheduledJob({
    job: "beauty-jobs-expiry-sweep",
    run: expireBeautyJobListings,
  });
  const beautyJobEmailDeliveryAlerts = createResilientScheduledJob({
    job: "beauty-job-email-delivery-alerts",
    run: runBeautyJobDeliveryFailureAlerts,
  });
  const referralMaintenance = createResilientScheduledJob({
    job: "referral-maintenance",
    run: runReferralMaintenance,
  });
  const productWaitlistNotifications = createResilientScheduledJob({
    job: "product-waitlist-notifications",
    run: runProductWaitlistNotificationWorker,
  });
  const retailSubscriptionCycles = createResilientScheduledJob({
    job: "retail-subscription-cycles",
    run: runRetailSubscriptionWorker,
  });
  const retailCartReminderSweep = createResilientScheduledJob({
    job: "retail-cart-reminder-sweep",
    run: runRetailCartReminderSweep,
  });
  const retailReviewInvitationSweep = createResilientScheduledJob({
    job: "retail-review-invitation-sweep",
    run: runRetailReviewInvitationSweep,
  });
  const aftercareWorker = createResilientScheduledJob({
    job: "aftercare-worker",
    run: runAftercareWorker,
  });
  const appointmentReminders = createResilientScheduledJob({
    job: "appointment-reminders",
    run: runAppointmentReminderSweep,
  });
  const appointmentReviewInvitations = createResilientScheduledJob({
    job: "appointment-review-invitations",
    run: runAppointmentReviewInvitationSweep,
  });
  const systemPushDeliveries = createResilientScheduledJob({
    job: "system-push-deliveries",
    run: runSystemPushWorker,
  });
  const smsOutboxDeliveries = createResilientScheduledJob({
    job: "sms-outbox-deliveries",
    run: drainSmsOutbox,
  });
  const scheduledJobs = [
    transactionalEmailOutbox,
    educationSessionMaintenance,
    educationOutboxDeliveries,
    educationReminderSweep,
    educationGalleryCleanup,
    mediaUploadCleanup,
    compatibilityImageCleanup,
    communicationArchive,
    automationWorker,
    deliveryReportSilenceAlerts,
    deliveryReportRecoveryAlerts,
    brevoWebhookCoverageMonitor,
    malformedWebhookAlerts,
    beautyJobsExpirySweep,
    beautyJobEmailDeliveryAlerts,
    referralMaintenance,
    productWaitlistNotifications,
    retailSubscriptionCycles,
    retailCartReminderSweep,
    retailReviewInvitationSweep,
    aftercareWorker,
    appointmentReminders,
    appointmentReviewInvitations,
    systemPushDeliveries,
    smsOutboxDeliveries,
    featuredPlacementPaymentReminders,
    educationSubscriptionLifecycle,
  ];

  const retryInterval = setInterval(() => {
    void transactionalEmailOutbox.run();
  }, 60_000);
  retryInterval.unref();
  const smsOutboxInterval = setInterval(() => {
    void smsOutboxDeliveries.run();
  }, 60_000);
  smsOutboxInterval.unref();

  // Education session lifecycle: drain expired waitlist offers and auto-cancel
  // under-enrolled sessions. Runs every 5 minutes on a self-unreferencing timer
  // so it never keeps the process alive on its own.
  const educationMaintenanceInterval = setInterval(() => {
    void educationSessionMaintenance.run();
  }, 5 * 60_000);
  educationMaintenanceInterval.unref();
  const educationOutboxInterval = setInterval(() => {
    void educationOutboxDeliveries.run();
    void educationReminderSweep.run();
  }, 60_000);
  educationOutboxInterval.unref();

  const featuredPlacementPaymentReminderInterval = setInterval(() => {
    void featuredPlacementPaymentReminders.run();
  }, 15 * 60_000);
  featuredPlacementPaymentReminderInterval.unref();
  const educationSubscriptionInterval = setInterval(() => {
    void educationSubscriptionLifecycle.run();
  }, 60 * 60_000);
  educationSubscriptionInterval.unref();

  const beautyJobsExpiryInterval = setInterval(() => {
    void beautyJobsExpirySweep.run();
  }, 5 * 60_000);
  beautyJobsExpiryInterval.unref();

  const referralMaintenanceInterval = setInterval(() => {
    void referralMaintenance.run();
  }, 5 * 60_000);
  referralMaintenanceInterval.unref();

  // The database trigger writes this durable queue in the same stock-update
  // transaction (including admin adjustments and cancellation credits). Drain it
  // frequently; the worker is safe to run concurrently on every application node.
  const productWaitlistNotificationsInterval = setInterval(() => {
    void productWaitlistNotifications.run();
  }, 60_000);
  productWaitlistNotificationsInterval.unref();

  const retailSubscriptionCyclesInterval = setInterval(() => {
    void retailSubscriptionCycles.run();
  }, 60_000);
  retailSubscriptionCyclesInterval.unref();

  const retailCartReminderSweepInterval = setInterval(() => {
    void retailCartReminderSweep.run();
  }, 15 * 60_000);
  retailCartReminderSweepInterval.unref();
  const retailReviewInvitationSweepInterval = setInterval(() => { void retailReviewInvitationSweep.run(); }, 60 * 60_000);
  retailReviewInvitationSweepInterval.unref();
  const appointmentCustomerEventsInterval = setInterval(() => {
    void appointmentReminders.run();
    void appointmentReviewInvitations.run();
  }, 60_000);
  appointmentCustomerEventsInterval.unref();
  const systemPushDeliveriesInterval = setInterval(() => {
    void systemPushDeliveries.run();
  }, 30_000);
  systemPushDeliveriesInterval.unref();

  const educationGalleryCleanupInterval = setInterval(() => {
    void educationGalleryCleanup.run();
  }, 5 * 60_000);
  educationGalleryCleanupInterval.unref();

  const mediaCleanupInterval = setInterval(() => {
    void mediaUploadCleanup.run();
  }, 5 * 60_000);
  mediaCleanupInterval.unref();

  const compatibilityImageCleanupInterval = setInterval(() => {
    void compatibilityImageCleanup.run();
  }, 10 * 60_000);

  const communicationArchiveInterval = setInterval(() => {
    void communicationArchive.run();
  }, 24 * 60 * 60_000);
  communicationArchiveInterval.unref();

  // Automation worker: evaluate active rules every 15 minutes
  const automationWorkerInterval = setInterval(() => {
    void automationWorker.run();
  }, 15 * 60_000);
  automationWorkerInterval.unref();

  // Platform B2C aftercare outbox, delivery, conversion and replenishment sweep.
  const aftercareWorkerInterval = setInterval(() => {
    void aftercareWorker.run();
  }, 15 * 60_000);
  aftercareWorkerInterval.unref();

  // Delivery-report silence alerts: if automation messages went out recently but
  // no verified webhook events arrived, email administrators (deduplicated per
  // cooldown window through the email outbox — never one email per tick).
  const deliveryReportAlertInterval = setInterval(() => {
    void deliveryReportSilenceAlerts.run();
    void deliveryReportRecoveryAlerts.run();
    void brevoWebhookCoverageMonitor.run();
    void malformedWebhookAlerts.run();
    void beautyJobEmailDeliveryAlerts.run();
  }, 15 * 60_000);
  deliveryReportAlertInterval.unref();
  compatibilityImageCleanupInterval.unref();

  // Boot performs one ordered sweep instead of launching every database-backed
  // worker at once. Recurring timers still use each job's single-flight guard and
  // the shared FIFO activity/connection gates.
  void runSchedulerStartupSweep(scheduledJobs).catch((error) => {
    logger.error({ err: error }, "Initial scheduler sweep failed");
  });

  const databaseMetricsInterval = setInterval(() => {
    logger.debug(
      {
        databasePool: databasePoolStats(),
        catalogCache: catalogCacheStats(),
      },
      "Database and catalog cache metrics",
    );
  }, 60_000);
  databaseMetricsInterval.unref();

  // Safe on every boot: already-managed references are ignored and legacy
  // sources are never removed. Running after listen keeps readiness fast.
  void migrateLegacyMediaReferences().catch((error) => {
    logger.warn({ err: error }, "Legacy media migration failed");
  });

  return () => {
    clearInterval(retryInterval);
    clearInterval(productWaitlistNotificationsInterval);
    clearInterval(retailSubscriptionCyclesInterval);
    clearInterval(retailCartReminderSweepInterval);
    clearInterval(retailReviewInvitationSweepInterval);
    clearInterval(appointmentCustomerEventsInterval);
    clearInterval(systemPushDeliveriesInterval);
    clearInterval(educationMaintenanceInterval);
    clearInterval(educationOutboxInterval);
    clearInterval(featuredPlacementPaymentReminderInterval);
    clearInterval(beautyJobsExpiryInterval);
    clearInterval(referralMaintenanceInterval);
    clearInterval(educationGalleryCleanupInterval);
    clearInterval(mediaCleanupInterval);
    clearInterval(compatibilityImageCleanupInterval);
    clearInterval(communicationArchiveInterval);
    clearInterval(automationWorkerInterval);
    clearInterval(aftercareWorkerInterval);
    clearInterval(deliveryReportAlertInterval);
    clearInterval(databaseMetricsInterval);
    clearInterval(smsOutboxInterval);
    for (const scheduledJob of scheduledJobs) scheduledJob.stop();
  };
}

const READINESS_OVERRIDE_WARNING_INTERVAL_MS = 5 * 60_000;
let stopBackgroundWork: (() => void) | undefined;
let readinessOverrideWarningInterval: NodeJS.Timeout | undefined;
let readinessOverrideExpiryTimer: NodeJS.Timeout | undefined;

// The only timers a readiness-override boot starts besides the two LISTEN
// listeners' reconnects; the override proof identifies them by this name.
function superviseReadinessOverride(reason: string, expiresAt: Date): void {
  readinessOverrideWarningInterval = setInterval(() => {
    logger.error(
      { event: "STARTUP_READINESS_OVERRIDE_ACTIVE", reason, expiresAt: expiresAt.toISOString(), backgroundWork: "disabled" },
      "STARTUP_READINESS_OVERRIDE_ACTIVE: still running on the readiness override; background work disabled",
    );
  }, READINESS_OVERRIDE_WARNING_INTERVAL_MS);
  readinessOverrideWarningInterval.unref();
  // The override bounds the whole run, not only the boot: at expiry the process
  // stops, and a restart with the expired value is refused.
  readinessOverrideExpiryTimer = setTimeout(() => {
    logger.fatal(
      { event: "STARTUP_READINESS_OVERRIDE_EXPIRED", reason, expiresAt: expiresAt.toISOString() },
      "STARTUP_READINESS_OVERRIDE_EXPIRED: readiness override expired; shutting down",
    );
    shutDown("SIGTERM", 1);
  }, Math.max(0, expiresAt.getTime() - Date.now()));
}

if (startupAdmission.mode === "readiness-override") {
  superviseReadinessOverride(startupAdmission.reason, startupAdmission.expiresAt);
} else {
  stopBackgroundWork = startBackgroundWork();
  const unusedOverride = startupAdmission.unusedOverride;
  if (unusedOverride) {
    const warnUnused = () => logger.warn(
      {
        event: "STARTUP_READINESS_OVERRIDE_UNUSED",
        outcome: unusedOverride.outcome,
        reason: unusedOverride.reason,
        expiresAt: unusedOverride.expiresAt?.toISOString() ?? null,
      },
      `STARTUP_READINESS_OVERRIDE_UNUSED: readiness passed; remove ${STARTUP_READINESS_OVERRIDE_VARIABLE}`,
    );
    warnUnused();
    readinessOverrideWarningInterval = setInterval(warnUnused, READINESS_OVERRIDE_WARNING_INTERVAL_MS);
    readinessOverrideWarningInterval.unref();
  }
}

let shuttingDown = false;

function clearScheduledTasks(): void {
  stopBackgroundWork?.();
  if (readinessOverrideWarningInterval) clearInterval(readinessOverrideWarningInterval);
  if (readinessOverrideExpiryTimer) clearTimeout(readinessOverrideExpiryTimer);
}
function shutDown(signal: NodeJS.Signals, exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Server shutting down");
  clearScheduledTasks();
  void performCleanup().finally(() => flushAndExit(exitCode));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => shutDown("SIGINT"));
process.once("SIGTERM", () => shutDown("SIGTERM"));

registerFatalHandlers({
  logger,
  cleanup: () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearScheduledTasks();
    return performCleanup();
  },
});

function flushAndExit(exitCode: number): void {
  logger.flush(() => process.exit(exitCode));
}

async function performCleanup(): Promise<void> {
  await Promise.allSettled([
    stopSalonNotificationEventListener(),
    stopCatalogCacheInvalidationListener(),
  ]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await closePool();
  } catch (error) {
    logger.warn({ err: error }, "Pool close failed during shutdown");
  }
}
