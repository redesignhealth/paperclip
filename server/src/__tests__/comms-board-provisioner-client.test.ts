import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  COMMS_BOARD_REQUEST_TIMEOUT_MS,
  composeCommsBoardIdentity,
  registerCommsBoardAgent,
  type CommsBoardProvisionerConfig,
} from "../services/comms-board-provisioner-client.js";
import { startStatefulMcpBoard, type StatefulBoardServer } from "./helpers/stateful-mcp-board.js";

describe("comms-board-provisioner-client stateful Streamable HTTP contract", () => {
  let board: StatefulBoardServer;
  const adminToken = "board-admin-secret-token-12345";
  let config: CommsBoardProvisionerConfig;

  afterEach(async () => {
    if (board) {
      await board.close();
    }
  });

  it("happy path: executes initialize -> initialized -> beforeToolCall checkpoint -> tools/call -> DELETE in strict order", async () => {
    board = await startStatefulMcpBoard({ adminToken });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const checkpoints: string[] = [];
    const beforeToolCall = vi.fn(async () => {
      checkpoints.push("checkpoint_written");
    });

    const agentId = randomUUID();
    const identity = composeCommsBoardIdentity(agentId)!;
    expect(identity.agentKey).toBeNull();
    expect(identity.boardSub).toBe(`paperclip-agent-${agentId}`);

    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: identity.boardSub,
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      { beforeToolCall },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.boardSub).toBe(identity.boardSub);
    expect(result.boardAgentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(beforeToolCall).toHaveBeenCalledTimes(1);

    // Verify ordering
    const eventTypes = board.events.map((e) => e.type);
    expect(eventTypes).toEqual(["initialize", "initialized", "tools/call", "delete"]);
    expect(checkpoints).toEqual(["checkpoint_written"]);
  });

  it.each([
    ["already_registered", "already_registered: Agent already exists", "board_conflict"],
    ["identity_fork_detected", "identity_fork_detected: Fork not permitted", "board_conflict"],
    ["display_name_collision", "display_name_collision: Name in use", "board_conflict"],
    ["access_denied", "access_denied: Missing required permission", "board_rejected"],
    ["insufficient_scope", "insufficient_scope: comms:admin required", "board_rejected"],
    ["invalid_request", "invalid_request: Malformed parameters", "board_failed"],
    ["unknown_error", "database_unreachable: Connection error", "board_unknown"],
  ])("maps plain text tool error %s correctly to %s", async (_label, errorText, expectedReason) => {
    board = await startStatefulMcpBoard({
      adminToken,
      toolOutcome: { kind: "tool_error", text: errorText },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const beforeToolCall = vi.fn(async () => {});
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      { beforeToolCall },
    );

    expect(result).toEqual({ ok: false, reason: expectedReason });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(board.events.map((e) => e.type)).toEqual(["initialize", "initialized", "tools/call", "delete"]);
  });

  it("handshake 401 returns terminal board_rejected and NEVER calls beforeToolCall checkpoint", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      handshakeOutcome: { kind: "http_status", status: 401 },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const beforeToolCall = vi.fn(async () => {});
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      { beforeToolCall },
    );

    expect(result).toEqual({ ok: false, reason: "board_rejected" });
    expect(beforeToolCall).not.toHaveBeenCalled();
    expect(board.events.map((e) => e.type)).toEqual(["initialize"]);
  });

  it("handshake 500 returns retryable provisioner_failed and NEVER calls beforeToolCall checkpoint", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      handshakeOutcome: { kind: "http_status", status: 500 },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const beforeToolCall = vi.fn(async () => {});
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      { beforeToolCall },
    );

    expect(result).toEqual({ ok: false, reason: "provisioner_failed", retryable: true });
    expect(beforeToolCall).not.toHaveBeenCalled();
    expect(board.events.map((e) => e.type)).toEqual(["initialize"]);
  });

  it("handshake timeout returns retryable provisioner_failed and NEVER calls beforeToolCall checkpoint", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      handshakeOutcome: { kind: "delay", ms: 200 },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const beforeToolCall = vi.fn(async () => {});
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      50, // 50ms timeout
      { beforeToolCall },
    );

    expect(result).toEqual({ ok: false, reason: "provisioner_failed", retryable: true });
    expect(beforeToolCall).not.toHaveBeenCalled();
  });

  it("lost session on tools/call returns board_failed", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      toolOutcome: { kind: "http_status", status: 400 },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const beforeToolCall = vi.fn(async () => {});
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      { beforeToolCall },
    );

    expect(result).toEqual({ ok: false, reason: "board_failed" });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    expect(board.events.map((e) => e.type)).toEqual(["initialize", "initialized", "tools/call", "delete"]);
  });

  it("call timeout returns board_unknown with exactly one call and clean session termination", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      toolOutcome: { kind: "delay", ms: 200 },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const beforeToolCall = vi.fn(async () => {});
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      50, // 50ms timeout
      { beforeToolCall },
    );

    expect(result).toEqual({ ok: false, reason: "board_unknown" });
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
    // Verified: tools/call was attempted once, and DELETE was sent
    expect(board.events.filter((e) => e.type === "tools/call")).toHaveLength(1);
    expect(board.events.filter((e) => e.type === "delete")).toHaveLength(1);
  });

  it("oversized tool reply (>1MB) returns board_unknown", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      toolOutcome: { kind: "oversized" },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const beforeToolCall = vi.fn(async () => {});
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      { beforeToolCall },
    );

    expect(result).toEqual({ ok: false, reason: "board_unknown" });
  });

  it("beforeToolCall throwing rethrows immediately, performs cleanup, and makes ZERO tool calls", async () => {
    board = await startStatefulMcpBoard({ adminToken });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    class ClaimLostError extends Error {
      constructor() {
        super("claim lost");
      }
    }

    const beforeToolCall = vi.fn(async () => {
      throw new ClaimLostError();
    });

    await expect(
      registerCommsBoardAgent(
        config,
        {
          boardSub: "paperclip-agent-test",
          displayName: "Test Agent",
          ownerEmail: "owner@redesignhealth.com",
        },
        fetch,
        { beforeToolCall },
      ),
    ).rejects.toThrow(ClaimLostError);

    // Verify: handshake happened, then delete happened, NO tools/call happened!
    expect(board.events.map((e) => e.type)).toEqual(["initialize", "initialized", "delete"]);
  });

  it("invalid response identity fails closed as board_unknown", async () => {
    // 1. Mismatched sub
    board = await startStatefulMcpBoard({
      adminToken,
      toolOutcome: { kind: "mismatched_sub", sub: "paperclip-agent-other" },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const resMismatched = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-expected",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
    );
    expect(resMismatched).toEqual({ ok: false, reason: "board_unknown" });
    await board.close();

    // 2. Invalid UUID
    board = await startStatefulMcpBoard({
      adminToken,
      toolOutcome: { kind: "invalid_uuid" },
    });
    config.boardMcpUrl = board.url;

    const resInvalidUuid = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-expected",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
    );
    expect(resInvalidUuid).toEqual({ ok: false, reason: "board_unknown" });
  });

  it("no leaked secrets in outcomes or error states", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      toolOutcome: { kind: "tool_error", text: `already_registered with token ${adminToken}` },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
    );

    expect(result).toEqual({ ok: false, reason: "board_conflict" });
    expect(JSON.stringify(result)).not.toContain(adminToken);
  });

  it("notification failure cleans up allocated session, returns retryable provisioner_failed, makes ZERO tool calls, and records no checkpoint", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      notificationsOutcome: { kind: "http_status", status: 500 },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const beforeToolCall = vi.fn(async () => {});
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      { beforeToolCall },
    );

    // Returned retryable provisioner_failed
    expect(result).toEqual({ ok: false, reason: "provisioner_failed", retryable: true });
    // Checkpoint callback never called
    expect(beforeToolCall).not.toHaveBeenCalled();
    // Zero tools/call were made
    expect(board.events.filter((e) => e.type === "tools/call")).toHaveLength(0);
    // Cleanup DELETE was sent and processed
    expect(board.events.filter((e) => e.type === "delete")).toHaveLength(1);
    expect(board.sessions.size).toBe(0);
  });

  it("exact request ID matching: string '1' vs numeric 1 mismatch fails as board_unknown", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } },
          }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s-1" } },
        );
      }
      if (body?.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      // tools/call returns string "1" instead of numeric 1
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1", // string "1" vs numeric 1
          result: {
            content: [{ type: "text", text: JSON.stringify({ agent_id: randomUUID(), sub: "paperclip-agent-test" }) }],
            isError: false,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await registerCommsBoardAgent(
      {
        boardMcpUrl: "https://board.example.test/mcp",
        boardAdminToken: "token",
        ownershipApiUrl: "https://ownership.example.test",
        ownershipApiToken: "token",
      },
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetchImpl,
    );

    expect(result).toEqual({ ok: false, reason: "board_unknown" });
  });

  it("exact case-sensitive sub matching: uppercase sub fails as board_unknown", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      toolOutcome: { kind: "mismatched_sub", sub: "PAPERCLIP-AGENT-TEST" },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
    );

    expect(result).toEqual({ ok: false, reason: "board_unknown" });
  });

  it("bounded slow DELETE cleanup finishes within timeout and preserves successful outcome", async () => {
    board = await startStatefulMcpBoard({
      adminToken,
      deleteOutcome: { kind: "delay", ms: 4000 },
    });
    config = {
      boardMcpUrl: board.url,
      boardAdminToken: adminToken,
      ownershipApiUrl: "https://ownership.example.test",
      ownershipApiToken: "test-ownership-token",
    };

    const start = Date.now();
    const result = await registerCommsBoardAgent(
      config,
      {
        boardSub: "paperclip-agent-test",
        displayName: "Test Agent",
        ownerEmail: "owner@redesignhealth.com",
      },
      fetch,
      { beforeToolCall: async () => {} },
    );
    const duration = Date.now() - start;

    expect(result.ok).toBe(true);
    // Cleanup finished within bounded timeout (~3s timeout on delete)
    expect(duration).toBeLessThan(3800);
  });
});
