import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockRegisterTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  const MockMcpServer = vi.fn(function (this: {
    registerTool: typeof mockRegisterTool;
  }) {
    this.registerTool = mockRegisterTool;
  });
  return { McpServer: MockMcpServer };
});

import {
  getRequiredScopeForTool,
  SCOPE_MCP_ADMIN,
  SCOPE_MCP_READ,
} from "@/lib/mcp/oauth-scopes";
import { registerMetaTools, registerTools } from "@/lib/mcp/tools";
import {
  createWorkflowMcpServer,
  type WorkflowListing,
} from "@/lib/mcp/workflow-server";

type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

/**
 * Every tool registered on the authenticated /mcp surface, keyed by name.
 * Both registrars are invoked because they share the same surface and a
 * caller cannot tell which function declared a given tool.
 */
function collectAnnotations(): Map<string, ToolAnnotations> {
  const collected = new Map<string, ToolAnnotations>();
  const server = {
    tool: (
      toolName: string,
      _description: string,
      _schema: Record<string, unknown>,
      annotations: ToolAnnotations
    ): void => {
      collected.set(toolName, annotations);
    },
  } as unknown as McpServer;

  registerTools(server, "http://internal", "Bearer test", SCOPE_MCP_ADMIN);
  registerMetaTools(server, "http://internal", "Bearer test", SCOPE_MCP_ADMIN);
  return collected;
}

/**
 * Writes whose new record starts inert and which overwrite, delete, publish,
 * broadcast or emit nothing. This is the complete allowlist: any other
 * non-read tool must keep the MCP default of destructiveHint true, so adding
 * a tool with destructiveHint false fails the exhaustiveness assertion below
 * rather than silently reaching clients as auto-approvable.
 */
const ADDITIVE_WRITE_TOOLS = [
  "ai_generate_workflow",
  "create_project",
  "create_tag",
  "deploy_template",
];

/**
 * Tools that move value, broadcast a transaction, or dispatch an execution
 * whose effects cannot be bounded from the arguments. Listed explicitly
 * rather than derived so a future edit flipping one back to non-destructive
 * has to delete a named case.
 */
const VALUE_MOVING_TOOLS = [
  "call_workflow",
  "execute_check_and_execute",
  "execute_contract_call",
  "execute_protocol_action",
  "execute_transfer",
  "execute_workflow",
  "tempo_cancel_hold",
  "tempo_release_hold",
  "tempo_sign_and_hold",
];

describe("MCP tool annotations", () => {
  const annotations = collectAnnotations();

  it("annotates every registered tool", () => {
    expect(annotations.size).toBeGreaterThan(0);
    for (const [name, annotation] of annotations) {
      expect(annotation.readOnlyHint, name).toBeTypeOf("boolean");
    }
  });

  it.each(VALUE_MOVING_TOOLS)("marks %s as destructive", (name) => {
    const annotation = annotations.get(name);
    expect(annotation, name).toBeDefined();
    expect(annotation?.readOnlyHint).toBe(false);
    expect(annotation?.destructiveHint).toBe(true);
  });

  it.each([
    "update_workflow",
    "delete_workflow",
    "list_workflow",
    "unlist_workflow",
    "update_workflow_listing",
  ])("marks %s as destructive because it overwrites state", (name) => {
    expect(annotations.get(name)?.destructiveHint).toBe(true);
  });

  // create_workflow takes `enabled` alongside an unconstrained `nodes` array,
  // so one call can arm a scheduled run of a transfer action. test_notification
  // sends to a caller-named target and cannot recall the message. Neither
  // persists over existing state, so they would read as additive without an
  // explicit case.
  it.each([
    "create_workflow",
    "test_notification",
  ])("marks %s as destructive because it arms or emits an unbounded effect", (name) => {
    const annotation = annotations.get(name);
    expect(annotation, name).toBeDefined();
    expect(annotation?.readOnlyHint).toBe(false);
    expect(annotation?.destructiveHint).toBe(true);
  });

  it("downgrades destructiveHint only for the additive write allowlist", () => {
    const downgraded = [...annotations.entries()]
      .filter(
        ([, annotation]) =>
          annotation.readOnlyHint === false &&
          annotation.destructiveHint === false
      )
      .map(([name]) => name)
      .sort();

    expect(downgraded).toEqual([...ADDITIVE_WRITE_TOOLS].sort());
  });

  it("never claims a write tool is read-only", () => {
    for (const [name, annotation] of annotations) {
      if (annotation.readOnlyHint === true) {
        expect(getRequiredScopeForTool(name), name).toBe(SCOPE_MCP_READ);
      }
    }
  });
});

const baseListing: WorkflowListing = {
  id: "wf-001",
  name: "Aave Position Monitor",
  description: "Monitors Aave positions.",
  listedSlug: "aave-position-monitor",
  inputSchema: null,
  outputMapping: null,
  priceUsdcPerCall: null,
  workflowType: "read",
  listingVersion: 1,
  nodes: [],
};

/** Node shape per lib/mcp/calldata.ts findFirstWriteActionNode. */
function actionNode(id: string, actionType: string): unknown {
  return {
    id,
    type: "action",
    data: { type: "action", config: { actionType } },
  };
}

function listingAnnotations(
  overrides: Partial<WorkflowListing>
): ToolAnnotations {
  createWorkflowMcpServer({
    slug: "aave-position-monitor",
    listing: { ...baseListing, ...overrides },
    internalApiBaseUrl: "http://localhost:3000",
    authHeader: "Bearer kh_test",
  });
  const config = mockRegisterTool.mock.calls[0][1] as {
    annotations: ToolAnnotations;
  };
  return config.annotations;
}

describe("per-listing workflow MCP server annotations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The call route sends workflowType "read" to handleReadWorkflow, which runs
  // the whole body server-side on the owner's wallet, while "write" only
  // returns unsigned calldata. deriveWorkflowType additionally types a
  // transfer-only workflow as "read". Neither value may relax the hints.
  it.each([
    {
      label: "a read listing whose nodes transfer funds",
      overrides: {
        workflowType: "read" as const,
        nodes: [actionNode("n1", "web3/transfer-funds")],
      },
    },
    {
      label: "a read listing whose nodes only read",
      overrides: {
        workflowType: "read" as const,
        nodes: [actionNode("n1", "web3/read-contract")],
      },
    },
    {
      label: "a write listing",
      overrides: { workflowType: "write" as const, nodes: [] },
    },
    {
      label: "a listing with no nodes at all",
      overrides: { workflowType: "read" as const, nodes: [] },
    },
  ])("never advertises $label as read-only", ({ overrides }) => {
    const annotation = listingAnnotations(overrides);
    expect(annotation.readOnlyHint).toBe(false);
    expect(annotation.destructiveHint).toBe(true);
  });
});
