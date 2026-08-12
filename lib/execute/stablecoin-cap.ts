import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { supportedTokens } from "@/lib/db/schema";
import { getDefaultStablecoinTransferCapMicroUsd } from "@/lib/execute/spend-cap-defaults";
import { logSecurityEvent } from "@/lib/logging";

const MICRO_USD_DECIMALS = 6;

/**
 * `invalid` is caller error (an amount that will not parse); `over_cap` is a
 * policy denial. Kept apart so a route can answer 400 vs 403 rather than
 * collapsing a malformed request into "cap exceeded".
 */
export type StablecoinCapDecision =
  | { kind: "allowed" }
  | { kind: "invalid"; error: string }
  | { kind: "over_cap"; error: string };

const ALLOWED = { kind: "allowed" } as const;

const DECIMAL_INTEGER_RE = /^-?\d+$/;
const HEX_INTEGER_RE = /^0x[0-9a-fA-F]+$/;
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The token entry points that let value leave the org's wallet. `transfer` and
 * `transferFrom` move tokens now; `approve` hands a third party the standing
 * right to move them later. The `WithMemo` pair is TIP-20 (Tempo), where they
 * are the ordinary way to send: the memo rides along and the amount sits one
 * argument earlier than in the ERC-20 forms.
 */
const ERC20_OUTFLOW_ABI = [
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
  "function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo)",
] as const;

let cachedErc20Interface: ethers.Interface | null = null;

// Built on first use, not at module load: this module is imported by the
// workflow step cores, and constructing an Interface eagerly would make merely
// importing them depend on ethers being fully initialised.
function getErc20Interface(): ethers.Interface {
  cachedErc20Interface ??= new ethers.Interface(ERC20_OUTFLOW_ABI);
  return cachedErc20Interface;
}

function isHexAddress(value: string): boolean {
  return HEX_ADDRESS_RE.test(value);
}

type OutflowFn =
  | "transfer"
  | "transferFrom"
  | "approve"
  | "transferWithMemo"
  | "transferFromWithMemo";

type OutflowShape = {
  inputTypes: readonly string[];
  // Which argument carries the amount. Not always the last one: the TIP-20
  // memo variants append a bytes32 after it.
  amountIndex: number;
};

const OUTFLOW_SHAPES: Readonly<Record<OutflowFn, OutflowShape>> = {
  transfer: { inputTypes: ["address", "uint256"], amountIndex: 1 },
  transferFrom: {
    inputTypes: ["address", "address", "uint256"],
    amountIndex: 2,
  },
  approve: { inputTypes: ["address", "uint256"], amountIndex: 1 },
  transferWithMemo: {
    inputTypes: ["address", "uint256", "bytes32"],
    amountIndex: 1,
  },
  transferFromWithMemo: {
    inputTypes: ["address", "address", "uint256", "bytes32"],
    amountIndex: 2,
  },
};

type StablecoinToken = { decimals: number; symbol: string };

/**
 * Bound the stablecoin value a single call can move out of the org's wallet.
 *
 * The daily value cap counts NATIVE value only: an ERC-20 call carries a
 * `value` of 0, so a token move reserves 0 against it and a leaked key could
 * move an unbounded amount of USDC while the cap read zero. Pricing arbitrary
 * ERC-20s needs an oracle in the pre-broadcast path, but stablecoins do not:
 * their decimals are recorded in `supported_tokens` and the peg is ~1:1, so the
 * amount converts to USD by rescaling alone.
 *
 * Only tokens the registry knows AND flags as a stablecoin are bounded. An
 * unrecognised token address passes through -- that is the general ERC-20 case,
 * which this deliberately does not attempt to price.
 *
 * The checks live in the shared cores (transferTokenCore, writeContractCore,
 * signTempoTx) rather than in any one route, so every entrance reaches them:
 * /api/execute/transfer, /api/execute/contract-call, /api/execute/[...slug],
 * /api/execute/check-and-execute, /api/execute/node, and the workflow steps
 * those cores back. A ceiling on one route would only have told an attacker
 * which door to use.
 */

