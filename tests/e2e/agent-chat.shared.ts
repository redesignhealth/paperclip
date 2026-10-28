import path from "node:path";
import { createLocalAgentJwt } from "../../server/src/agent-auth-jwt";
import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

type CleanupPhase = "cancel" | "diagnostics" | "restore";
type CleanupStep = {
  phase: CleanupPhase;
  run: (request: APIRequestContext) => Promise<void>;
};

const cleanups = new WeakMap<APIRequestContext, CleanupStep[]>();

// Teardown is sequenced by explicit phase rather than by registration order
// (fixture cleanup callbacks otherwise run FIFO, which put the flag restore
// ahead of the diagnostics snapshot). Order: stop the running turns, snapshot
// the settled chat, and only then disable Agent Chat again. Snapshotting
// before cancellation would record in-flight runs; snapshotting after the
// flag restore 404s because Agent Chat is already disabled, which is how its
// comments and documents used to be silently dropped.
const CLEANUP_PHASES: readonly CleanupPhase[] = ["cancel", "diagnostics", "restore"];

// Teardown budget. Every step is individually bounded so the restore PATCH is
// always reached inside the fixture budget, even after a body timeout:
//   diagnostics     6 sequential reads x 2s = 12s (per-task document reads
//                   run in parallel, so they add one read, not N)
//   live-runs read  3s
//   cancel loop     20s cancel deadline, +3s for the last in-flight request
//   drain poll      20s poll, +3s for the in-flight request
//   flag restore    3s
// Worst case is ~64s, leaving ~56s of headroom inside FIXTURE_TIMEOUT_MS.
const FIXTURE_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 3_000;
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 2_000;
const CANCEL_DEADLINE_MS = 20_000;
const DRAIN_TIMEOUT_MS = 20_000;

// A fixture timeout provides a fresh teardown budget even after the body times out.
export const test = base.extend<{ chatCleanup: void }>({
  chatCleanup: [async ({ request, playwright, baseURL, extraHTTPHeaders, httpCredentials,
    ignoreHTTPSErrors, proxy, clientCertificates, userAgent }, use, info) => {
    const steps: CleanupStep[] = [];
    cleanups.set(request, steps);
    // Baseline only: if the body disposes this context (see
    // fixtures/agent-chat-cleanup-timeout.ts) it can no longer be read.
    let storageState = await request.storageState();
    await use();
    // Refresh after the body. A test may have re-authenticated, and the
    // cleanup context's cancel/restore calls must carry those cookies.
    try { storageState = await request.storageState(); }
    catch { /* body disposed the request context; keep the baseline */ }
    if (!steps.length) {
      cleanups.delete(request);
      return;
    }
    const cleanupRequest = await playwright.request.newContext({
      baseURL, extraHTTPHeaders, httpCredentials, ignoreHTTPSErrors, proxy,
      clientCertificates, userAgent, storageState, timeout: REQUEST_TIMEOUT_MS,
    });
    const failures: unknown[] = [];
    try {
      // Every step runs, in phase order, even after an earlier one failed.
      for (const phase of CLEANUP_PHASES)
        for (const step of steps.filter((candidate) => candidate.phase === phase)) {
          try {
            await step.run(cleanupRequest);
          } catch (error) {
            if (phase === "diagnostics") {
              // Diagnostics must never fail the test. Record the failure in an
              // attachment instead and carry on to the restore phase.
              await info
                .attach("chat-diagnostics-error", {
                  contentType: "text/plain",
                  body: Buffer.from(flattenErrors(error).map(String).join("\n")),
                })
                .catch(() => {});
              continue;
            }
            failures.push(error);
          }
        }
    } finally {
      cleanups.delete(request);
      await cleanupRequest.dispose();
    }
    if (!failures.length) return;
    const flattened = failures.flatMap(flattenErrors);
    await info.attach("chat-cleanup-error", {
      contentType: "text/plain",
      body: Buffer.from(flattened.map(String).join("\n")),
    });
    // Keep a body failure as the primary failure, with cleanup diagnostics attached.
    if (info.status === info.expectedStatus)
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Chat cleanup failed");
  }, { auto: true, timeout: FIXTURE_TIMEOUT_MS }],
});

function flattenErrors(error: unknown): unknown[] {
  return error instanceof AggregateError
    ? error.errors.flatMap(flattenErrors)
    : [error];
}

function describeError(error: unknown) {
  return flattenErrors(error)
    .map((candidate) =>
      candidate instanceof Error ? candidate.message : String(candidate),
    )
    .join("; ");
}

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
  const steps = cleanups.get(request);
  if (!steps) throw new Error("setup requires test from agent-chat.shared");
  steps.push({
    phase: "cancel",
    run: (cleanupRequest) => cancelLiveRuns(cleanupRequest, company.id),
  });
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
  steps.push({
    phase: "diagnostics",
    run: (cleanupRequest) =>
      capturePersistedState(cleanupRequest, chatPath, company.id),
  });
  steps.push({
    phase: "restore",
    run: (cleanupRequest) => restoreExperimentFlags(cleanupRequest, original),
  });
  return { company, agents, agent, chatPath, route };
}

/**
 * Captures the flushed chat, its tasks, and their documents/comments for the
 * test report.
 *
 * Diagnostics never fail the test: every read is recorded on its own and a
 * failure is reported inside the attachment (`errors`) instead of thrown.
 */
