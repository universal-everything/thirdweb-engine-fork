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

const { acquireNonce, addSentNonce, lastUsedNonceKey, recycleNonceGaps } =
  await import("../../src/shared/db/wallets/wallet-nonce");
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
