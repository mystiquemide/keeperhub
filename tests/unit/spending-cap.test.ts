import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/utils/id", () => ({ generateId: () => "exec_test" }));

// Hoisted state the fake tx reads from / writes to, set per test.
const state = vi.hoisted(() => ({
  caps: [] as Array<{
    dailyValueCapWei: string | null;
    dailySolanaValueCapLamports?: string | null;
  }>,
  sumRows: [] as Array<{ totalWei?: string; totalLamports?: string }>,
  ledgerRows: [] as Array<{ totalWei?: string; totalLamports?: string }>,
  inserted: [] as Record<string, unknown>[],
  capAnchors: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
  paygCharge: { applicable: false } as
    | { applicable: false }
    | { applicable: true; ok: true; txHash: string }
    | { applicable: true; ok: false; reason: string; message: string },
}));

// A cap-row insert carries nothing but the org id: lockOrgSpendCapRow creates
// the row purely as a lock anchor, with both cap columns left NULL.
function isCapAnchorInsert(values: Record<string, unknown>): boolean {
  return Object.keys(values).length === 1 && "organizationId" in values;
}

// Fake db.transaction whose tx supports what the reservation uses: the cap
// FOR UPDATE lookup (.for().limit()), recognised by the columns it selects
// because lockOrgSpendCapRow may run it twice; the anchor insert when the org
// has no row; the value SUM -- two thenable .where() selects (direct
// executions, then the value ledger) via sumOrgValueTodayWei -- and the
// reservation insert.
vi.mock("@/lib/db", () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => {
      let sumCall = 0;
      const tx = {
        select: (fields: Record<string, unknown>) => {
          const columns = Object.keys(fields ?? {});
          if (
            columns.includes("dailyValueCapWei") ||
            columns.includes("dailySolanaValueCapLamports")
          ) {
            return {
              from: () => ({
                where: () => ({
                  for: () => ({
                    limit: () => Promise.resolve(state.caps),
                  }),
                }),
              }),
            };
          }
          sumCall += 1;
          const rows = sumCall === 1 ? state.sumRows : state.ledgerRows;
          return {
            from: () => ({
              where: () => Promise.resolve(rows),
            }),
          };
        },
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            if (isCapAnchorInsert(v)) {
              state.capAnchors.push(v);
              return {
                onConflictDoNothing: () => {
                  state.caps = [
                    {
                      dailyValueCapWei: null,
                      dailySolanaValueCapLamports: null,
                    },
                  ];
                  return Promise.resolve(undefined);
                },
              };
            }
            state.inserted.push(v);
            return Promise.resolve(undefined);
          },
        }),
      };
      return cb(tx);
    },
    // The reserved row is marked failed here when a PAYG charge is blocked.
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          state.updated.push(v);
          return Promise.resolve(undefined);
        },
      }),
    }),
  },
}));

// PAYG charge runs after a successful reservation. Value-cap tests keep it a
// no-op (applicable: false); the PAYG-charge tests drive it via state.paygCharge.
vi.mock("@/lib/billing/payg/charge", () => ({
  chargePaygIfBillable: () => Promise.resolve(state.paygCharge),
}));

import { checkAndReserveExecution } from "@/app/api/execute/_lib/spending-cap";
import {
  getDefaultDailySolanaValueCapLamports,
  getDefaultDailyValueCapWei,
} from "@/lib/execute/spend-cap-defaults";

const DEFAULT_WEI = BigInt(getDefaultDailyValueCapWei());
const DEFAULT_LAMPORTS = BigInt(getDefaultDailySolanaValueCapLamports());

const baseParams = {
  organizationId: "org_1",
  apiKeyId: "key_1",
  type: "transfer",
  network: "1",
  input: { foo: "bar" },
};

beforeEach(() => {
  state.caps = [];
  state.sumRows = [{ totalWei: "0" }];
  state.ledgerRows = [{ totalWei: "0" }];
  state.inserted = [];
  state.capAnchors = [];
  state.updated = [];
  state.paygCharge = { applicable: false };
});

describe("platform default cap figures", () => {
  // Pinned so a change to the policy is a deliberate test edit rather than a
  // silent widening. Every other test derives its expectations from these
  // getters, so without this nothing would catch an added zero.
  it("is 0.05 ETH per day for EVM chains", () => {
    expect(getDefaultDailyValueCapWei()).toBe("50000000000000000");
  });

  it("is 1 SOL per day for Solana", () => {
    expect(getDefaultDailySolanaValueCapLamports()).toBe("1000000000");
  });
});

