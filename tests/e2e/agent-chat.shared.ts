import path from "node:path";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt";
import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const cleanups = new WeakMap<APIRequestContext, Array<(request: APIRequestContext) => Promise<void>>>();

// A fixture timeout provides a fresh teardown budget even after the body times out.
export const test = base.extend<{ chatCleanup: void }>({
  chatCleanup: [async ({ request, playwright, baseURL, extraHTTPHeaders, httpCredentials,
    ignoreHTTPSErrors, proxy, clientCertificates, userAgent }, use, info) => {
    const callbacks: Array<(request: APIRequestContext) => Promise<void>> = [];
    cleanups.set(request, callbacks);
    const storageState = await request.storageState();
    await use();
    if (!callbacks.length) return;
    const cleanupRequest = await playwright.request.newContext({
      baseURL, extraHTTPHeaders, httpCredentials, ignoreHTTPSErrors, proxy,
      clientCertificates, userAgent, storageState, timeout: 5_000,
    });
    try {
      for (const cleanup of callbacks) {
        try { await cleanup(cleanupRequest); }
        catch (error) {
          await info.attach("chat-cleanup-error", {
            contentType: "text/plain", body: Buffer.from(String(error instanceof AggregateError
              ? error.errors.map(String).join("\n") : error)),
          });
          // Keep a body failure as the primary failure, with cleanup diagnostics attached.
          if (info.status === info.expectedStatus) throw error;
        }
      }
    } finally {
      cleanups.delete(request);
      await cleanupRequest.dispose();
    }
  }, { auto: true, timeout: 90_000 }],
});

