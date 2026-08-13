import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDEXER_LISTENER_CRON,
  DEFAULT_MINED_TX_LISTENER_CRON,
} from "../../src/shared/db/configuration/default-cron-schedules";

// Regression guard: an upstream merge or a careless edit must not silently
// revert these fresh-config defaults to the upstream `*/5 * * * * *` (every 5s),
// which is the idle-RPC-burn footgun this fork patch removes.
describe("default cron schedules (idle-rpc fork patch)", () => {
  it("does not use the every-5-seconds upstream default", () => {
    expect(DEFAULT_MINED_TX_LISTENER_CRON).not.toBe("*/5 * * * * *");
    expect(DEFAULT_INDEXER_LISTENER_CRON).not.toBe("*/5 * * * * *");
  });

  it("defaults both listeners to once a minute", () => {
    expect(DEFAULT_MINED_TX_LISTENER_CRON).toBe("0 * * * * *");
    expect(DEFAULT_INDEXER_LISTENER_CRON).toBe("0 * * * * *");
  });
});
