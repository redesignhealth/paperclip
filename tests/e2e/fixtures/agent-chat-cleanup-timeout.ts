import { test, setup } from "../agent-chat.shared";

// This harness flips real instance experiment flags and then deliberately
// hangs, so it must never run just because a path or grep filter matched it
// against a shared server. Only the cleanup spec's child run opts in.
test("body timeout still restores experiments", async ({ request }) => {
  if (process.env.PAPERCLIP_CHAT_CLEANUP_HARNESS !== "1")
    throw new Error(
      "tests/e2e/fixtures/agent-chat-cleanup-timeout.ts is a harness for " +
        "agent-chat-cleanup.spec.ts; it mutates instance flags and hangs on purpose. " +
        "Run it only via that spec (PAPERCLIP_CHAT_CLEANUP_HARNESS=1).",
    );
  // Setup-failure scenarios: the server fails agent creation or the enabling
  // PATCH response, so setup() itself throws and must remain the primary error.
  await setup(request);
  // Model the body request being closed before fixture teardown, then really
  // exhaust the body budget (a new context in a body finally is not sufficient).
  await request.dispose();
  if (process.env.CHAT_CLEANUP_COMBINED_FAILURE === "true") throw new Error("original body failure");
  test.setTimeout(500);
  await new Promise(() => {});
});
