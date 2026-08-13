// Fork patch (idle-rpc): the concurrency-guarded runner for the chain-indexer
// sweep, extracted as a PURE factory so it can be unit-tested without pulling in
// prisma/redis (importing the listener module would). The bug this guards
// against: a throw inside the sweep must not latch the "already running" flag
// forever — see PLAN_2026-07-21_idle-rpc-burn.md (Phase 3). The flag is
// encapsulated per-runner here rather than living as module-global state.

type SweepLogFn = (entry: {
  service: "worker";
  level: "warn" | "error";
  message: string;
  error?: unknown;
}) => void;

/**
 * Build a run-once-at-a-time wrapper around `manageChainIndexers`. If a tick
 * fires while a previous run is still in flight it is skipped (logged at warn);
 * otherwise the sweep runs and the in-flight flag is ALWAYS released in
 * `finally`, so a thrown error can never permanently latch the guard.
 */
/** Mutable in-flight guard shared across runners (see `state` below). */
export type ChainIndexerGuardState = { running: boolean };

export function createGuardedChainIndexerSweep(deps: {
  manageChainIndexers: () => Promise<void>;
  logger: SweepLogFn;
  // Shared guard state. `chainIndexerListener` can be called more than once (it
  // stops + replaces the CronJob), and the ORIGINAL module-global flag gave
  // process-wide mutual exclusion across those re-installs. Pass one shared
  // holder to preserve that; omit it and each runner gets its own (isolated)
  // guard — the default used by unit tests.
  state?: ChainIndexerGuardState;
}): () => Promise<void> {
  const state = deps.state ?? { running: false };
  return async () => {
    if (state.running) {
      deps.logger({
        service: "worker",
        level: "warn",
        message: "manageChainIndexers already running, skipping",
      });
      return;
    }
    state.running = true;
    try {
      await deps.manageChainIndexers();
    } catch (error) {
      // Previously a throw here left the guard latched `true` forever: every
      // later tick hit the "already running" branch, so contract indexing
      // silently stopped and the warn log spammed (~52k lines/day). Surface the
      // real error and always release the flag in `finally`.
      deps.logger({
        service: "worker",
        level: "error",
        message: "manageChainIndexers failed; will retry next tick",
        error,
      });
    } finally {
      state.running = false;
    }
  };
}
