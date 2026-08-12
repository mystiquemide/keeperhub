/**
 * Platform default value caps, applied whenever an organization has not
 * configured a cap of its own.
 *
 * Before these existed, a missing `organization_spend_caps` row -- or a null
 * column for one chain family -- meant unlimited. Only an admin visiting the
 * spend-cap UI ever created a row, so every organization was unlimited by
 * default and a leaked API key was bounded only by the wallet balance. The
 * caps below are the fail-closed floor: an organization must raise its own
 * ceiling deliberately rather than inherit an unbounded one.
 *
 * The two native figures are denominated in the native asset, NOT in USD, so
 * their USD worth drifts with the market: if ETH doubles, the real ceiling
 * doubles with it and nothing alerts. A Chainlink native/USD read does exist in
 * this codebase (`getNativeUsdPrice` in lib/safe/price-oracle.ts, 60s cached,
 * used pre-broadcast by the Safe simulate routes), but the reservation runs
 * inside a `SELECT ... FOR UPDATE` transaction and neither reservation entry
 * point carries a chain id -- `reserveOrgValue` has none at all -- so pricing
 * here would mean holding a row lock across an RPC round trip on a path that
 * has no chain to price. The figures are therefore fixed, chosen at the
 * reference price stated on each, and the drift is accepted deliberately.
 *
 * Each default can be overridden without a deploy, matching the
 * `AGENTIC_WALLET_DAILY_CAP_MICROS` convention, so an operator can widen the
 * floor if it turns out to bind a live integrator mid-flight.
 */

// 0.05 ETH. Chosen as roughly 200 USD at a 4,000 USD/ETH reference price, to
// line up with the 200 USD/day ceiling lib/agentic-wallet/daily-spend.ts
// already applies to agent-signed spend. Applies to every EVM chain, testnets
// included, because the ledger column it is compared against is chain-agnostic.
const DEFAULT_DAILY_VALUE_CAP_WEI = "50000000000000000";

// 1 SOL, roughly 200 USD at a 200 USD/SOL reference price. Same anchor.
const DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS = "1000000000";

// 200 USD in micro-USD (6 decimals), the unit stablecoins are compared in.
//
// Deliberately its own constant rather than a re-export of the agentic wallet's
// DEFAULT_DAILY_CAP_MICROS: that figure is a DAILY AGGREGATE for a different
// subsystem and this one bounds a SINGLE transfer, so they are not the same
// policy even though they were chosen from the same anchor. Coupling them would
// mean an edit to the agentic wallet's daily budget silently moved the
// execution API's per-transfer ceiling.
const DEFAULT_STABLECOIN_CAP_MICRO_USD = "200000000";

// BigInt() accepts hex-prefixed strings ("0x10" -> 16), so an ops typo would
// silently turn a cap into a near-zero one. Reject anything that is not a
// decimal digit run before it is used.
const DECIMAL_INTEGER_RE = /^\d+$/;

function resolveOverride(
  envValue: string | undefined,
  fallback: string
): string {
  if (!(envValue && DECIMAL_INTEGER_RE.test(envValue))) {
    return fallback;
  }
  return BigInt(envValue) > BigInt(0) ? envValue : fallback;
}

/** Default daily EVM native value cap, in wei. */
export function getDefaultDailyValueCapWei(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_DAILY_VALUE_CAP_WEI,
    DEFAULT_DAILY_VALUE_CAP_WEI
  );
}

/** Default daily Solana native value cap, in lamports. */
export function getDefaultDailySolanaValueCapLamports(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS,
    DEFAULT_DAILY_SOLANA_VALUE_CAP_LAMPORTS
  );
}

/**
 * Ceiling on a single stablecoin outflow, in micro-USD (6 decimals).
 *
 * Per transfer, not per day. A daily total would need a third unit column on
 * the value ledger (micro-USD alongside wei and lamports) and a reserve/settle
 * lifecycle for token moves; this bounds each individual move instead, which is
 * what the 1:1 peg and the recorded token decimals support with no oracle. The
 * residual is that the per-key rate limit, not this cap, bounds the aggregate.
 */
export function getDefaultStablecoinTransferCapMicroUsd(): string {
  return resolveOverride(
    process.env.EXECUTE_DEFAULT_STABLECOIN_CAP_MICRO_USD,
    DEFAULT_STABLECOIN_CAP_MICRO_USD
  );
}
