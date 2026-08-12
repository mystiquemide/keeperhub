import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogSecurityEvent } = vi.hoisted(() => ({
  mockLogSecurityEvent: vi.fn(),
}));

vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return { ...actual, logSecurityEvent: mockLogSecurityEvent };
});

const { requireScope } = await import("@/lib/middleware/require-scope");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireScope (A-03)", () => {
  it("returns null for an undefined scope (unscoped caller, full access)", () => {
    // Cookie sessions, internal service callers, and API keys whose `scope`
    // column is NULL all arrive here as undefined and must keep full access.
    expect(requireScope(undefined, "mcp:read")).toBeNull();
    expect(requireScope(undefined, "mcp:write")).toBeNull();
    expect(requireScope(undefined, "mcp:admin")).toBeNull();
  });

  it("returns null when the granted scope satisfies the requirement", () => {
    expect(requireScope("mcp:write", "mcp:write")).toBeNull();
    expect(requireScope("mcp:admin", "mcp:write")).toBeNull();
    expect(requireScope("mcp:read", "mcp:read")).toBeNull();
  });

  it("returns a 403 insufficient_scope envelope when under-scoped", async () => {
    const response = requireScope("mcp:read", "mcp:write");

    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);

    const body = await response?.json();
    expect(body).toMatchObject({
      error: "insufficient_scope",
      required_scope: "mcp:write",
      granted_scope: "mcp:read",
    });
  });

  it("reports an empty granted scope as the empty string in the envelope", async () => {
    const response = requireScope("", "mcp:write");

    expect(response?.status).toBe(403);
    const body = await response?.json();
    expect(body.granted_scope).toBe("");
  });

  it("gates a scoped API key on the same string an OAuth token would carry", async () => {
    // The scope reaching this guard is now the API key's `scope` column as
    // well as the OAuth `scope` claim; neither gets a bypass.
    expect(requireScope("mcp:read", "mcp:read")).toBeNull();
    expect(requireScope("mcp:write", "mcp:write")).toBeNull();

    const response = requireScope("mcp:read", "mcp:admin");

    expect(response?.status).toBe(403);
    const body = await response?.json();
    expect(body).toMatchObject({
      error: "insufficient_scope",
      required_scope: "mcp:admin",
      granted_scope: "mcp:read",
    });
  });

  describe("denial telemetry", () => {
    it("emits a security event carrying the caller context", () => {
      requireScope("mcp:read", "mcp:write", {
        organizationId: "org-1",
        credentialId: "key-1",
        endpoint: "/api/execute/transfer",
      });

      expect(mockLogSecurityEvent).toHaveBeenCalledTimes(1);
      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        "insufficient_scope_denied",
        {
          required_scope: "mcp:write",
          granted_scope: "mcp:read",
          organizationId: "org-1",
          credentialId: "key-1",
          endpoint: "/api/execute/transfer",
        },
        expect.objectContaining({
          fingerprint: ["security", "insufficient_scope_denied", "mcp:write"],
        })
      );
    });

    it("records an empty grant string verbatim rather than dropping the field", () => {
      requireScope("", "mcp:write");

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        "insufficient_scope_denied",
        expect.objectContaining({ granted_scope: "" }),
        expect.anything()
      );
    });

    it("stays silent when the scope is satisfied", () => {
      requireScope("mcp:admin", "mcp:write");
      requireScope(undefined, "mcp:write");

      expect(mockLogSecurityEvent).not.toHaveBeenCalled();
    });
  });
});
