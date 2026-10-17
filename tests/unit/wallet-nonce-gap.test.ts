import Redis from "ioredis";
import type { Address } from "thirdweb";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH (universal-relayer DEV-16631): nonce gaps.
 *
 * Prod 2026-10-16: two sends from a wallet's FIRST use on a chain raced the
 * upstream "INCR returned 1 ⇒ unset ⇒ sync" heuristic — nonce 1 was never
 * issued and every later send failed "nonce too high". These tests run the
 * real nonce code against a REAL Redis (REDIS_TEST_URL, default
 * redis://localhost:6390/15 — a throwaway instance; the DB is flushed) with
 * only the onchain read stubbed.
 */
const REDIS_TEST_URL =
  process.env.REDIS_TEST_URL ?? "redis://localhost:6390/15";
const testRedis = new Redis(REDIS_TEST_URL, { maxRetriesPerRequest: 1 });

const onchain = vi.hoisted(() => ({ count: 0, delayMs: 0, calls: 0 }));

vi.mock("../../src/shared/utils/redis/redis", () => ({ redis: testRedis }));
vi.mock("../../src/shared/utils/chain", () => ({
  getChain: async (id: number) => ({ id }),
}));
vi.mock("../../src/shared/utils/sdk", () => ({ thirdwebClient: {} }));
vi.mock("../../src/shared/utils/logger", () => ({ logger: () => {} }));
vi.mock("../../src/shared/db/wallets/nonce-map", () => ({
  updateNonceMap: async () => {},
}));
vi.mock("../../src/worker/tasks/nonce-health-check-worker", () => ({
  nonceHistoryKey: (c: number, w: string) => `nonce-history:${c}:${w}`,
}));
vi.mock("../../src/shared/utils/primitive-types", () => ({
  normalizeAddress: (a: string) => a.toLowerCase(),
}));
vi.mock("thirdweb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("thirdweb")>()),
  getRpcClient: () => ({}),
  eth_getTransactionCount: async () => {
    onchain.calls++;
    // The onchain read is the await the old heuristic raced across.
    if (onchain.delayMs)
      await new Promise((r) => setTimeout(r, onchain.delayMs));
    return onchain.count;
  },
}));

const {
  ACQUIRED_NONCE_GRACE_MS,
  acquiredNoncesKey,
  acquireNonce,
  addSentNonce,
  lastUsedNonceKey,
  recycleNonce,
  recycleNonceGaps,
} = await import("../../src/shared/db/wallets/wallet-nonce");
const { isNonceTooHighError } = await import("../../src/shared/utils/error");
const { _reconcileNonceAfterSendError } = await import(
  "../../src/worker/tasks/send-error-nonce"
);

const CHAIN = 42161;
const WALLET = "0xa7d5b00162a7040a924f13369a154f22b478777c" as Address;

beforeEach(async () => {
  await testRedis.flushdb();
  onchain.count = 0;
  onchain.delayMs = 0;
  onchain.calls = 0;
});

afterAll(async () => {
  await testRedis.flushdb();
  testRedis.disconnect();
});

const acquire = (i: number) =>
  acquireNonce({ queueId: `q${i}`, chainId: CHAIN, walletAddress: WALLET });

