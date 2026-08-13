import { describe, expect, it } from "vitest";
import {
  NONCE_HEALTH_CHECK_FREQUENCY_SECONDS,
  nonceHealthCheckCronPattern,
} from "../../src/worker/tasks/nonce-health-check-cron";

describe("nonceHealthCheckCronPattern", () => {
  it("steps the MINUTES field for whole-minute frequencies (not seconds)", () => {
    // The whole point of the fix: `*/300 * * * * *` would collapse to "every
    // minute" because a seconds-field step only ranges 0-59.
    expect(nonceHealthCheckCronPattern(300)).toBe("0 */5 * * * *");
    expect(nonceHealthCheckCronPattern(60)).toBe("0 */1 * * * *");
    expect(nonceHealthCheckCronPattern(600)).toBe("0 */10 * * * *");
  });

  it("keeps the seconds form for genuine sub-minute frequencies", () => {
    expect(nonceHealthCheckCronPattern(5)).toBe("*/5 * * * * *");
    expect(nonceHealthCheckCronPattern(30)).toBe("*/30 * * * * *");
  });

  it("steps the HOURS field for whole-hour frequencies (minutes field also caps at 59)", () => {
    expect(nonceHealthCheckCronPattern(3600)).toBe("0 0 */1 * * *");
    expect(nonceHealthCheckCronPattern(7200)).toBe("0 0 */2 * * *");
  });

  it("fails loud instead of silently emitting a pattern that fires at the wrong rate", () => {
    // Was the footgun: these used to fall through to a seconds/minutes step that
    // collapses (e.g. 90 -> */90 -> every 60s; 7200 as */120 min -> hourly).
    expect(() => nonceHealthCheckCronPattern(90)).toThrow(); // not a whole minute
    expect(() => nonceHealthCheckCronPattern(45)).toThrow(); // sub-minute, doesn't divide 60
    expect(() => nonceHealthCheckCronPattern(5400)).toThrow(); // 90 min, over an hour, not whole hours
    expect(() => nonceHealthCheckCronPattern(0)).toThrow();
    expect(() => nonceHealthCheckCronPattern(-60)).toThrow();
    expect(() => nonceHealthCheckCronPattern(1.5)).toThrow();
  });

  it("defaults the worker to a 5-minute cadence", () => {
    expect(NONCE_HEALTH_CHECK_FREQUENCY_SECONDS).toBe(300);
    expect(
      nonceHealthCheckCronPattern(NONCE_HEALTH_CHECK_FREQUENCY_SECONDS),
    ).toBe("0 */5 * * * *");
  });
});
