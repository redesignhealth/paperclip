import { test, setup } from "../agent-chat.shared";

test("body timeout still restores experiments", async ({ request }) => {
  await setup(request);
  // Model the body request being closed before fixture teardown, then really
  // exhaust the body budget (a new context in a body finally is not sufficient).
  await request.dispose();
  if (process.env.CHAT_CLEANUP_COMBINED_FAILURE === "true") throw new Error("original body failure");
  test.setTimeout(500);
  await new Promise(() => {});
});
