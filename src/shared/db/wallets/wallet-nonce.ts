import {
  eth_getTransactionCount,
  getAddress,
  getRpcClient,
  type Address,
} from "thirdweb";
import { getChain } from "../../utils/chain";
import { logger } from "../../utils/logger";
import { normalizeAddress } from "../../utils/primitive-types";
import { redis } from "../../utils/redis/redis";
import { thirdwebClient } from "../../utils/sdk";
import { updateNonceMap } from "./nonce-map";
import { nonceHistoryKey } from "../../../worker/tasks/nonce-health-check-worker";

/**
 * Get all used backend wallets.
 * Filters by chainId and walletAddress if provided.
 * Reads all the keys in the format `nonce:${chainId}:${walletAddress}` in the Redis DB.
 *
 * @example
 * getUsedBackendWallets()
 * // [ { chainId: 80001, walletAddress: "0x1234...5678" } ]
 */
export const getUsedBackendWallets = async (
  chainId?: number,
  walletAddress?: Address,
): Promise<
  {
    chainId: number;
    walletAddress: Address;
  }[]
> => {
  const keys = await redis.keys(
    `nonce:${chainId ?? "*"}:${
      walletAddress ? normalizeAddress(walletAddress) : "*"
    }`,
  );
  return keys.map((key) => {
    const tokens = key.split(":");
    return {
      chainId: Number.parseInt(tokens[1]),
      walletAddress: getAddress(tokens[2]),
    };
  });
};

/**
 * The "last used nonce" stores the last nonce submitted onchain.
 * Example: 25 -> nonce 25 is onchain, nonce 26 is unused or inflight.
 */
export const lastUsedNonceKey = (chainId: number, walletAddress: Address) =>
  `nonce:${chainId}:${normalizeAddress(walletAddress)}`;

/**
 * Split the last used nonce key into chainId and walletAddress.
 * @param key
 * @returns { chainId: number, walletAddress: Address }
 * @example
 * splitLastUsedNonceKey("nonce:80001:0x1234...5678")
 * // { chainId: 80001, walletAddress: "0x1234...5678" }
 */
export const splitLastUsedNonceKey = (key: string) => {
  const _splittedKeys = key.split(":");
  const walletAddress = normalizeAddress(_splittedKeys[2]);
  const chainId = Number.parseInt(_splittedKeys[1]);
  return { walletAddress, chainId };
};

/**
 * The "recycled nonces" set stores unsorted nonces to be reused or cancelled.
 * Example: [ "25", "23", "24" ]
 */
export const recycledNoncesKey = (chainId: number, walletAddress: Address) =>
  `nonce-recycled:${chainId}:${normalizeAddress(walletAddress)}`;

/**
 * The "sent nonces" set stores nonces that have been sent on chain but not yet mined.
 *
 * Example: [ "25", "23", "24" ]
 *
 * The `nonceResyncWorker` periodically fetches the onchain transaction count for each wallet (a),
 * compares it to the last nonce sent (b), and for every nonce between b and a,
 * it recycles the nonce if the nonce is not in this set.
 */
export const sentNoncesKey = (chainId: number, walletAddress: Address) =>
  `nonce-sent:${chainId}:${normalizeAddress(walletAddress)}`;

/**
 * PATCH (DEV-16631): nonces handed out by `acquireNonce` but not yet sent or
 * recycled, scored by acquire time (ms). `recycleNonceGaps` must not recycle
 * these — another job is signing/sending them — unless they are older than
 * `ACQUIRED_NONCE_GRACE_MS` (its worker died between acquire and send).
 */
export const acquiredNoncesKey = (chainId: number, walletAddress: Address) =>
  `nonce-acquired:${chainId}:${normalizeAddress(walletAddress)}`;

/** An acquired-but-unsent nonce older than this is treated as abandoned. */
export const ACQUIRED_NONCE_GRACE_MS = 5 * 60 * 1000;

/**
 * PATCH (DEV-16631): pop the lowest recycled nonce, else INCR the last-used
 * counter, and record it in the acquired set — atomically.
 * KEYS: recycled, lastUsed, acquired. ARGV: now (ms). Returns {nonce, recycled 0|1}.
 */
const ACQUIRE_NONCE_SCRIPT = `
local popped = redis.call('ZPOPMIN', KEYS[1])
local nonce
local recycled = 0
if #popped > 0 then
  nonce = tonumber(popped[1])
  recycled = 1
else
  nonce = redis.call('INCR', KEYS[2])
end
redis.call('ZADD', KEYS[3], ARGV[1], nonce)
return {nonce, recycled}
`;

export const splitSentNoncesKey = (key: string) => {
  const _splittedKeys = key.split(":");
  const walletAddress = normalizeAddress(_splittedKeys[2]);
  const chainId = Number.parseInt(_splittedKeys[1]);
  return { walletAddress, chainId };
};