describe("acquireNonce — first use on a chain (DEV-16631)", () => {
  it("concurrent first sends get contiguous nonces from the onchain count — no gap", async () => {
    onchain.count = 0;
    onchain.delayMs = 25;
    const got = await Promise.all([0, 1, 2, 3, 4].map(acquire));
    expect(got.map((g) => g.nonce).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it("starts from the onchain count for a wallet that has sent before", async () => {
    onchain.count = 7;
    onchain.delayMs = 10;
    const got = await Promise.all([0, 1, 2].map(acquire));
    expect(got.map((g) => g.nonce).sort((a, b) => a - b)).toEqual([7, 8, 9]);
  });

  it("an existing counter is incremented without an onchain read", async () => {
    await testRedis.set(lastUsedNonceKey(CHAIN, WALLET), 5);
    expect((await acquire(0)).nonce).toBe(6);
    expect(onchain.calls).toBe(0);
  });
});

describe("recycleNonceGaps — heal 'nonce too high' (DEV-16631)", () => {
  it("recycles the skipped nonces so the next acquires fill the gap, lowest first", async () => {
    // The prod state: onchain used nonce 0 (count 1); counter issued up to 2.
    onchain.count = 1;
    await testRedis.set(lastUsedNonceKey(CHAIN, WALLET), 2);
    const healed = await recycleNonceGaps(CHAIN, WALLET);
    expect(healed).toEqual({
      lastUsedNonceOnchain: 0,
      lastUsedNonceDb: 2,
      recycled: [1, 2],
    });
    expect((await acquire(0)).nonce).toBe(1);
    expect((await acquire(1)).nonce).toBe(2);
    expect((await acquire(2)).nonce).toBe(3);
  });

  it("leaves an in-flight (sent) nonce alone", async () => {
    onchain.count = 1;
    await testRedis.set(lastUsedNonceKey(CHAIN, WALLET), 2);
    await addSentNonce(CHAIN, WALLET, 2);
    expect((await recycleNonceGaps(CHAIN, WALLET)).recycled).toEqual([1]);
  });

  it("recycles nothing when the counter matches the chain", async () => {
    onchain.count = 3;
    await testRedis.set(lastUsedNonceKey(CHAIN, WALLET), 2);
    expect((await recycleNonceGaps(CHAIN, WALLET)).recycled).toEqual([]);
  });
});

describe("isNonceTooHighError", () => {
  it("matches the RPC error Engine logged in prod", () => {
    const error = new Error(
      "nonce too high: address 0xa7d5B00162a7040A924f13369A154f22B478777C, tx: 2 state: 1",
    );
    expect(isNonceTooHighError(error)).toBe(true);
  });

  it("does not match a nonce-too-low or unrelated error", () => {
    expect(isNonceTooHighError(new Error("nonce too low"))).toBe(false);
    expect(isNonceTooHighError(new Error("insufficient funds"))).toBe(false);
  });
});

describe("_reconcileNonceAfterSendError — the send worker's catch (DEV-16631)", () => {
  const job = { log: vi.fn() };
  const recycled = () =>
    testRedis.zrange(`nonce-recycled:${CHAIN}:${WALLET}`, 0, -1);

  it("'nonce too high' recycles this nonce AND the gap, so the retry takes the missing one", async () => {
    onchain.count = 1;
    await testRedis.set(lastUsedNonceKey(CHAIN, WALLET), 2);
    await _reconcileNonceAfterSendError({
      job,
      error: new Error("nonce too high: address 0xa7d5…, tx: 2 state: 1"),
      chainId: CHAIN,
      from: WALLET,
      nonce: 2,
      queueId: "q",
    });
    expect(await recycled()).toEqual(["1", "2"]);
    expect((await acquire(0)).nonce).toBe(1);
  });

  it("any other send error only recycles its own nonce (upstream behaviour)", async () => {
    onchain.count = 1;
    await testRedis.set(lastUsedNonceKey(CHAIN, WALLET), 2);
    await _reconcileNonceAfterSendError({
      job,
      error: new Error("execution reverted"),
      chainId: CHAIN,
      from: WALLET,
      nonce: 2,
      queueId: "q",
    });
    expect(await recycled()).toEqual(["2"]);
    expect(onchain.calls).toBe(0);
  });
});

// Review finding (#1): "nonce too high" also fires when tx N+1 reaches the
// node before tx N — normal with concurrent sends. N is then held by another
// job (acquired, not yet sent), not missing; recycling it would hand it out
// twice.
describe("gap healing never recycles a nonce another job holds (DEV-16631)", () => {
  const job = { log: vi.fn() };
  const recycledSet = () =>
    testRedis.zrange(`nonce-recycled:${CHAIN}:${WALLET}`, 0, -1);

  it("out-of-order 'nonce too high' recycles only the failing job's own nonce", async () => {
    onchain.count = 0;
    // Three concurrent jobs hold 0, 1, 2; none sent yet.
    await Promise.all([0, 1, 2].map(acquire));
    // Job 2 hits the node first → "nonce too high".
    await _reconcileNonceAfterSendError({
      job,
      error: new Error("nonce too high: address 0xa7d5…, tx: 2 state: 0"),
      chainId: CHAIN,
      from: WALLET,
      nonce: 2,
      queueId: "q2",
    });
    expect(await recycledSet()).toEqual(["2"]);
  });

  it("an acquired nonce abandoned past the grace period is recycled", async () => {
    onchain.count = 0;
    await Promise.all([0, 1].map(acquire));
    const later = Date.now() + ACQUIRED_NONCE_GRACE_MS + 1_000;
    expect((await recycleNonceGaps(CHAIN, WALLET, later)).recycled).toEqual([
      0, 1,
    ]);
  });

  it("sending or recycling a nonce clears its acquired mark", async () => {
    onchain.count = 0;
    await Promise.all([0, 1].map(acquire));
    await addSentNonce(CHAIN, WALLET, 0);
    await recycleNonce(CHAIN, WALLET, 1);
    expect(
      await testRedis.zrange(acquiredNoncesKey(CHAIN, WALLET), 0, -1),
    ).toEqual([]);
  });

  it("prunes held marks for nonces the chain already used", async () => {
    onchain.count = 0;
    await Promise.all([0, 1, 2].map(acquire));
    onchain.count = 2; // 0 and 1 landed (e.g. via an "already used" re-sync)
    await recycleNonceGaps(CHAIN, WALLET);
    expect(
      await testRedis.zrange(acquiredNoncesKey(CHAIN, WALLET), 0, -1),
    ).toEqual(["2"]);
  });

  it("a recycled nonce is re-issued first and marked held again", async () => {
    onchain.count = 0;
    await Promise.all([0, 1, 2].map(acquire));
    await recycleNonce(CHAIN, WALLET, 1);
    const again = await acquire(9);
    expect(again).toEqual({ nonce: 1, isRecycledNonce: true });
    expect(
      await testRedis.zscore(acquiredNoncesKey(CHAIN, WALLET), "1"),
    ).not.toBeNull();
  });
});

// Prod 2026-10-17, after #1/#2 shipped: the heal logged "onchain=0 db=0
// recycled=[]" and nonce 2 kept failing. The old engine had recycled 2 (so
// recycled pops first) while the counter read 0 — scanning only up to the
// counter found no gap.
describe("gap healing when the handed-out nonce sits above the counter (DEV-16631)", () => {
  const job = { log: vi.fn() };

  it("prod state: counter 0, recycled {2}, chain at 1 → nonce 1 goes out next, then 2, then 3", async () => {
    onchain.count = 1;
    await testRedis.set(lastUsedNonceKey(CHAIN, WALLET), 0);
    await recycleNonce(CHAIN, WALLET, 2);
    // The retry loop: acquire pops 2, the RPC says too high.
    const first = await acquire(0);
    expect(first.nonce).toBe(2);
    await _reconcileNonceAfterSendError({
      job,
      error: new Error("nonce too high: address 0xa7d5…, tx: 2 state: 1"),
      chainId: CHAIN,
      from: WALLET,
      nonce: 2,
      queueId: "q0",
    });
    expect((await acquire(1)).nonce).toBe(1);
    expect((await acquire(2)).nonce).toBe(2);
    // The counter was raised to what had been handed out: no re-issue of 1/2.
    expect((await acquire(3)).nonce).toBe(3);
  });

  it("never lowers the counter", async () => {
    onchain.count = 1;
    await testRedis.set(lastUsedNonceKey(CHAIN, WALLET), 9);
    await recycleNonceGaps(CHAIN, WALLET, Date.now(), 2);
    expect(await testRedis.get(lastUsedNonceKey(CHAIN, WALLET))).toBe("9");
  });

  it("stale recycled nonces the chain already used are dropped; the counter never goes below the chain", async () => {
    onchain.count = 3; // chain used 0..2
    // No counter at all, and a stale recycled 0 left behind.
    await recycleNonce(CHAIN, WALLET, 0);
    await recycleNonceGaps(CHAIN, WALLET);
    expect(
      await testRedis.zrange(`nonce-recycled:${CHAIN}:${WALLET}`, 0, -1),
    ).toEqual([]);
    expect(await testRedis.get(lastUsedNonceKey(CHAIN, WALLET))).toBe("2");
    expect((await acquire(0)).nonce).toBe(3);
  });
});
