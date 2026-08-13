// Fork patch (idle-rpc): sane default cron cadences for a fresh configuration
// row. Upstream defaults both of these to `*/5 * * * * *` (every 5 seconds),
// which burns metered RPC at idle — each tick fans out per-key/per-wallet
// eth_* calls (see PLAN_2026-07-21_idle-rpc-burn.md, Phase 1b). Crucially these
// defaults RE-SEED on every new environment, so patching them in the fork (not
// just via a live config API push) is what makes the fix travel forward.
//
// `0 * * * * *` = second 0 of every minute (once a minute, down from 12×/min).
// A seconds-field step like `*/60` collapses to the same thing, but `0 * * * * *`
// states it plainly and can't be mistaken for "every 60 (seconds)".
export const DEFAULT_MINED_TX_LISTENER_CRON = "0 * * * * *"; // was "*/5 * * * * *"
export const DEFAULT_INDEXER_LISTENER_CRON = "0 * * * * *"; // was "*/5 * * * * *"
