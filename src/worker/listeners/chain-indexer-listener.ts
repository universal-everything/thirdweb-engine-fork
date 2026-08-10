import { CronJob } from "cron";
import { getConfig } from "../../shared/utils/cache/get-config";
import { logger } from "../../shared/utils/logger";
import { manageChainIndexers } from "../tasks/manage-chain-indexers";

let processChainIndexerStarted = false;
let task: CronJob;

export const chainIndexerListener = async (): Promise<void> => {
  const config = await getConfig();
  if (!config.indexerListenerCronSchedule) {
    return;
  }

  // Stop the existing task if it exists.
  if (task) {
    task.stop();
  }

  task = new CronJob(config.indexerListenerCronSchedule, async () => {
    if (processChainIndexerStarted) {
      logger({
        service: "worker",
        level: "warn",
        message: "manageChainIndexers already running, skipping",
      });
      return;
    }
    processChainIndexerStarted = true;
    try {
      await manageChainIndexers();
    } catch (error) {
      // Previously a throw here left processChainIndexerStarted latched `true`
      // forever: every later tick hit the "already running" branch, so contract
      // indexing silently stopped and the warn log spammed (~52k lines/day).
      // Surface the real error and always release the flag in `finally`.
      logger({
        service: "worker",
        level: "error",
        message: "manageChainIndexers failed; will retry next tick",
        error,
      });
    } finally {
      processChainIndexerStarted = false;
    }
  });
  task.start();
};
