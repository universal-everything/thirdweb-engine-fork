import { CronJob } from "cron";
import { getConfig } from "../../shared/utils/cache/get-config";
import { logger } from "../../shared/utils/logger";
import { manageChainIndexers } from "../tasks/manage-chain-indexers";
import {
  type ChainIndexerGuardState,
  createGuardedChainIndexerSweep,
} from "./guarded-chain-indexer-sweep";

let task: CronJob;
// Module-level guard shared across re-installs, preserving the original
// process-wide mutual exclusion (a re-registered listener won't run a second
// sweep while a prior one is still in flight).
const guardState: ChainIndexerGuardState = { running: false };

export const chainIndexerListener = async (): Promise<void> => {
  const config = await getConfig();
  if (!config.indexerListenerCronSchedule) {
    return;
  }

  // Stop the existing task if it exists.
  if (task) {
    task.stop();
  }

  // The guard (with the try/finally that releases it on error) lives in a pure,
  // unit-tested factory — see `guarded-chain-indexer-sweep.ts`.
  const runSweep = createGuardedChainIndexerSweep({
    manageChainIndexers,
    logger,
    state: guardState,
  });
  task = new CronJob(config.indexerListenerCronSchedule, runSweep);
  task.start();
};
