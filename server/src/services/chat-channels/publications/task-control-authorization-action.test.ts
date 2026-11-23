import { describe, expect, it, vi } from "vitest";
import { findIssuedTaskControlAuthorizationAction } from "./task-control-authorization-action.js";

function fakeTx(rows: unknown[] = []) {
  const forUpdate = vi.fn(() => Promise.resolve(rows));
  const where = vi.fn(() => ({ for: forUpdate }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { tx: { select } as never, select, where };
}

const base = { companyId: "c", endpointId: "e", publicationId: "p" };

describe("findIssuedTaskControlAuthorizationAction", () => {
  it.each([null, undefined, ""])("never queries chat_actions when conversationId is %j", async (conversationId) => {
    const { tx, select } = fakeTx();
    await expect(findIssuedTaskControlAuthorizationAction(tx, { ...base, conversationId })).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("queries and returns the first row for a real conversation id", async () => {
    const row = { id: "a" };
    const { tx, select, where } = fakeTx([row]);
    await expect(findIssuedTaskControlAuthorizationAction(tx, { ...base, conversationId: "11111111-1111-4111-8111-111111111111" }))
      .resolves.toBe(row);
    expect(select).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