/** Human-decimal amount, e.g. "250.5", as the transfer-token path supplies it. */
export async function checkStablecoinTransferAmount(params: {
  organizationId: string;
  chainId: number;
  tokenAddress: string;
  amount: string;
  context: string;
}): Promise<StablecoinCapDecision> {
  const token = await loadStablecoin(params.chainId, params.tokenAddress);
  if (!token) {
    return ALLOWED;
  }

  let amountBase: bigint;
  try {
    amountBase = ethers.parseUnits(params.amount, token.decimals);
  } catch {
    return {
      kind: "invalid",
      error: `Invalid ${token.symbol} amount: ${params.amount}`,
    };
  }

  return decide({ ...params, token, amountBase, fn: "transfer" });
}

/**
 * A decoded contract call, as `writeContractCore` has it: an ABI function plus
 * already-coerced argument values.
 */
export async function checkStablecoinContractCall(params: {
  organizationId: string;
  chainId: number;
  contractAddress: string;
  functionName: string;
  inputTypes: readonly string[];
  args: readonly unknown[];
  context: string;
}): Promise<StablecoinCapDecision> {
  const fn = matchOutflowFunction(params.functionName, params.inputTypes);
  if (!fn) {
    return ALLOWED;
  }

  const token = await loadStablecoin(params.chainId, params.contractAddress);
  if (!token) {
    return ALLOWED;
  }

  const amountBase = toBaseUnits(params.args[OUTFLOW_SHAPES[fn].amountIndex]);
  if (amountBase === null) {
    // The call is a stablecoin outflow whose size cannot be read. Passing it
    // through would be an unbounded move, so refuse instead.
    return {
      kind: "invalid",
      error: `Could not read the ${token.symbol} amount from the ${fn} arguments`,
    };
  }

  return decide({
    ...params,
    tokenAddress: params.contractAddress,
    token,
    amountBase,
    fn,
  });
}

/**
 * Raw calldata, as the Tempo path has it: Tempo transactions carry a list of
 * `{ to, data }` calls with no ABI alongside, and TIP-20 stablecoins are the
 * chain's primary asset.
 */
export async function checkStablecoinCalldata(params: {
  organizationId: string;
  chainId: number;
  to: string;
  data: string;
  context: string;
}): Promise<StablecoinCapDecision> {
  const decoded = decodeErc20Outflow(params.data);
  if (!decoded) {
    return ALLOWED;
  }

  const token = await loadStablecoin(params.chainId, params.to);
  if (!token) {
    return ALLOWED;
  }

  return decide({
    ...params,
    tokenAddress: params.to,
    token,
    amountBase: decoded.amountBase,
    fn: decoded.fn,
  });
}

function decide(params: {
  organizationId: string;
  chainId: number;
  tokenAddress: string;
  token: StablecoinToken;
  amountBase: bigint;
  fn: OutflowFn;
  context: string;
}): StablecoinCapDecision {
  const { token, amountBase, fn } = params;

  if (amountBase < BigInt(0)) {
    return {
      kind: "invalid",
      error: `${token.symbol} amount must not be negative`,
    };
  }

  const microUsd = rescaleToMicroUsd(amountBase, token.decimals);
  const capMicroUsd = BigInt(getDefaultStablecoinTransferCapMicroUsd());
  if (microUsd <= capMicroUsd) {
    return ALLOWED;
  }

  // An approval moves nothing by itself, and max-uint approvals are how nearly
  // every DeFi integration works, so refusing them would break legitimate
  // workflows wholesale. It is still a standing right to drain the wallet, so
  // it is reported rather than silently allowed. Turning this into a denial
  // needs a spender allowlist, which is a product decision, not a bug fix.
  const blocked = fn !== "approve";
  const verb = fn === "approve" ? "approval" : "transfer";

  logSecurityEvent(
    blocked
      ? "stablecoin_transfer_cap_exceeded"
      : "stablecoin_approval_above_cap",
    {
      organizationId: params.organizationId,
      surface: params.context,
      chainId: params.chainId,
      tokenAddress: params.tokenAddress.toLowerCase(),
      symbol: token.symbol,
      erc20Function: fn,
      amountMicroUsd: microUsd.toString(),
      capMicroUsd: capMicroUsd.toString(),
      blocked,
    }
  );

  if (!blocked) {
    return ALLOWED;
  }

  return {
    kind: "over_cap",
    error: `Stablecoin ${verb} of ${formatMicroUsd(microUsd)} ${token.symbol} exceeds the ${formatMicroUsd(capMicroUsd)} USD per-transaction limit`,
  };
}

