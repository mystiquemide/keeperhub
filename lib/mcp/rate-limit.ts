// Rate limits for the MCP surface.
//
// The per-organization limiter is Redis-backed so the ceiling is fleet-wide.
// It previously lived in a module-level Map, which made the real ceiling
// LIMIT * num_replicas: an agent spraying requests across pods got a multiple
// of the intended budget.
//
// The per-IP limiter below is still in-memory per pod.

import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import { getRedis } from "@/lib/redis";
import { mcpRateLimitKey } from "@/lib/redis-keys";

export const WINDOW_MS = 60_000; // 1 minute
export const LIMIT = 120; // requests per window (higher than execute endpoint; MCP sessions are chatty)

// Stale-entry sweep: anything whose newest timestamp is older than
// (STALE_THRESHOLD_MULTIPLIER * maxWindowMs) can never affect a rate-limit
// decision and exists only as map-key overhead. The largest window is
// tracked dynamically so future callers with longer windows are safe by
// construction -- no caller can introduce a window that races the sweep.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MULTIPLIER = 5;

// Hard cap on organizations tracked by the in-memory fallback. The fallback
// only fills while Redis is down, and an outage must not let a flood of
// distinct organization ids grow the map without bound.
const MAX_FALLBACK_ORGANIZATIONS = 10_000;

const DEGRADED_LOG_INTERVAL_MS = 60_000;

const requestLog = new Map<string, number[]>();
const ipRequestLog = new Map<string, number[]>();

let maxWindowMs = WINDOW_MS;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastDegradedLogAt = 0;
let memberSequence = 0;

// Unique per process so two pods adding a member in the same millisecond
// cannot collide on the same sorted-set entry and silently merge two
// requests into one.
const PROCESS_TOKEN = globalThis.crypto.randomUUID();

export type RateLimitResult =
  | { allowed: true; limit: number; remaining: number; reset: number }
  | {
      allowed: false;
      retryAfter: number;
      limit: number;
      remaining: number;
      reset: number;
    };

// Sliding window over a sorted set, scored by request timestamp. Trim, count
// and add have to happen in one server-side step: split across round trips,
// two concurrent requests both read a count below the limit and both get
// admitted, which is a bypass of exactly the size of the concurrency.
//
// Sliding rather than fixed window because a fixed window admits 2 * LIMIT
// across a boundary, and because it preserves the reset/retryAfter semantics
// the existing callers and headers already expose.
//
// Returns { allowed, count-in-window, oldest-score-ms }.
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)

if count >= limit then
  local head = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest = now
  if head[2] then oldest = tonumber(head[2]) end
  return {0, count, oldest}
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, windowMs)