// Per-file Playwright configuration (test.use, test.setTimeout) must stay in
// the spec files themselves: calling test.use() from a shared helper makes
// Playwright fail the whole worker with "inconsistent test.use() options".
export async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return response.json();
}
export async function setup(request: APIRequestContext) {
  const company = await json(
    await request.post("/api/companies", {
      data: { visibility: "shared", name: `Agent Chat ${Date.now()}` },
    }),
  );
  const original = await json(
    await request.get("/api/instance/settings/experimental"),
  );
  const callbacks = cleanups.get(request);
  if (!callbacks) throw new Error("setup requires test from agent-chat.shared");
  callbacks.push((cleanupRequest) => restoreExperimentalSettings(cleanupRequest, company.id, original));
  await json(
    await request.patch("/api/instance/settings/experimental", {
      data: { enableAgentChat: true, enableClassicTaskInterface: false },
    }),
  );
  const agents = [];
  for (const name of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"])
    agents.push(
      await json(
        await request.post(`/api/companies/${company.id}/agents`, {
          data: {
            name,
            adapterType: "process",
            adapterConfig: {
              command: process.execPath,
              args: [path.resolve("tests/e2e/fixtures/agent-chat.mjs")],
              graceSec: 1,
            },
            runtimeConfig: {
              heartbeat: { enabled: false, wakeOnDemand: true },
            },
          },
        }),
      ),
    );
  const agent = agents[0];
  const chatPath = `/api/companies/${company.id}/chats/${agent.id}`;
  const route = `/${company.issuePrefix}/chats/${agent.id}`;
  callbacks.push(async (request) => {
        const chat = await request.get(chatPath);
        const history = chat.ok() ? await chat.json() : null;
        const tasks = await json(
          await request.get(`/api/companies/${company.id}/issues`),
        );
        const projects = await json(
          await request.get(`/api/companies/${company.id}/projects`),
        );
        const ledger = await json(
          await request.get(`/api/companies/${company.id}/heartbeat-runs`),
        );
        const documents = await Promise.all(
          [...(history ? [history] : []), ...tasks].map(async (task: any) => ({
            taskId: task.id,
            documents: await json(
              await request.get(`/api/issues/${task.id}/documents`),
            ),
          })),
        );
        await test.info().attach("chat-persisted-state", {
          contentType: "application/json",
          body: Buffer.from(
            JSON.stringify(
              {
                chat: history,
                tasks,
                projects,
                documents,
                comments: history
                  ? await json(
                      await request.get(`/api/issues/${history.id}/comments`),
                    )
                  : [],
                runs: ledger.map((run: any) => ({
                  id: run.id,
                  status: run.status,
                  startedAt: run.startedAt,
                  finishedAt: run.finishedAt,
                  sessionIdBefore: run.sessionIdBefore,
                  sessionIdAfter: run.sessionIdAfter,
                  issueId: run.contextSnapshot?.issueId,
                  generation:
                    run.contextSnapshot?.conversationSessionGeneration,
                  reset: run.contextSnapshot?.conversationReset,
                })),
              },
              null,
              2,
            ),
          ),
        });
  });
  return {
    company, agents, agent, chatPath, route,
    // Compatibility with existing finally blocks; lifecycle is fixture-owned now.
    restore: async () => {},
  };
}
/**
 * Cancels this fixture's live runs, then restores the instance experiment
 * flags.
 *
 * The flag restore is attempted independently of cancellation. Cancelling can fail
 * with a 500 when the recovery transaction's `lock_timeout` expires
 * (`legacy-execution-recovery` holds the issue row `FOR UPDATE`), and that
 * failure used to run before the restore, leaving the shared instance on this
 * fixture's flags. Every later spec then saw `enableAgentChat` as true.
 *
 * A cancel failure is not swallowed: it is rethrown after the flags are
 * restored. Draining is observable and bounded (`expect.poll`), so a run that
 * never leaves the live set fails the test instead of racing the next spec.
 */
export async function restoreExperimentalSettings(
  request: APIRequestContext,
  companyId: string,
  original: { enableAgentChat: boolean; enableClassicTaskInterface: boolean },
) {
  let cancellationError: unknown;
  const cancelDeadline = Date.now() + 40_000;
  try {
    const runs = await json(
      await request.get(`/api/companies/${companyId}/live-runs`, { timeout: 5_000 }),
    );
    for (const run of runs) {
      if (Date.now() >= cancelDeadline) {
        cancellationError ??= new Error("Cancellation budget exhausted before experiment restoration");
        break;
      }
      try {
        await json(
          await request.post(`/api/heartbeat-runs/${run.id}/cancel`, { timeout: 5_000 }),
        );
      } catch (error) {
        cancellationError ??= error;
      }
    }
    // Only drain after every cancel was accepted. A failed cancel may leave a
    // run live, and a drain assertion here would mask that original failure.
    if (!cancellationError && runs.length > 0)
      await expect
        .poll(
          async () =>
            (await json(await request.get(`/api/companies/${companyId}/live-runs`, { timeout: 5_000 })))
              .length,
          { timeout: 30_000, intervals: [100, 250, 500] },
        )
        .toBe(0);
  } catch (error) {
    cancellationError ??= error;
  }
  let restorationError: unknown;
  try {
    await json(
      await request.patch("/api/instance/settings/experimental", {
        data: {
          enableAgentChat: original.enableAgentChat,
          enableClassicTaskInterface: original.enableClassicTaskInterface,
        },
        timeout: 5_000,
      }),
    );
  } catch (error) {
    restorationError = error;
  }
  if (cancellationError && restorationError)
    throw new AggregateError([cancellationError, restorationError], "Run cancellation failed; experiment restoration also failed", { cause: cancellationError });
  if (cancellationError) throw cancellationError;
  if (restorationError) throw restorationError;
}
export async function send(page: Page, value: unknown) {
  await page
    .getByTestId("task-chat-composer-input")
    .last()
    .locator('[contenteditable="true"],textarea')
    .first()
    .fill(
      typeof value === "string"
        ? value
        : `fixture:${Buffer.from(JSON.stringify(value)).toString("base64url")}`,
    );
  await page.getByTestId("task-chat-composer-send").last().click();
}
export async function idle(
  request: APIRequestContext,
  chatPath: string,
  minimumReplies = 1,
) {
  let issue: any;
  await expect
    .poll(
      async () => {
        issue = await json(await request.get(chatPath));
        if (!issue) return false;
        const replies = await json(
          await request.get(`/api/issues/${issue.id}/comments`),
        );
        const live = await json(
          await request.get(`/api/issues/${issue.id}/live-runs`),
        );
        return (
          live.length === 0 &&
          issue.conversationState === "waiting" &&
          issue.status === "in_review" &&
          replies.filter((c: any) => c.authorAgentId).length >= minimumReplies
        );
      },
      { timeout: 60_000, intervals: [100, 250, 500] },
    )
    .toBe(true);
  return issue;
}