async function capturePersistedState(
  request: APIRequestContext,
  chatPath: string,
  companyId: string,
) {
  const errors: string[] = [];
  const read = async <T>(label: string, fallback: T, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      errors.push(`${label}: ${describeError(error)}`);
      return fallback;
    }
  };
  const get = (url: string) =>
    request.get(url, { timeout: DIAGNOSTICS_REQUEST_TIMEOUT_MS });
  // 404 is legitimate (a test may never create the chat); any other non-2xx
  // is recorded in `errors` rather than silently collapsing to null, which is
  // how a dropped chat used to go unnoticed.
  const chat = await read<{ id?: string } | null>("chat", null, async () => {
    const response = await get(chatPath);
    if (response.status() === 404) return null;
    return await json(response);
  });
  const tasks = await read<any[]>("tasks", [], async () =>
    json(await get(`/api/companies/${companyId}/issues`)),
  );
  const projects = await read<any[]>("projects", [], async () =>
    json(await get(`/api/companies/${companyId}/projects`)),
  );
  const ledger = await read<any[]>("heartbeat-runs", [], async () =>
    json(await get(`/api/companies/${companyId}/heartbeat-runs`)),
  );
  const documents = await Promise.all(
    [...(chat ? [chat] : []), ...tasks].map(async (task: any) => ({
      taskId: task.id,
      documents: await read<any[]>(`documents ${task.id}`, [], async () =>
        json(await get(`/api/issues/${task.id}/documents`)),
      ),
    })),
  );
  const comments = await read<any[]>("comments", [], async () =>
    chat ? json(await get(`/api/issues/${chat.id}/comments`)) : [],
  );
  await test.info().attach("chat-persisted-state", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify(
        {
          errors,
          chat,
          tasks,
          projects,
          documents,
          comments,
          runs: ledger.map((run: any) => ({
            id: run.id,
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            sessionIdBefore: run.sessionIdBefore,
            sessionIdAfter: run.sessionIdAfter,
            issueId: run.contextSnapshot?.issueId,
            generation: run.contextSnapshot?.conversationSessionGeneration,
            reset: run.contextSnapshot?.conversationReset,
          })),
        },
        null,
        2,
      ),
    ),
  });
}
/**
 * Cancels this fixture's live runs and waits for the live set to drain.
 *
 * Cancelling can fail with a 500 when the recovery transaction's
 * `lock_timeout` expires (`legacy-execution-recovery` holds the issue row
 * `FOR UPDATE`). Draining is observable and bounded (`expect.poll`), so a run
 * that never leaves the live set fails the test instead of racing the next
 * spec. The error is surfaced after the drain attempt, never swallowed — but
 * it is a separate teardown phase, so the experiment-flag restore still runs.
 */
export async function cancelLiveRuns(
  request: APIRequestContext,
  companyId: string,
) {
  let cancellationError: unknown;
  const cancelDeadline = Date.now() + CANCEL_DEADLINE_MS;
  try {
    const runs = await json(
      await request.get(`/api/companies/${companyId}/live-runs`, { timeout: REQUEST_TIMEOUT_MS }),
    );
    for (const run of runs) {
      if (Date.now() >= cancelDeadline) {
        cancellationError ??= new Error("Cancellation budget exhausted before experiment restoration");
        break;
      }
      try {
        await json(
          await request.post(`/api/heartbeat-runs/${run.id}/cancel`, { timeout: REQUEST_TIMEOUT_MS }),
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
            (await json(await request.get(`/api/companies/${companyId}/live-runs`, { timeout: REQUEST_TIMEOUT_MS })))
              .length,
          { timeout: DRAIN_TIMEOUT_MS, intervals: [100, 250, 500] },
        )
        .toBe(0);
  } catch (error) {
    cancellationError ??= error;
  }
  if (cancellationError) throw cancellationError;
}

/**
 * Restores the instance experiment flags this fixture changed.
 *
 * Runs as its own teardown phase so a cancellation failure can no longer leave
 * the shared instance on this fixture's flags (every later spec then saw
 * `enableAgentChat` as true).
 */
export async function restoreExperimentFlags(
  request: APIRequestContext,
  original: { enableAgentChat: boolean; enableClassicTaskInterface: boolean },
) {
  await json(
    await request.patch("/api/instance/settings/experimental", {
      data: {
        enableAgentChat: original.enableAgentChat,
        enableClassicTaskInterface: original.enableClassicTaskInterface,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }),
  );
}

/**
 * Cancels this fixture's live runs, then restores the instance experiment
 * flags, preserving both failures if they both fail.
 *
 * Kept exported for callers that want both halves in one call (the fake-request
 * regression test in agent-chat-projects.spec.ts); the fixture itself runs the
 * two phases separately, with the diagnostics snapshot in between.
 */
export async function restoreExperimentalSettings(
  request: APIRequestContext,
  companyId: string,
  original: { enableAgentChat: boolean; enableClassicTaskInterface: boolean },
) {
  let cancellationError: unknown;
  try {
    await cancelLiveRuns(request, companyId);
  } catch (error) {
    cancellationError = error;
  }
  let restorationError: unknown;
  try {
    await restoreExperimentFlags(request, original);
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
