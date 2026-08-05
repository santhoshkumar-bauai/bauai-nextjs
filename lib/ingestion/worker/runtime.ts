import type { Server } from "node:http";

import { assertReplicaSet, closeIngestionClient } from "../db/client.ts";
import { describeError, logger } from "../observability/logger.ts";
import { metricsPort, startMetricsServer } from "../observability/metrics.ts";
import { closeRedisConnections } from "../queue/client.ts";

const log = logger.child("runtime");

export interface WorkerDefinition {
  name: string;
  /** Runs until the signal aborts. */
  run(signal: AbortSignal): Promise<void>;
  isHealthy(): boolean;
  /** Release worker-owned resources; shared clients are closed by the runtime. */
  cleanup?(): Promise<void>;
  /** Skip the replica-set assertion for workers that never write. */
  requiresReplicaSet?: boolean;
}

/**
 * Shared process runtime for every worker.
 *
 * Handles the parts each entrypoint would otherwise duplicate: the replica-set
 * precondition, the health and metrics endpoints, and a graceful shutdown that
 * stops taking new work before closing connections. A second signal exits
 * immediately so a stuck worker can still be killed.
 */
export async function runWorker(definition: WorkerDefinition): Promise<void> {
  const controller = new AbortController();
  let server: Server | null = null;
  let shuttingDown = false;
  let exitCode = 0;

  const shutdown = (reason: string) => {
    if (shuttingDown) {
      log.warn("second shutdown signal; exiting immediately", { reason });
      process.exit(exitCode || 1);
    }
    shuttingDown = true;
    log.info("shutting down", { worker: definition.name, reason });
    controller.abort();
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => shutdown(signal));
  }

  // An unhandled rejection leaves the process in an unknown state; a supervised
  // container restart is safer than continuing to consume jobs.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { reason: String(reason) });
    exitCode = 1;
    shutdown("unhandledRejection");
  });

  try {
    if (definition.requiresReplicaSet !== false) {
      await assertReplicaSet();
    }

    server = startMetricsServer(metricsPort, () => definition.isHealthy());
    log.info("worker ready", { worker: definition.name });

    await definition.run(controller.signal);
  } catch (error) {
    exitCode = 1;
    log.error("worker failed", { worker: definition.name, ...describeError(error) });
  } finally {
    await definition.cleanup?.().catch((error) =>
      log.error("cleanup failed", describeError(error)),
    );
    await closeRedisConnections().catch(() => undefined);
    await closeIngestionClient().catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    log.info("worker stopped", { worker: definition.name, exitCode });
  }

  process.exit(exitCode);
}
