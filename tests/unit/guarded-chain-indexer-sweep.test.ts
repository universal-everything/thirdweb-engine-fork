import { describe, expect, it, vi } from "vitest";
import { createGuardedChainIndexerSweep } from "../../src/worker/listeners/guarded-chain-indexer-sweep";

describe("createGuardedChainIndexerSweep", () => {
  it("releases the guard after a throw so the next tick runs (no permanent latch)", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const manageChainIndexers = vi
      .fn<[], Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const run = createGuardedChainIndexerSweep({
      manageChainIndexers,
      logger: (e) => logs.push({ level: e.level, message: e.message }),
    });

    // First tick throws — must be caught, logged at error, and NOT latch.
    await run();
    expect(manageChainIndexers).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.level === "error")).toBe(true);

    // Second tick must actually run again (the bug: it used to be skipped forever).
    await run();
    expect(manageChainIndexers).toHaveBeenCalledTimes(2);
  });

  it("skips a tick while a previous run is still in flight", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    let resolveFirst: (() => void) | undefined;
    const manageChainIndexers = vi
      .fn<[], Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const run = createGuardedChainIndexerSweep({
      manageChainIndexers,
      logger: (e) => logs.push({ level: e.level, message: e.message }),
    });

    const first = run(); // in flight, guard held
    await run(); // concurrent tick → skipped
    expect(manageChainIndexers).toHaveBeenCalledTimes(1);
    expect(
      logs.some(
        (l) => l.level === "warn" && l.message.includes("already running"),
      ),
    ).toBe(true);

    resolveFirst?.();
    await first;

    // Guard released → a later tick runs.
    await run();
    expect(manageChainIndexers).toHaveBeenCalledTimes(2);
  });

  it("enforces mutual exclusion across runners that share guard state", async () => {
    // Preserves the original module-global behavior: a re-installed listener must
    // not run a second sweep while a prior one is still in flight.
    const state = { running: false };
    const logs: Array<{ level: string; message: string }> = [];
    let resolveFirst: (() => void) | undefined;
    const first = vi.fn<[], Promise<void>>().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const second = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
    const logger = (e: { level: string; message: string }) =>
      logs.push({ level: e.level, message: e.message });

    const runA = createGuardedChainIndexerSweep({
      manageChainIndexers: first,
      logger,
      state,
    });
    const runB = createGuardedChainIndexerSweep({
      manageChainIndexers: second,
      logger,
      state,
    });

    const inflight = runA(); // holds the shared guard
    await runB(); // different runner, same state → must skip
    expect(second).not.toHaveBeenCalled();
    expect(
      logs.some(
        (l) => l.level === "warn" && l.message.includes("already running"),
      ),
    ).toBe(true);

    resolveFirst?.();
    await inflight;
    await runB(); // guard released → now runs
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not log an error on a clean run", async () => {
    const logs: Array<{ level: string }> = [];
    const run = createGuardedChainIndexerSweep({
      manageChainIndexers: async () => {},
      logger: (e) => logs.push({ level: e.level }),
    });
    await run();
    expect(logs.some((l) => l.level === "error")).toBe(false);
  });
});