/**
 * Adds a nonce to the sent nonces set (`nonce-sent:${chainId}:${walletAddress}`).
 */
export const addSentNonce = async (
  chainId: number,
  walletAddress: Address,
  nonce: number,
) => {
  const key = sentNoncesKey(chainId, walletAddress);
  await redis.sadd(key, nonce.toString());
  // PATCH (DEV-16631): sent ⇒ no longer merely acquired.
  await redis.zrem(acquiredNoncesKey(chainId, walletAddress), nonce.toString());
};

/**
 * Removes a nonce from the sent nonces set (`nonce-sent:${chainId}:${walletAddress}`).
 */
export const removeSentNonce = async (
  chainId: number,
  walletAddress: Address,
  nonce: number,
) => {
  const key = sentNoncesKey(chainId, walletAddress);
  const removed = await redis.srem(key, nonce.toString());
  return removed === 1;
};

/**
 * Check if a nonce is in the sent nonces set.
 */
export const isSentNonce = async (
  chainId: number,
  walletAddress: Address,
  nonce: number,
) => {
  const key = sentNoncesKey(chainId, walletAddress);
  return !!(await redis.sismember(key, nonce.toString()));
};

/**
 * Acquire an unused nonce to send an EOA transaction for the given backend wallet.
 * @param chainId
 * @param walletAddress
 * @returns number
 */
export const acquireNonce = async (args: {
  queueId: string;
  chainId: number;
  walletAddress: Address;
}): Promise<{ nonce: number; isRecycledNonce: boolean }> => {
  const { queueId, chainId, walletAddress } = args;

  // PATCH (universal-relayer DEV-16631): initialise an unset counter from the
  // chain BEFORE incrementing, atomically (SET NX). Upstream used
  // "INCR returned 1 ⇒ unset ⇒ sync from chain ⇒ INCR again", which races on
  // a wallet's first use on a chain: a concurrent INCR returns 2, skips the
  // sync, and nonce 1 is never issued — every later send fails "nonce too
  // high" (prod, 2026-10-16, Arbitrum).
  const lastUsedKey = lastUsedNonceKey(chainId, walletAddress);
  if (!(await redis.exists(lastUsedKey))) {
    await initLatestNonceFromOnchainIfUnset(chainId, walletAddress);
  }

  // Lowest recycled nonce first, else the next one — and mark it held, in ONE
  // atomic script so a concurrent gap heal can't see it issued-but-unmarked.
  const [nonce, recycledFlag] = (await redis.eval(
    ACQUIRE_NONCE_SCRIPT,
    3,
    recycledNoncesKey(chainId, walletAddress),
    lastUsedKey,
    acquiredNoncesKey(chainId, walletAddress),
    Date.now(),
  )) as [number, number];
  const isRecycledNonce = recycledFlag === 1;

  await updateNonceMap({
    chainId,
    walletAddress,
    nonce,
    queueId,
  });
  return { nonce, isRecycledNonce };
};

/**
 * Recycles a nonce to be used by a future transaction.
 * This should be used if the current transaction that acquired this nonce is not valid.
 * @param chainId
 * @param walletAddress
 * @param nonce
 */
export const recycleNonce = async (
  chainId: number,
  walletAddress: Address,
  nonce: number,
) => {
  if (Number.isNaN(nonce)) {
    logger({
      level: "warn",
      message: `[recycleNonce] Invalid nonce: ${nonce}`,
      service: "worker",
    });
    return;
  }

  const key = recycledNoncesKey(chainId, walletAddress);
  await redis.zadd(key, nonce, nonce.toString());
  // PATCH (DEV-16631): recycled ⇒ no longer held by its job.
  await redis.zrem(acquiredNoncesKey(chainId, walletAddress), nonce.toString());
};

/**
 * PATCH (DEV-16631): set the last-used nonce from the chain only if no other
 * caller set it first (SET NX). Concurrent first uses all read the same
 * transaction count; one write wins and every INCR after it is contiguous.
 */
export const initLatestNonceFromOnchainIfUnset = async (
  chainId: number,
  walletAddress: Address,
) => {
  const transactionCount = await _onchainTransactionCount(
    chainId,
    walletAddress,
  );
  const key = lastUsedNonceKey(chainId, walletAddress);
  await redis.set(key, transactionCount - 1, "NX");
};

/**
 * PATCH (DEV-16631): recycle every nonce between the last one used onchain and
 * the last one issued here that nobody holds — not in flight ("sent") and not
 * freshly acquired by a job that is still signing/sending it — so the next
 * `acquireNonce` fills the gap. A nonce acquired more than
 * `ACQUIRED_NONCE_GRACE_MS` ago without being sent counts as abandoned. What the upstream `nonceResyncWorker` does —
 * but that worker only visits wallets with an in-flight tx, and a wallet whose
 * sends all fail pre-broadcast ("nonce too high") has none, so it never healed.
 * Callable per wallet: the send worker runs it on "nonce too high".
 */
