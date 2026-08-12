import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedis, mockLogSystemWarn } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockLogSystemWarn: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { INFRASTRUCTURE: "infrastructure" },
  logSystemWarn: mockLogSystemWarn,
}));

type RateLimitModule = typeof import("@/lib/mcp/rate-limit");

type SortedSetEntry = { score: number; member: string };

type FakeRedis = {
  eval: (...args: unknown[]) => Promise<unknown>;
  evalCalls: () => number;
};

/**
 * Stands in for one Redis server: a single store every replica talks to, and
 * a script that runs start to finish without interleaving. The awaited
 * dispatch models the network hop, so concurrent callers genuinely overlap
 * around it -- a limiter that split the check and the increment across two
 * round trips would over-admit against this fake.
 */
function createFakeRedis(): FakeRedis {
  const store = new Map<string, SortedSetEntry[]>();
  let calls = 0;

  const evalScript = async (...args: unknown[]): Promise<unknown> => {
    calls += 1;
    const [, , key, now, windowMs, limit, member] = args;
    await Promise.resolve();

    const nowMs = Number(now);
    const kept = (store.get(String(key)) ?? []).filter(
      (entry) => entry.score > nowMs - Number(windowMs)
    );
    store.set(String(key), kept);

    if (kept.length >= Number(limit)) {
      return [0, kept.length, kept[0].score];
    }

    kept.push({ score: nowMs, member: String(member) });
    kept.sort((a, b) => a.score - b.score);
    return [1, kept.length, kept[0].score];
  };

  return { eval: evalScript, evalCalls: (): number => calls };
}

// A fresh module instance stands in for another pod: its own in-memory maps,
// the same shared Redis behind them.
async function loadReplica(): Promise<RateLimitModule> {
  vi.resetModules();
  return await import("@/lib/mcp/rate-limit");
}

describe("checkMcpRateLimit (Redis-backed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enforces one fleet-wide ceiling across replicas sharing a store", async () => {
    mockGetRedis.mockReturnValue(createFakeRedis());

    const podA = await loadReplica();
    const podB = await loadReplica();

    const spread = Array.from({ length: podA.LIMIT }, (_, index) =>
      index % 2 === 0 ? podA : podB
    );
    let allowed = 0;
    for (const pod of spread) {
      const result = await pod.checkMcpRateLimit("org-shared");
      if (result.allowed) {
        allowed += 1;
      }
    }
    expect(allowed).toBe(podA.LIMIT);

    // Each pod served only half the budget; both must still deny, which is
    // the whole point -- per-pod maps gave every replica its own LIMIT.
    const deniedOnB = await podB.checkMcpRateLimit("org-shared");
    const deniedOnA = await podA.checkMcpRateLimit("org-shared");
    expect(deniedOnB.allowed).toBe(false);
    expect(deniedOnA.allowed).toBe(false);

    // Nothing was tracked locally: the decisions came from the shared store.
    expect(podA.getRateLimitStats().organizationCount).toBe(0);
    expect(podB.getRateLimitStats().organizationCount).toBe(0);
  });

  it("admits at most the limit when requests arrive concurrently", async () => {
    const redis = createFakeRedis();
    mockGetRedis.mockReturnValue(redis);

    const pod = await loadReplica();
    const overshoot = 25;
    const attempts = pod.LIMIT + overshoot;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        pod.checkMcpRateLimit("org-concurrent")
      )
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(pod.LIMIT);
    expect(results.filter((r) => !r.allowed)).toHaveLength(overshoot);
    // One round trip per decision: there is no window between the count and
    // the increment for a concurrent request to slip through.
    expect(redis.evalCalls()).toBe(attempts);
  });

  it("reports the standard metadata on both allowed and denied decisions", async () => {
    mockGetRedis.mockReturnValue(createFakeRedis());
    const pod = await loadReplica();

    const first = await pod.checkMcpRateLimit("org-metadata");
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(pod.LIMIT);
    expect(first.remaining).toBe(pod.LIMIT - 1);
    expect(first.reset).toBeGreaterThan(0);

    for (let i = 1; i < pod.LIMIT; i++) {
      await pod.checkMcpRateLimit("org-metadata");
    }

    const denied = await pod.checkMcpRateLimit("org-metadata");
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.limit).toBe(pod.LIMIT);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
      expect(denied.reset).toBeGreaterThan(0);
    }
  });

  it("falls back to per-pod limiting rather than open when Redis is unreachable", async () => {
    mockGetRedis.mockReturnValue({
      eval: (): Promise<unknown> => Promise.reject(new Error("ECONNREFUSED")),
    });

    const pod = await loadReplica();
    const results: Awaited<ReturnType<RateLimitModule["checkMcpRateLimit"]>>[] =
      [];
    for (let i = 0; i < pod.LIMIT + 5; i++) {
      results.push(await pod.checkMcpRateLimit("org-outage"));
    }

    // Degraded, not disabled: the pod-local window still caps the org.
    expect(results.filter((r) => r.allowed)).toHaveLength(pod.LIMIT);
    expect(results.at(-1)?.allowed).toBe(false);
    expect(pod.getRateLimitStats().organizationCount).toBe(1);
    expect(mockLogSystemWarn).toHaveBeenCalled();
  });

  it("logs the degradation once per interval instead of per request", async () => {
    mockGetRedis.mockReturnValue({
      eval: (): Promise<unknown> => Promise.reject(new Error("ECONNREFUSED")),
    });

    const pod = await loadReplica();
    await pod.checkMcpRateLimit("org-noisy");
    await pod.checkMcpRateLimit("org-noisy");
    await pod.checkMcpRateLimit("org-noisy");

    expect(mockLogSystemWarn).toHaveBeenCalledTimes(1);
  });

  it("bounds the fallback map so an outage is not a memory-growth vector", async () => {
    mockGetRedis.mockReturnValue(null);
    const pod = await loadReplica();

    // MAX_FALLBACK_ORGANIZATIONS is 10_000; push past it with distinct ids.
    const flood = 10_050;
    for (let i = 0; i < flood; i++) {
      await pod.checkMcpRateLimit(`org-flood-${i}`);
    }

    expect(pod.getRateLimitStats().organizationCount).toBeLessThanOrEqual(
      10_000
    );
  });

  it("treats an unrecognised reply as a failure and falls back", async () => {
    mockGetRedis.mockReturnValue({
      eval: (): Promise<unknown> => Promise.resolve("MOVED 1234"),
    });

    const pod = await loadReplica();
    const result = await pod.checkMcpRateLimit("org-garbled");

    expect(result.allowed).toBe(true);
    expect(pod.getRateLimitStats().organizationCount).toBe(1);
    expect(mockLogSystemWarn).toHaveBeenCalled();
  });

  it("uses the in-memory window silently when no Redis is configured", async () => {
    mockGetRedis.mockReturnValue(null);

    const pod = await loadReplica();
    const result = await pod.checkMcpRateLimit("org-unconfigured");

    expect(result.allowed).toBe(true);
    expect(pod.getRateLimitStats().organizationCount).toBe(1);
    // Self-hosted and local runs have no Redis by design; that is not a
    // degradation worth paging on.
    expect(mockLogSystemWarn).not.toHaveBeenCalled();
  });

  it("namespaces the counter key per deployment and organization", async () => {
    const redis = createFakeRedis();
    const evalSpy = vi.fn(redis.eval);
    mockGetRedis.mockReturnValue({ eval: evalSpy });

    const pod = await loadReplica();
    await pod.checkMcpRateLimit("org-keyed");

    expect(evalSpy.mock.calls[0][2]).toBe("local:ratelimit:mcp:org-keyed");
  });
});
