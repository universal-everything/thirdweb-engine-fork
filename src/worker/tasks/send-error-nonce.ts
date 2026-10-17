import type { Job } from "bullmq";
import type { Address } from "thirdweb";
import {
  recycleNonce,
  recycleNonceGaps,
  syncLatestNonceFromOnchainIfHigher,
} from "../../shared/db/wallets/wallet-nonce";
import {
  isNonceAlreadyUsedError,
  isNonceTooHighError,
  isReplacementGasFeeTooLow,
} from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";

/**
 * After the RPC rejected a send, put the wallet's nonce state right.
 * PATCH (DEV-16631): extracted from `_sendTransaction` so the "nonce too high"
 * gap healing is unit-tested; upstream behaviour otherwise unchanged.
 */
export const _reconcileNonceAfterSendError = async (args: {
  job: Pick<Job, "log">;
  error: unknown;
  chainId: number;
  from: Address;
  nonce: number;
  queueId: string;
}) => {
  const { job, error, chainId, from, nonce, queueId } = args;
  // If the nonce is already seen onchain (nonce too low) or in mempool (replacement underpriced),
  // correct the DB nonce.
  if (isNonceAlreadyUsedError(error) || isReplacementGasFeeTooLow(error)) {
    const result = await syncLatestNonceFromOnchainIfHigher(chainId, from);
    job.log(`Re-synced nonce: ${result}`);
  } else {
    // Otherwise this nonce is not used yet. Recycle it to be used by a future transaction.
    job.log(`Recycling nonce: ${nonce}`);
    await recycleNonce(chainId, from, nonce);

    // PATCH (DEV-16631): "nonce too high" = an earlier nonce was never sent.
    // Recycle the gap now so this job's retry (and every other queued send)
    // takes the missing nonce first, instead of failing forever.
    if (isNonceTooHighError(error)) {
      const healed = await recycleNonceGaps(chainId, from);
      job.log(
        `Nonce gap: onchain=${healed.lastUsedNonceOnchain} db=${healed.lastUsedNonceDb} recycled=[${healed.recycled.join(",")}]`,
      );
      logger({
        level: "warn",
        service: "worker",
        queueId,
        message: `[sendTransactionWorker] nonce gap healed wallet=${chainId}:${from} onchain=${healed.lastUsedNonceOnchain} db=${healed.lastUsedNonceDb} recycled=[${healed.recycled.join(",")}]`,
      });
    }
  }
};
