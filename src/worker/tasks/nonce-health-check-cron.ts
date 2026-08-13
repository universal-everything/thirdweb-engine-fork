// Fork patch (idle-rpc): nonce-health-check cadence. Upstream ran every 60s,
// issuing one eth_getTransactionCount per used backend wallet each tick — pure
// idle RPC burn at our transaction volume (see PLAN_2026-07-21_idle-rpc-burn.md
// Phase 2). Relaxed to every 5 minutes.
//
// IMPORTANT cron subtlety: BullMQ repeat patterns are 6-field (sec min hour dom
// mon dow) and a step in the SECONDS field only ranges 0-59. So `*/300 * * * * *`
// (and even the old `*/60 * * * * *`) collapse to "second 0 of every minute" —
// bumping the seconds constant alone is a no-op. A multi-minute cadence must be
// expressed in the MINUTES field, which `nonceHealthCheckCronPattern` does.

// NOTE: the worker flags a nonce stuck only after CHECK_PERIODS (=5) consecutive
// bad ticks, so the stuck-nonce detection window is cadence × CHECK_PERIODS.
// At 300s that's ~25 min (was ~5 min at the old 60s). Accepted trade-off for the
// idle-RPC saving; retune CHECK_PERIODS if faster detection is needed.
export const NONCE_HEALTH_CHECK_FREQUENCY_SECONDS = 300; // every 5 minutes (was 60)

// Build a valid BullMQ 6-field cron pattern (sec min hour dom mon dow) for a
// health-check frequency. A cron step "*<slash>N" only ranges over its field's
// bounds, so a divisor bigger than the field max silently collapses to "match
// index 0" — the exact bug this fixes (a seconds-field "*<slash>300" fires every
// minute, not every 5). We therefore express each magnitude in the RIGHT field
// (seconds < 60, minutes < 60, hours < 24) and FAIL LOUD for any frequency a
// single cron step can't represent faithfully, rather than emitting a pattern
// that quietly fires at the wrong rate. (Line comments on purpose — a literal
// cron step contains the block-comment terminator.)
export function nonceHealthCheckCronPattern(frequencySeconds: number): string {
  if (!Number.isInteger(frequencySeconds) || frequencySeconds < 1) {
    throw new Error(
      `nonceHealthCheckCronPattern: expected a positive integer number of seconds, got ${frequencySeconds}`,
    );
  }
  // Sub-minute: step the seconds field. Must divide 60 evenly, else it fires
  // irregularly at each minute boundary (and any divisor > 59 collapses).
  if (frequencySeconds < 60) {
    if (60 % frequencySeconds !== 0) {
      throw new Error(
        `nonceHealthCheckCronPattern: sub-minute frequency ${frequencySeconds}s must divide 60`,
      );
    }
    return `*/${frequencySeconds} * * * * *`;
  }
  if (frequencySeconds % 60 !== 0) {
    throw new Error(
      `nonceHealthCheckCronPattern: frequency ${frequencySeconds}s is not a whole number of minutes`,
    );
  }
  const minutes = frequencySeconds / 60;
  // Whole minutes < 60: step the minutes field.
  if (minutes <= 59) {
    return `0 */${minutes} * * * *`;
  }
  if (minutes % 60 !== 0) {
    throw new Error(
      `nonceHealthCheckCronPattern: frequency ${frequencySeconds}s is over an hour but not a whole number of hours`,
    );
  }
  const hours = minutes / 60;
  // Whole hours < 24: step the hours field.
  if (hours <= 23) {
    return `0 0 */${hours} * * *`;
  }
  throw new Error(
    `nonceHealthCheckCronPattern: frequency ${frequencySeconds}s exceeds a day; author the cron pattern explicitly`,
  );
}
