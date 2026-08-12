import { NextResponse } from "next/server";
import { logSecurityEvent } from "@/lib/logging";
import { type OAuthScope, scopeSatisfies } from "@/lib/mcp/oauth-scopes";

/**
 * Identifies the denied caller in the security signal. Never carries the
 * credential itself -- `credentialId` is the API key row id or the
 * `oauth:<userId>` pseudo-id the execute auth helper builds.
 */
export type ScopeDenialContext = {
  organizationId?: string;
  credentialId?: string;
  endpoint?: string;
};

/**
 * A-03: enforce credential scope at the REST sinks that MCP tools forward to.
 * OAuth tokens and kh_ API keys both carry a scope (mcp:read|write|admin) the
 * MCP tool wrapper checks, but the REST routes those tools call dropped it and
 * ran any authenticated caller. `grantedScope === undefined` means the caller
 * carries no scope at all -- a cookie session, an internal service, or an API
 * key whose `scope` column is NULL -- and is intentionally full-access.
 * Returns a 403 envelope (RFC 6750 3.1) when denied, null when allowed.
 *
 * A denial is a security detection signal, not just a client error: it is a
 * credential being used outside its grant, at endpoints that move funds. Emit
 * it so the 403 rate is countable and attributable rather than silent.
 */
export function requireScope(
  grantedScope: string | undefined,
  required: OAuthScope,
  context?: ScopeDenialContext
): NextResponse | null {
  if (scopeSatisfies(grantedScope, required)) {
    return null;
  }

  logSecurityEvent(
    "insufficient_scope_denied",
    {
      required_scope: required,
      granted_scope: grantedScope ?? null,
      organizationId: context?.organizationId,
      credentialId: context?.credentialId,
      endpoint: context?.endpoint,
    },
    {
      tags: {
        security: "insufficient_scope_denied",
        required_scope: required,
      },
      extra: {
        granted_scope: grantedScope ?? null,
        organizationId: context?.organizationId,
        credentialId: context?.credentialId,
        endpoint: context?.endpoint,
      },
      // One Sentry issue per required scope rather than one per caller, so a
      // misconfigured integrator retrying cannot bury the rest of the signal.
      fingerprint: ["security", "insufficient_scope_denied", required],
    }
  );

  return NextResponse.json(
    {
      error: "insufficient_scope",
      message: `This endpoint requires the \`${required}\` OAuth scope. The current token has \`${grantedScope || "(none)"}\`.`,
      required_scope: required,
      granted_scope: grantedScope ?? "",
    },
    { status: 403 }
  );
}