describe("checkAndReserveExecution value cap", () => {
  it("allows a value under the platform default when no cap row exists", async () => {
    state.caps = [];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "5" },
    });

    expect(result).toEqual({ allowed: true, executionId: "exec_test" });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      valueWei: "5",
      status: "pending",
    });
  });

  it("denies above the platform default when no cap row exists", async () => {
    // The historical fail-open: every org started without a cap row, so a
    // leaked key was bounded only by the wallet balance.
    state.caps = [];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: (DEFAULT_WEI + BigInt(1)).toString() },
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("creates the cap row so the FOR UPDATE lock has something to hold", async () => {
    state.caps = [];

    await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "5" },
    });

    expect(state.capAnchors).toEqual([{ organizationId: "org_1" }]);
    // The anchor carries no cap figures, so the org keeps tracking the platform
    // default rather than freezing today's value into its row.
    expect(state.caps).toEqual([
      { dailyValueCapWei: null, dailySolanaValueCapLamports: null },
    ]);
  });

  it("applies the platform default when dailyValueCapWei is null", async () => {
    state.caps = [{ dailyValueCapWei: null }];

    const under = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "999" },
    });
    expect(under.allowed).toBe(true);
    expect(state.inserted).toHaveLength(1);

    const over = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: (DEFAULT_WEI + BigInt(1)).toString() },
    });
    expect(over.allowed).toBe(false);
    expect(state.inserted).toHaveLength(1);
  });

  it("lets an explicit cap raise the ceiling above the platform default", async () => {
    const raised = (DEFAULT_WEI * BigInt(100)).toString();
    state.caps = [{ dailyValueCapWei: raised }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: {
        kind: "evm",
        valueWei: (DEFAULT_WEI * BigInt(10)).toString(),
      },
    });

    expect(result.allowed).toBe(true);
    expect(state.inserted).toHaveLength(1);
  });

  it("allows when the day's total plus this reservation stays within the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.sumRows = [{ totalWei: "600" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "400" },
    });

    expect(result.allowed).toBe(true);
    expect(state.inserted[0]).toMatchObject({ valueWei: "400" });
  });

  it("denies when the reservation would push the day's total over the cap", async () => {
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.sumRows = [{ totalWei: "600" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "500" },
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("counts workflow/protocol value (the ledger) against a direct reservation", async () => {
    // Direct spend 600 + ledger (workflow) spend 300 = 900; a further 200
    // direct reservation would reach 1100 > 1000 -> denied. Without the ledger
    // in the SUM this would wrongly pass (600 + 200 = 800).
    state.caps = [{ dailyValueCapWei: "1000" }];
    state.sumRows = [{ totalWei: "600" }];
    state.ledgerRows = [{ totalWei: "300" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "200" },
    });

    expect(result.allowed).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });

  it("blocks a single wallet-draining reservation even with a zero recorded total (TOCTOU closed)", async () => {
    // The reservation alone (5 ETH) exceeds a 1 ETH cap although the recorded
    // day total is still 0 -- value is known up front, unlike gas.
    state.caps = [{ dailyValueCapWei: "1000000000000000000" }];
    state.sumRows = [{ totalWei: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "5000000000000000000" },
    });

    expect(result.allowed).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });
});

describe("checkAndReserveExecution Solana cap", () => {
  it("charges the lamports cap and records valueLamports, not valueWei", async () => {
    state.caps = [
      { dailyValueCapWei: "1000", dailySolanaValueCapLamports: "2000000000" },
    ];
    state.sumRows = [{ totalLamports: "500000000" }];
    state.ledgerRows = [{ totalLamports: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "1000000000" },
    });

    expect(result.allowed).toBe(true);
    // The unit columns are mutually exclusive, so each daily SUM stays
    // single-unit.
    expect(state.inserted[0]).toMatchObject({
      valueLamports: "1000000000",
      valueWei: null,
    });
  });

  it("denies with the Solana-specific reason when the lamports cap is exceeded", async () => {
    state.caps = [
      { dailyValueCapWei: null, dailySolanaValueCapLamports: "1000000000" },
    ];
    state.sumRows = [{ totalLamports: "900000000" }];
    state.ledgerRows = [{ totalLamports: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "200000000" },
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Daily Solana spending cap exceeded",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("falls back to the Solana default when unset, never to the wei cap", async () => {
    // A wei cap that would reject either figure outright, to prove the Solana
    // path never consults it: the small reservation is allowed and the large
    // one is denied purely by the Solana default.
    state.caps = [{ dailyValueCapWei: "1", dailySolanaValueCapLamports: null }];
    state.sumRows = [{ totalLamports: "0" }];
    state.ledgerRows = [{ totalLamports: "0" }];

    const under = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "5000" },
    });
    expect(under.allowed).toBe(true);

    const over = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: {
        kind: "solana",
        valueLamports: (DEFAULT_LAMPORTS + BigInt(1)).toString(),
      },
    });
    expect(over).toEqual({
      allowed: false,
      reason: "Daily Solana spending cap exceeded",
    });
  });

  it("does not let an exhausted wei cap block a Solana reservation", async () => {
    state.caps = [
      { dailyValueCapWei: "1000", dailySolanaValueCapLamports: "2000000000" },
    ];
    // Solana totals are read from the lamports columns; the wei day-total is
    // irrelevant to this reservation and must not be consulted.
    state.sumRows = [{ totalWei: "999999", totalLamports: "0" }];
    state.ledgerRows = [{ totalWei: "999999", totalLamports: "0" }];

    const result = await checkAndReserveExecution({
      ...baseParams,
      network: "103",
      reserved: { kind: "solana", valueLamports: "1000000000" },
    });

    expect(result.allowed).toBe(true);
  });
});

describe("checkAndReserveExecution PAYG charge", () => {
  it("keeps the reservation when a billable execution charges successfully", async () => {
    state.paygCharge = { applicable: true, ok: true, txHash: "0xabc" };

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
    });

    expect(result).toEqual({ allowed: true, executionId: "exec_test" });
    expect(state.inserted).toHaveLength(1);
    expect(state.updated).toHaveLength(0);
  });

  it("denies and marks the reserved row failed when the PAYG charge is blocked", async () => {
    const message =
      "Daily pay-as-you-go spend limit reached. Raise your daily limit or wait until tomorrow.";
    state.paygCharge = {
      applicable: true,
      ok: false,
      reason: "daily_cap",
      message,
    };

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
    });

    expect(result).toEqual({ allowed: false, reason: message });
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0]).toMatchObject({
      status: "failed",
      error: message,
    });
  });

  it("passes non-PAYG orgs through without charging or denying", async () => {
    state.paygCharge = { applicable: false };

    const result = await checkAndReserveExecution({
      ...baseParams,
      reserved: { kind: "evm", valueWei: "0" },
    });

    expect(result).toEqual({ allowed: true, executionId: "exec_test" });
    expect(state.updated).toHaveLength(0);
  });
});