export const recycleNonceGaps = async (
  chainId: number,
  walletAddress: Address,
  now: number = Date.now(),
): Promise<{
  lastUsedNonceOnchain: number;
  lastUsedNonceDb: number;
  recycled: number[];
}> => {
  const lastUsedNonceOnchain =
    (await _onchainTransactionCount(chainId, walletAddress)) - 1;
  const lastUsedNonceDb = await inspectNonce(chainId, walletAddress);

  const heldSince = now - ACQUIRED_NONCE_GRACE_MS;
  const acquiredKey = acquiredNoncesKey(chainId, walletAddress);
  // Marks for nonces the chain already used are settled — drop them (e.g. an
  // "already used" send error re-syncs without clearing its mark).
  const settled = (await redis.zrange(acquiredKey, 0, -1)).filter(
    (n) => Number(n) <= lastUsedNonceOnchain,
  );
  if (settled.length > 0) await redis.zrem(acquiredKey, ...settled);
  const recycled: number[] = [];
  for (
    let nonce = lastUsedNonceOnchain + 1;
    nonce <= lastUsedNonceDb;
    nonce++
  ) {
    if (await isSentNonce(chainId, walletAddress, nonce)) continue;
    // "nonce too high" also fires when tx N+1 reaches the node before tx N —
    // normal with concurrent sends. N is then acquired, not missing.
    const acquiredAt = await redis.zscore(acquiredKey, nonce.toString());
    if (acquiredAt !== null && Number(acquiredAt) > heldSince) continue;
    await recycleNonce(chainId, walletAddress, nonce);
    recycled.push(nonce);
  }
  return { lastUsedNonceOnchain, lastUsedNonceDb, recycled };
};

const _onchainTransactionCount = async (
  chainId: number,
  walletAddress: Address,
) => {
  const rpcRequest = getRpcClient({
    client: thirdwebClient,
    chain: await getChain(chainId),
  });
  // The next unused nonce = transactionCount.
  return eth_getTransactionCount(rpcRequest, {
    address: walletAddress,
    blockTag: "latest",
  });
};

/**
 * Resync the nonce to the onchain nonce.
 * @TODO: Redis lock this to make this method safe to call concurrently.
 */
export const syncLatestNonceFromOnchain = async (
  chainId: number,
  walletAddress: Address,
) => {
  const rpcRequest = getRpcClient({
    client: thirdwebClient,
    chain: await getChain(chainId),
  });

  // The next unused nonce = transactionCount.
  const transactionCount = await eth_getTransactionCount(rpcRequest, {
    address: walletAddress,
    blockTag: "latest",
  });

  const key = lastUsedNonceKey(chainId, walletAddress);
  await redis.set(key, transactionCount - 1);
};

/**
 * Returns the last used nonce.
 * This function should be used to inspect nonce values only.
 * Use `acquireNonce` to fetch a nonce for sending a transaction.
 * @param chainId
 * @param walletAddress
 * @returns number
 */
export const inspectNonce = async (chainId: number, walletAddress: Address) => {
  const key = lastUsedNonceKey(chainId, walletAddress);
  const nonce = await redis.get(key);
  return nonce ? Number.parseInt(nonce) : 0;
};

/**
 * Delete nonce state for the provided wallets.
 * @param backendWallets
 */
export async function deleteNoncesForBackendWallets(
  backendWallets: { chainId: number; walletAddress: Address }[],
) {
  const keys = backendWallets.flatMap(({ chainId, walletAddress }) => [
    lastUsedNonceKey(chainId, walletAddress),
    recycledNoncesKey(chainId, walletAddress),
    sentNoncesKey(chainId, walletAddress),
    acquiredNoncesKey(chainId, walletAddress),
    nonceHistoryKey(chainId, walletAddress),
  ]);
  await redis.del(keys);
}

/**
 * Resync the nonce to the higher of (db nonce, onchain nonce).
 */
export const syncLatestNonceFromOnchainIfHigher = async (
  chainId: number,
  walletAddress: Address,
) => {
  const rpcRequest = getRpcClient({
    client: thirdwebClient,
    chain: await getChain(chainId),
  });

  // The next unused nonce = transactionCount.
  const transactionCount = await eth_getTransactionCount(rpcRequest, {
    address: walletAddress,
    blockTag: "latest",
  });

  // Lua script to update the DB nonce only if the onchain nonce is higher.
  const script = `
    local transactionCount = tonumber(ARGV[1])
    local lastUsedNonce = tonumber(redis.call('get', KEYS[1])) or 0
    local nextNonce = math.max(transactionCount-1, lastUsedNonce)
    redis.call('set', KEYS[1], nextNonce)
    return nextNonce
  `;
  const lastUsedNonce = await redis.eval(
    script,
    1,
    lastUsedNonceKey(chainId, normalizeAddress(walletAddress)),
    transactionCount.toString(),
  );
  return lastUsedNonce;
};
