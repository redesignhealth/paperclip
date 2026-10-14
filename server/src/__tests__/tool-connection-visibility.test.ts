import { describe, expect, it } from "vitest";
import { filterVisibleToolConnections } from "../routes/tool-access.js";
import { ARCANA_STATIC_TEMPLATE_UID } from "../services/default-mcp-spec.js";

const connections: Array<{ id: string; status: string; uid?: string | null; createdByUserId: string }> = [
  { id: "other-draft", status: "draft", createdByUserId: "other-user" },
  { id: "own-draft", status: "draft", createdByUserId: "member-user" },
  { id: "active", status: "active", createdByUserId: "other-user" },
];

describe("tool connection visibility", () => {
  it("keeps foreign drafts out of a regular member's reusable connection candidates", () => {
    expect(filterVisibleToolConnections(connections, {
      userId: "member-user",
      canManageConnections: false,
    })).toEqual([
      connections[1],
      connections[2],
    ]);
  });

  it("keeps every draft visible to a connection manager", () => {
    expect(filterVisibleToolConnections(connections, {
      userId: "owner-user",
      canManageConnections: true,
    })).toEqual(connections);
  });

  it("hides the static Arcana template from every viewer, managers included, but not per-agent connections", () => {
    const withTemplate = [
      ...connections,
      { id: "template", status: "active", uid: ARCANA_STATIC_TEMPLATE_UID, createdByUserId: "owner-user" },
      { id: "per-agent", status: "active", uid: "rh-arcana-brain/abc123", createdByUserId: "owner-user" },
    ];
    for (const canManageConnections of [true, false]) {
      const ids = filterVisibleToolConnections(withTemplate, { userId: "owner-user", canManageConnections }).map((c) => c.id);
      expect(ids).not.toContain("template");
      expect(ids).toContain("per-agent");
    }
  });
});
