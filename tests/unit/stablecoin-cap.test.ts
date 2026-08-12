import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Hoisted registry rows the fake supported_tokens lookup returns, set per test.
const state = vi.hoisted(() => ({
  tokenRows: [] as Array<{
    tokenAddress: string;
    decimals: number;
    symbol: string;
    isStablecoin: boolean;
  }>,
  selectCalls: 0,
}));

// Fake db serving the chain's supported_tokens list, which the cap then matches
// against in JS: select(...).from(...).where(...).
vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      state.selectCalls += 1;
      return {
        from: () => ({
          where: () => Promise.resolve(state.tokenRows),
        }),
      };
    },
  },
}));

import { getDefaultStablecoinTransferCapMicroUsd } from "@/lib/execute/spend-cap-defaults";
import {
  checkStablecoinCalldata,
  checkStablecoinContractCall,
  checkStablecoinTransferAmount,
} from "@/lib/execute/stablecoin-cap";

const CAP_MICRO_USD = BigInt(getDefaultStablecoinTransferCapMicroUsd());
// The cap in whole dollars, used to build amounts either side of it.
const CAP_USD = CAP_MICRO_USD / BigInt(1_000_000);

// The registry seeds addresses lowercase; callers usually resolve checksummed
// ones, so the two casings must still meet.
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

const USDC = {
  tokenAddress: USDC_ADDRESS.toLowerCase(),
  decimals: 6,
  symbol: "USDC",
  isStablecoin: true,
};
const DAI = {
  tokenAddress: USDC_ADDRESS.toLowerCase(),
  decimals: 18,
  symbol: "DAI",
  isStablecoin: true,
};

const transferParams = {
  organizationId: "org_1",
  chainId: 1,
  tokenAddress: USDC_ADDRESS,
  context: "test",
};

const erc20 = new ethers.Interface([
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function approve(address spender, uint256 amount)",
  "function transferWithMemo(address to, uint256 amount, bytes32 memo)",
  "function deposit(uint256 amount)",
]);

const MEMO = `0x${"0".repeat(64)}`;

/** Base units of a whole-dollar figure at the token's decimals. */
function units(dollars: bigint, decimals: number): string {
  return (dollars * BigInt(10) ** BigInt(decimals)).toString();
}

beforeEach(() => {
  state.tokenRows = [];
  state.selectCalls = 0;
});

describe("the stablecoin per-transaction ceiling", () => {
  // Pinned so widening the policy is a deliberate test edit. Every other case
  // here derives its expectations from the getter.
  it("is 200 USD, expressed in micro-USD", () => {
    expect(getDefaultStablecoinTransferCapMicroUsd()).toBe("200000000");
  });
});

describe("checkStablecoinTransferAmount", () => {
  it("allows a stablecoin transfer exactly at the cap", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: CAP_USD.toString(),
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("allows a routine stablecoin transfer well under the cap", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "25.5",
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("denies a stablecoin transfer one micro-USD over the cap", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: `${CAP_USD}.000001`,
    });

    expect(result.kind).toBe("over_cap");
  });

  it("denies the drain the native cap could never see", async () => {
    // An ERC-20 call carries a native value of 0, so the daily value cap
    // reserves 0 for it. This is the only thing bounding the transfer.
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "250000",
    });

    expect(result.kind).toBe("over_cap");
  });

  it("rescales an 18-decimal stablecoin to micro-USD before comparing", async () => {
    state.tokenRows = [DAI];

    const under = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: (CAP_USD - BigInt(1)).toString(),
    });
    expect(under).toEqual({ kind: "allowed" });

    const over = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: (CAP_USD + BigInt(1)).toString(),
    });
    expect(over.kind).toBe("over_cap");
  });

  it("passes through a registered token that is not a stablecoin", async () => {
    // Pricing an arbitrary ERC-20 needs an oracle in the pre-broadcast path.
    state.tokenRows = [
      {
        tokenAddress: USDC_ADDRESS.toLowerCase(),
        decimals: 18,
        symbol: "WETH",
        isStablecoin: false,
      },
    ];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "1000",
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("passes through a token the registry does not know", async () => {
    state.tokenRows = [];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "1000000",
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("does not query the registry for a malformed token address", async () => {
    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      tokenAddress: "not-an-address",
      amount: "1000000",
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });

  it("reports an unparseable amount as invalid, not as over cap", async () => {
    // The two must stay distinguishable: one is a 400, the other a policy
    // denial, and collapsing them would make a typo read as "cap exceeded".
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      amount: "1.0000001",
    });

    expect(result.kind).toBe("invalid");
  });

  it("matches a checksummed address against the lowercase registry row", async () => {
    // An exact-casing comparison would find nothing here, and finding nothing
    // means failing open.
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      tokenAddress: USDC_ADDRESS,
      amount: (CAP_USD + BigInt(1)).toString(),
    });

    expect(result.kind).toBe("over_cap");
  });

  it("ignores a different token on the same chain", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinTransferAmount({
      ...transferParams,
      tokenAddress: RECIPIENT,
      amount: "1000000",
    });

    expect(result).toEqual({ kind: "allowed" });
  });
});