/** The registry row for a known stablecoin on this chain, or null. */
async function loadStablecoin(
  chainId: number,
  tokenAddress: string
): Promise<StablecoinToken | null> {
  if (!isHexAddress(tokenAddress)) {
    return null;
  }

  // Read the chain's whole token list (a handful of rows, on the chain_id
  // index) and match in JS. `supported_tokens.token_address` is seeded
  // lowercase but a resolved address is often checksummed, and an exact SQL
  // comparison against the wrong casing would silently find nothing -- which,
  // for a cap, means failing open.
  const rows = await db
    .select({
      tokenAddress: supportedTokens.tokenAddress,
      decimals: supportedTokens.decimals,
      symbol: supportedTokens.symbol,
      isStablecoin: supportedTokens.isStablecoin,
    })
    .from(supportedTokens)
    .where(eq(supportedTokens.chainId, chainId));

  const wanted = tokenAddress.toLowerCase();
  const token = rows.find(
    (row) => row.tokenAddress.toLowerCase() === wanted && row.isStablecoin
  );
  return token ? { decimals: token.decimals, symbol: token.symbol } : null;
}

function isOutflowName(name: string): name is OutflowFn {
  return Object.hasOwn(OUTFLOW_SHAPES, name);
}

function matchOutflowFunction(
  functionName: string,
  inputTypes: readonly string[]
): OutflowFn | null {
  // `abiFunction` may arrive fully qualified ("transfer(address,uint256)").
  const parenIndex = functionName.indexOf("(");
  const bareName = (
    parenIndex === -1 ? functionName : functionName.slice(0, parenIndex)
  ).trim();

  if (!isOutflowName(bareName)) {
    return null;
  }

  // A same-named function with a different signature is a different function.
  const expected = OUTFLOW_SHAPES[bareName].inputTypes;
  if (
    inputTypes.length !== expected.length ||
    !inputTypes.every((type, index) => type === expected[index])
  ) {
    return null;
  }
  return bareName;
}

function decodeErc20Outflow(
  data: string
): { fn: OutflowFn; amountBase: bigint } | null {
  if (!data?.startsWith("0x")) {
    return null;
  }

  let parsed: ethers.TransactionDescription | null = null;
  try {
    parsed = getErc20Interface().parseTransaction({ data });
  } catch {
    return null;
  }

  const fn = matchOutflowFunction(
    parsed?.name ?? "",
    parsed?.fragment.inputs.map((input) => input.type) ?? []
  );
  if (!(parsed && fn)) {
    return null;
  }

  const amountBase = toBaseUnits(parsed.args[OUTFLOW_SHAPES[fn].amountIndex]);
  return amountBase === null ? null : { fn, amountBase };
}

/** Coerce an ABI uint256 argument, however the caller expressed it, to bigint. */
function toBaseUnits(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!(DECIMAL_INTEGER_RE.test(trimmed) || HEX_INTEGER_RE.test(trimmed))) {
    return null;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Restate a token base-unit amount as micro-USD, relying on the ~1:1 peg. Both
 * directions are exact integer rescales: no rounding is applied, so a
 * sub-micro-USD remainder on a high-decimal stablecoin is truncated, which can
 * only ever lower the figure by less than one millionth of a dollar.
 */
function rescaleToMicroUsd(amountBase: bigint, decimals: number): bigint {
  if (decimals === MICRO_USD_DECIMALS) {
    return amountBase;
  }
  if (decimals > MICRO_USD_DECIMALS) {
    return amountBase / BigInt(10) ** BigInt(decimals - MICRO_USD_DECIMALS);
  }
  return amountBase * BigInt(10) ** BigInt(MICRO_USD_DECIMALS - decimals);
}

/** Render micro-USD as a plain decimal string, e.g. 200000000 -> "200.00". */
function formatMicroUsd(microUsd: bigint): string {
  const scale = BigInt(10) ** BigInt(MICRO_USD_DECIMALS);
  const whole = microUsd / scale;
  const cents = (microUsd % scale) / BigInt(10_000);
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}