local head = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldest = now
if head[2] then oldest = tonumber(head[2]) end
return {1, count + 1, oldest}
`;

function nextMember(now: number): string {
  memberSequence += 1;
  return `${now}-${PROCESS_TOKEN}-${memberSequence}`;
}

function buildResult(input: {
  allowed: boolean;
  count: number;
  oldestMs: number;
  now: number;
  limit: number;
  windowMs: number;
}): RateLimitResult {
  const { allowed, count, oldestMs, now, limit, windowMs } = input;
  // The oldest request in the window is what frees the next slot.
  const resetMs = oldestMs + windowMs;
  const reset = Math.ceil(resetMs / 1000);

  if (allowed) {
    return {
      allowed: true,
      limit,
      remaining: Math.max(limit - count, 0),
      reset,
    };
  }

  return {
    allowed: false,
    retryAfter: Math.max(Math.ceil((resetMs - now) / 1000), 1),
    limit,
    remaining: 0,
    reset,
  };
}

function parseWindowReply(
  reply: unknown
): { allowed: boolean; count: number; oldestMs: number } | null {
  if (!Array.isArray(reply) || reply.length < 3) {
    return null;
  }
  const [allowed, count, oldestMs] = reply.map(Number);
  if (
    !(
      Number.isFinite(allowed) &&
      Number.isFinite(count) &&
      Number.isFinite(oldestMs)
    )
  ) {
    return null;
  }
  return { allowed: allowed === 1, count, oldestMs };
}

// Losing Redis means losing the shared counter, not the limit. The fallback
// below keeps enforcing LIMIT per replica, so an outage degrades the ceiling
// to what it was before this module was Redis-backed rather than removing it:
// failing open would hand an attacker an unmetered MCP endpoint at precisely
// the moment the platform is least healthy. Throttled because this sits on
// the request hot path and logSystemWarn reaches Sentry.
function warnDegraded(reason: string, error: unknown): void {
  const now = Date.now();
  if (now - lastDegradedLogAt < DEGRADED_LOG_INTERVAL_MS) {
    return;
  }
  lastDegradedLogAt = now;
  logSystemWarn(
    ErrorCategory.INFRASTRUCTURE,
    `[MCP Rate Limit] Redis unavailable (${reason}), falling back to per-pod limiting`,
    error,
    { operation: "mcp_rate_limit" }
  );
}

// Called only when the fallback is at its cap and needs room for a new
// organization. Sweeping stale entries usually frees space; if every tracked
// organization is still active, drop the least recently active one so memory
// stays bounded.
function evictForNewFallbackEntry(): void {
  cleanupExpiredRateLimitEntries();
  if (requestLog.size < MAX_FALLBACK_ORGANIZATIONS) {
    return;
  }

  let stalestKey: string | null = null;
  let stalestSeen = Number.POSITIVE_INFINITY;
  for (const [key, timestamps] of requestLog) {
    const newest = timestamps.at(-1) ?? 0;
    if (newest < stalestSeen) {
      stalestSeen = newest;
      stalestKey = key;
    }
  }
  if (stalestKey !== null) {
    requestLog.delete(stalestKey);
  }
}

function checkInMemoryWindow(
  log: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): RateLimitResult {
  const windowStart = now - windowMs;
  const timestamps = log.get(key);
  const recent = timestamps ? timestamps.filter((t) => t > windowStart) : [];

  if (recent.length >= limit) {
    return buildResult({
      allowed: false,
      count: recent.length,
      oldestMs: recent[0],
      now,
      limit,
      windowMs,
    });
  }

  recent.push(now);
  log.set(key, recent);

  return buildResult({
    allowed: true,
    count: recent.length,
    oldestMs: recent[0],
    now,
    limit,
    windowMs,
  });
}

export async function checkMcpRateLimit(
  organizationId: string
): Promise<RateLimitResult> {
  const now = Date.now();
  const redis = getRedis();

  if (redis) {
    try {
      const reply = await redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        mcpRateLimitKey(organizationId),
        now,
        WINDOW_MS,
        LIMIT,
        nextMember(now)
      );
      const parsed = parseWindowReply(reply);
      if (parsed) {
        return buildResult({
          ...parsed,
          now,
          limit: LIMIT,
          windowMs: WINDOW_MS,
        });
      }
      warnDegraded("unexpected reply", undefined);
    } catch (error) {
      warnDegraded("command failed", error);
    }
  }

  if (
    !requestLog.has(organizationId) &&
    requestLog.size >= MAX_FALLBACK_ORGANIZATIONS
  ) {
    evictForNewFallbackEntry();
  }
  return checkInMemoryWindow(requestLog, organizationId, LIMIT, WINDOW_MS, now);
}

export function checkIpRateLimit(
  ip: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  if (windowMs > maxWindowMs) {
    maxWindowMs = windowMs;
  }
  return checkInMemoryWindow(ipRequestLog, ip, limit, windowMs, Date.now());
}

export function getClientIp(request: Request): string {
  // Prefer `cf-connecting-ip`: Cloudflare sets it to the real client IP at the
  // edge and overwrites any client-supplied value, so it cannot be spoofed to
  // defeat per-IP rate limits. `x-forwarded-for`/`x-real-ip` are attacker-
  // controllable and only used as a fallback for non-CF/local environments.
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) {
    return cfIp;
  }
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

// Walk both maps and drop entries whose newest timestamp is older than the
// stale threshold. Inline cleanup on the request path can't fix this leak
// because it only fires when the same key comes back; entries leak when an
// org/IP makes requests once and never returns.
export function cleanupExpiredRateLimitEntries(): void {
  const cutoff = Date.now() - maxWindowMs * STALE_THRESHOLD_MULTIPLIER;
  for (const map of [requestLog, ipRequestLog]) {
    for (const [key, timestamps] of map) {
      const newest = timestamps.at(-1);
      if (newest === undefined || newest <= cutoff) {
        map.delete(key);
      }
    }
  }
}

export function startRateLimitCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
  }
  // Run a sweep immediately so a re-init (HMR, error-recovery path, etc.)
  // doesn't have to wait CLEANUP_INTERVAL_MS to clean entries left over
  // from before the restart. At server boot the maps are empty so this is
  // a cheap no-op.
  cleanupExpiredRateLimitEntries();
  cleanupTimer = setInterval(
    cleanupExpiredRateLimitEntries,
    CLEANUP_INTERVAL_MS
  );
  if (
    cleanupTimer !== null &&
    typeof cleanupTimer === "object" &&
    "unref" in cleanupTimer
  ) {
    cleanupTimer.unref();
  }
}

export function stopRateLimitCleanupInterval(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// Tracked-entry counts. Useful for /healthz or memory observability. The
// organization count only moves while the Redis-backed limiter is degraded.
export function getRateLimitStats(): {
  organizationCount: number;
  ipCount: number;
} {
  return {
    organizationCount: requestLog.size,
    ipCount: ipRequestLog.size,
  };
}

// Test-only: clears all in-process state (maps + tracked window). Tests need
// this because `maxWindowMs` is module-scoped and can otherwise leak between
// cases that exercise different window sizes.
export function resetRateLimitState(): void {
  requestLog.clear();
  ipRequestLog.clear();
  maxWindowMs = WINDOW_MS;
  lastDegradedLogAt = 0;
}