describe("checkStablecoinContractCall", () => {
  const callParams = {
    organizationId: "org_1",
    chainId: 1,
    contractAddress: USDC_ADDRESS,
    context: "test",
  };

  it("denies a USDC transfer smuggled through the contract-call path", async () => {
    // The bypass the route-level check missed: execute_contract_call takes a
    // caller-supplied address, ABI and args, and reserves 0 native value.
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("over_cap");
  });

  it("allows a contract-call transfer under the cap", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, units(BigInt(10), 6)],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("reads the amount from the third argument of transferFrom", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transferFrom",
      inputTypes: ["address", "address", "uint256"],
      args: [RECIPIENT, RECIPIENT, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("over_cap");
  });

  it("accepts a bigint argument as well as a decimal string", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, BigInt(units(CAP_USD + BigInt(1), 6))],
    });

    expect(result.kind).toBe("over_cap");
  });

  it("allows a large approval but does not treat it as capped", async () => {
    // Refusing approvals would break every protocol integration that approves
    // max uint before a swap, so this is reported rather than blocked.
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "approve",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, ethers.MaxUint256.toString()],
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("refuses a stablecoin transfer whose amount cannot be read", async () => {
    // Failing open here would hand back the unbounded move the cap exists to
    // stop.
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, { toString: () => "1" }],
    });

    expect(result.kind).toBe("invalid");
  });

  it("ignores a function that is not an ERC-20 outflow", async () => {
    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "deposit",
      inputTypes: ["uint256"],
      args: [units(CAP_USD + BigInt(1), 6)],
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });

  it("ignores a same-named function with a different signature", async () => {
    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer",
      inputTypes: ["address", "uint256", "bytes"],
      args: [RECIPIENT, units(CAP_USD + BigInt(1), 6), "0x"],
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });

  it("accepts a fully qualified overload key", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinContractCall({
      ...callParams,
      functionName: "transfer(address,uint256)",
      inputTypes: ["address", "uint256"],
      args: [RECIPIENT, units(CAP_USD + BigInt(1), 6)],
    });

    expect(result.kind).toBe("over_cap");
  });
});

describe("checkStablecoinCalldata", () => {
  const calldataParams = {
    organizationId: "org_1",
    chainId: 1,
    to: USDC_ADDRESS,
    context: "test",
  };

  it("decodes and denies an over-cap transfer from raw calldata", async () => {
    // Tempo carries {to, data} with no ABI alongside, and moves TIP-20
    // stablecoins as its primary asset.
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("transfer", [
        RECIPIENT,
        units(CAP_USD + BigInt(1), 6),
      ]),
    });

    expect(result.kind).toBe("over_cap");
  });

  it("allows an under-cap transfer from raw calldata", async () => {
    state.tokenRows = [USDC];

    const result = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("transfer", [
        RECIPIENT,
        units(BigInt(5), 6),
      ]),
    });

    expect(result).toEqual({ kind: "allowed" });
  });

  it("reads the amount from TIP-20 transferWithMemo, not from the memo", async () => {
    // Tempo's ordinary send is transferWithMemo(to, amount, memo): the amount
    // is the second argument, so a last-argument decode would read the memo and
    // wave the transfer through.
    state.tokenRows = [USDC];

    const over = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("transferWithMemo", [
        RECIPIENT,
        units(CAP_USD + BigInt(1), 6),
        MEMO,
      ]),
    });
    expect(over.kind).toBe("over_cap");

    const under = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("transferWithMemo", [
        RECIPIENT,
        units(BigInt(5), 6),
        MEMO,
      ]),
    });
    expect(under).toEqual({ kind: "allowed" });
  });

  it("ignores calldata for a function that is not an ERC-20 outflow", async () => {
    const result = await checkStablecoinCalldata({
      ...calldataParams,
      data: erc20.encodeFunctionData("deposit", [units(CAP_USD, 6)]),
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });

  it("ignores calldata it cannot decode", async () => {
    const result = await checkStablecoinCalldata({
      ...calldataParams,
      data: "0xdeadbeef",
    });

    expect(result).toEqual({ kind: "allowed" });
    expect(state.selectCalls).toBe(0);
  });
});
