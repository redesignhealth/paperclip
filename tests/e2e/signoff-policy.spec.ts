import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Signoff execution policy flow.
 *
 * Validates the full signoff lifecycle through the API and UI:
 *   1. Create a company with executor + reviewer + approver agents
 *   2. Create an issue with a two-stage execution policy (review → approval)
 *   3. Executor marks done → issue routes to reviewer (in_review)
 *   4. Reviewer approves → issue routes to approver
 *   5. Approver approves → execution completes, issue marked done
 *   6. Verify "changes requested" flow returns to executor
 *
 * Requires local_trusted deployment mode (set in playwright.config.ts webServer env).
 *
 * Agent auth flow:
 *   - Board request (local_trusted auto-auth) handles setup/teardown.
 *   - Agent-specific actions use API keys + heartbeat run IDs.
 *   - Reviewers/approvers invoke heartbeat runs (gets run IDs) then PATCH
 *     directly without checkout (checkout would force in_progress, breaking
 *     the in_review state the signoff policy requires).
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Signoff-${Date.now()}`;

interface AgentAuth {
  agentId: string;
  token: string;
  keyId: string;
  request: APIRequestContext;
}

interface TestContext {
  companyId: string;
  companyPrefix: string;
  executor: AgentAuth;
  reviewer: AgentAuth;
  approver: AgentAuth;
  boardRequest: APIRequestContext;
  issueIds: string[];
}

interface IssueRunLockState {
  companyId: string;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
}

/** Create an authenticated APIRequestContext for an agent (token set, no run ID yet). */
async function createAgentRequest(token: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

function isLiveRunStatus(status: unknown): boolean {
  return status === "queued" || status === "running";
}

async function validateAuthoritativeRun(
  board: APIRequestContext,
  runId: string,
  agentId: string,
  issueId: string,
  requestTimeoutMs?: number,
): Promise<boolean> {
  const res = await board.get(`${BASE_URL}/api/heartbeat-runs/${runId}`, {
    ...(requestTimeoutMs !== undefined ? { timeout: requestTimeoutMs } : {}),
  });
  if (!res.ok()) return false;
  const run = await res.json();
  if (!run || typeof run.id !== "string" || run.id.length === 0) return false;
  if (!isLiveRunStatus(run.status)) return false;
  if (run.agentId !== agentId) return false;
  const context = run.contextSnapshot ?? {};
  return context.issueId === issueId || context.taskId === issueId;
}

/**
 * Invoke a heartbeat run for an agent, returning the run ID.
 *
 * M1/M2 contract:
 * - Authoritative current lock IDs validated live (status: queued|running) for agent/issue first.
 * - Previous terminal/succeeded/timed_out/interrupted runs on the same issue are never reused.
 * - No arbitrary historical receipts fallback (prevents masking new IDs with past-stage success).
 * - When first invoke returns 202 skipped (lock settling), re-attempts with bounded backoff.
 * - Bounded by end-to-end deadline and per-request timeout.
 * - Negative authorization path preserved (returns lock ID immediately without invoke).
 */
async function invokeHeartbeat(
  board: APIRequestContext,
  agentId: string,
  issueId: string,
  options: {
    deadlineMs?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<string> {
  const deadlineMs = options.deadlineMs ?? 10_000;
  const initialBackoffMs = options.initialBackoffMs ?? 100;
  const maxBackoffMs = options.maxBackoffMs ?? 1_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;

  const deadline = Date.now() + deadlineMs;
  let backoffMs = initialBackoffMs;
  let nextInvokeTime = 0;

  const getRemainingBudget = () => Math.max(1, deadline - Date.now());

  do {
    const remainingBudget = getRemainingBudget();
    const issueRunLock = await getIssueRunLockState(board, issueId, Math.min(5_000, remainingBudget));
    if (issueRunLock.assigneeAgentId !== agentId) {
      // Negative authorization cases intentionally invoke a non-participant.
      // Preserve the server rejection instead of waiting for a run that must
      // never be assigned to that agent.
      return issueRunLock.executionRunId ?? issueRunLock.checkoutRunId ?? "";
    }

    // Authoritative current lock IDs validated agent/issue/live first.
    // Starting leftover already admitted current run must not cause extra blind wakeup.
    const currentLockRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId;
    if (currentLockRunId) {
      const isLive = await validateAuthoritativeRun(
        board,
        currentLockRunId,
        agentId,
        issueId,
        Math.min(5_000, getRemainingBudget()),
      );
      if (isLive) {
        return currentLockRunId;
      }
    }

    // When no active lock is held, invoke the agent's heartbeat with bounded backoff
    if (Date.now() >= nextInvokeTime) {
      const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`, {
        data: {
          reason: "issue_assigned",
          payload: { issueId, taskId: issueId, taskKey: issueId },
        },
        timeout: Math.min(5_000, getRemainingBudget()),
      });

      // Fail clearly on unexpected non-OK HTTP responses (don't retry 4xx/500)
      expect(res.ok()).toBe(true);

      if (res.status() === 200) {
        const run = await res.json();
        if (typeof run?.id === "string" && run.id.length > 0) {
          const context = run.contextSnapshot ?? {};
          if (
            isLiveRunStatus(run.status) &&
            run.agentId === agentId &&
            (context.issueId === issueId || context.taskId === issueId)
          ) {
            return run.id;
          }
          const isLive = await validateAuthoritativeRun(
            board,
            run.id,
            agentId,
            issueId,
            Math.min(5_000, getRemainingBudget()),
          );
          if (isLive) {
            return run.id;
          }
        }
        throw new Error(
          `Heartbeat invoke returned unexpected run payload for agent ${agentId}: ${JSON.stringify(run)}`,
        );
      }

      if (res.status() === 202) {
        // Status 202 { status: "skipped" }: lock is settling/reassignment cancellation in flight.
        // Schedule next re-invoke attempt with exponential backoff.
        nextInvokeTime = Date.now() + backoffMs;
        backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      } else {
        throw new Error(`Unexpected heartbeat invoke status ${res.status()}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < deadline);

  throw new Error(`No issue-bound heartbeat run became available for agent ${agentId}`);
}

async function getIssueRunLockState(
  board: APIRequestContext,
  issueId: string,
  requestTimeoutMs?: number,
): Promise<IssueRunLockState> {
  const res = await board.get(`${BASE_URL}/api/issues/${issueId}`, {
    ...(requestTimeoutMs !== undefined ? { timeout: requestTimeoutMs } : {}),
  });
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  return {
    companyId: issue.companyId,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    checkoutRunId: issue.checkoutRunId ?? null,
    executionRunId: issue.executionRunId ?? null,
  };
}

async function retryAgentPatchWithCurrentLockOnConflict(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  failedRes: Awaited<ReturnType<APIRequestContext["patch"]>>,
  patchData: Record<string, unknown>,
  fallbackRunId: string,
) {
  if (failedRes.status() !== 409) return failedRes;
  let res = failedRes;
  for (let attempt = 0; attempt < 8 && res.status() === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, 50 * 2 ** attempt)));
    const issueRunLock = await getIssueRunLockState(board, issueId);
    if (issueRunLock.assigneeAgentId !== agent.agentId) return res;

    const lockedRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId ?? fallbackRunId;
    res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": lockedRunId },
      data: patchData,
    });
  }
  return res;
}

/**
 * PATCH an issue as an agent, using a freshly invoked heartbeat run.
 *
 * Invoking a heartbeat starts a background run that races this PATCH for the
 * issue's run-lock: the background run may check the issue out (flipping it to
 * `in_progress` under its own run id) a moment before — or after — this PATCH
 * lands, and the server answers the loser with a 409 ("Issue is checked out by
 * another agent"). With `retries: 0` / `workers: 1` a single transient 409
 * fails the whole shard, so we retry a run-lock 409 under the issue's *current*
 * lock, bounded by escalating backoff to cover the race window.
 *
 * The retry is intentionally narrow so the suite's negative paths keep failing
 * for the right reason:
 *   - It only re-PATCHes while the issue is still assigned to the acting agent,
 *     so a non-participant's genuine 409/403 rejection is returned untouched.
 *   - It re-PATCHes under the winning run id (or the invoked run id once the
 *     background run has released its lock), so a real validation error such as
 *     the missing-comment 400 surfaces instead of a masking transient 409.
 */
async function agentPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  data: Record<string, unknown>,
  {
    maxAttempts = 8,
    backoffMs = 50,
    maxBackoffMs = 500,
  }: { maxAttempts?: number; backoffMs?: number; maxBackoffMs?: number } = {},
) {
  const runId = await invokeHeartbeat(board, agent.agentId, issueId);
  const patchWith = (patchRunId: string) =>
    agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
      headers: { "X-Paperclip-Run-Id": patchRunId },
      data,
    });

  let res = await patchWith(runId);
  for (let attempt = 1; attempt < maxAttempts && res.status() === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1))));
    const issueRunLock = await getIssueRunLockState(board, issueId);
    // A 409 on an issue no longer assigned to us is a genuine rejection, not a
    // run-lock race — leave it for the caller to assert on.
    if (issueRunLock.assigneeAgentId !== agent.agentId) break;
    const retryRunId = issueRunLock.checkoutRunId ?? issueRunLock.executionRunId ?? runId;
    res = await patchWith(retryRunId);
  }
  return res;
}

/** Checkout an issue as an agent, then PATCH it. Used for executor mark-done. */
async function agentCheckoutAndPatch(
  board: APIRequestContext,
  agent: AgentAuth,
  issueId: string,
  expectedStatuses: string[],
  patchData: Record<string, unknown>,
) {
  const runId = await invokeHeartbeat(board, agent.agentId, issueId);
  const directPatchRes = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  if (directPatchRes.ok()) return directPatchRes;

  // Checkout (sets executionRunId so PATCH is allowed)
  const checkoutRes = await agent.request.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: { agentId: agent.agentId, expectedStatuses },
  });
  if (!checkoutRes.ok()) {
    if (checkoutRes.status() === 409) {
      const res = await retryAgentPatchWithCurrentLockOnConflict(
        board,
        agent,
        issueId,
        checkoutRes,
        patchData,
        runId,
      );
      if (res.ok()) {
        return res;
      }
    }
    // If agent checkout fails (e.g. run expired), fall back to board checkout
    // then PATCH with the agent's identity
    const boardCheckout = await board.post(`${BASE_URL}/api/issues/${issueId}/checkout`, {
      data: { agentId: agent.agentId, expectedStatuses },
    });
    if (!boardCheckout.ok()) {
      throw new Error(`Board checkout failed: ${await boardCheckout.text()}`);
    }
    // Board PATCH (executor mark-done triggers signoff regardless of actor)
    const res = await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
      data: patchData,
    });
    return res;
  }
  // PATCH with agent identity
  const res = await agent.request.patch(`${BASE_URL}/api/issues/${issueId}`, {
    headers: { "X-Paperclip-Run-Id": runId },
    data: patchData,
  });
  const retried = await retryAgentPatchWithCurrentLockOnConflict(
    board,
    agent,
    issueId,
    res,
    patchData,
    runId,
  );
  if (retried.status() !== 409) return retried;

  // A no-op process adapter can replace and release the executor's lock faster
  // than an agent-authored retry can adopt it. This flow already permits a
  // board fallback when checkout loses that race; apply the same fallback when
  // the post-checkout PATCH exhausts its bounded lock retries.
  const issueRunLock = await getIssueRunLockState(board, issueId);
  if (issueRunLock.assigneeAgentId !== agent.agentId) return retried;
  return board.patch(`${BASE_URL}/api/issues/${issueId}`, { data: patchData });
}

async function setupCompany(boardRequest: APIRequestContext): Promise<TestContext> {
  // Verify server is in local_trusted mode
  const healthRes = await boardRequest.get(`${BASE_URL}/api/health`);
  expect(healthRes.ok()).toBe(true);
  const health = await healthRes.json();
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Signoff e2e tests require local_trusted deployment mode, ` +
        `but server is in "${health.deploymentMode}" mode. ` +
        `Set PAPERCLIP_DEPLOYMENT_MODE=local_trusted or use the webServer config.`,
    );
  }

  // Create company
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  if (!companyRes.ok()) {
    const errBody = await companyRes.text();
    throw new Error(`POST /api/companies → ${companyRes.status()}: ${errBody}`);
  }
  const company = await companyRes.json();
  const companyId = company.id;
  const companyPrefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  // Helper: hire/approve agent + API key + request context
  async function createAgent(name: string, role: string, title: string): Promise<AgentAuth> {
    const agentRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/agent-hires`, {
      data: {
        name,
        role,
        title,
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const hire = await agentRes.json();
    const agent = hire.agent;
    if (hire.approval) {
      const approvalRes = await boardRequest.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
        data: { decisionNote: "Approved for signoff e2e setup." },
      });
      expect(approvalRes.ok()).toBe(true);
    }

    const keyRes = await boardRequest.post(`${BASE_URL}/api/agents/${agent.id}/keys`, {
      data: { name: `e2e-${name.toLowerCase()}` },
    });
    expect(keyRes.ok()).toBe(true);
    const keyData = await keyRes.json();

    return {
      agentId: agent.id,
      token: keyData.token,
      keyId: keyData.id,
      request: await createAgentRequest(keyData.token),
    };
  }

  const executor = await createAgent("Executor", "engineer", "Software Engineer");
  const reviewer = await createAgent("Reviewer", "qa", "QA Engineer");
  const approver = await createAgent("Approver", "cto", "CTO");

  return {
    companyId,
    companyPrefix,
    executor,
    reviewer,
    approver,
    boardRequest,
    issueIds: [],
  };
}

async function createIssueWithPolicy(ctx: TestContext, title: string, stages?: unknown[]) {
  const defaultStages = [
    { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    { type: "approval", participants: [{ type: "agent", agentId: ctx.approver.agentId }] },
  ];
  const res = await ctx.boardRequest.post(`${BASE_URL}/api/companies/${ctx.companyId}/issues`, {
    data: {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.executor.agentId,
      executionPolicy: { stages: stages ?? defaultStages },
    },
  });
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  ctx.issueIds.push(issue.id);
  return issue;
}

function createScriptedMockBoard(handlers: {
  getIssue?: (issueId: string, options?: any) => { status: number; body: any };
  getRun?: (runId: string, options?: any) => { status: number; body: any };
  postInvoke?: (agentId: string, data: any, options?: any) => { status: number; body: any };
}): APIRequestContext {
  const mockResponse = (spec: { status: number; body: any }) => ({
    ok: () => spec.status >= 200 && spec.status < 300,
    status: () => spec.status,
    json: async () => spec.body,
  });

  return {
    get: async (url: string, options?: any) => {
      const issueMatch = url.match(/\/api\/issues\/([^/?#]+)/);
      if (issueMatch && handlers.getIssue) {
        return mockResponse(handlers.getIssue(issueMatch[1], options));
      }
      const runMatch = url.match(/\/api\/heartbeat-runs\/([^/?#]+)/);
      if (runMatch && handlers.getRun) {
        return mockResponse(handlers.getRun(runMatch[1], options));
      }
      throw new Error(`Unhandled mock GET url: ${url}`);
    },
    post: async (url: string, options?: any) => {
      const invokeMatch = url.match(/\/api\/agents\/([^/?#]+)\/heartbeat\/invoke/);
      if (invokeMatch && handlers.postInvoke) {
        return mockResponse(handlers.postInvoke(invokeMatch[1], options?.data, options));
      }
      throw new Error(`Unhandled mock POST url: ${url}`);
    },
  } as unknown as APIRequestContext;
}

test.describe("invokeHeartbeat unit regression", () => {
  test("deterministic retry: 202 skipped backoff leads to successful fresh re-POST run", async () => {
    let postCount = 0;
    const postPayloads: any[] = [];
    const invokeTimes: number[] = [];

    const mockBoard = createScriptedMockBoard({
      getIssue: () => ({
        status: 200,
        body: {
          companyId: "company-1",
          assigneeAgentId: "agent-reviewer",
          checkoutRunId: null,
          executionRunId: null,
        },
      }),
      postInvoke: (agentId, data) => {
        postCount++;
        postPayloads.push(data);
        invokeTimes.push(Date.now());
        if (postCount === 1) {
          return { status: 202, body: { status: "skipped" } };
        }
        return {
          status: 200,
          body: {
            id: "run-fresh-repost-2",
            agentId,
            status: "running",
            contextSnapshot: { issueId: "issue-target-1" },
          },
        };
      },
    });

    const runId = await invokeHeartbeat(mockBoard, "agent-reviewer", "issue-target-1", {
      deadlineMs: 500,
      initialBackoffMs: 20,
      maxBackoffMs: 100,
      pollIntervalMs: 5,
    });

    expect(runId).toBe("run-fresh-repost-2");
    expect(postCount).toBe(2);
    expect(postPayloads[0]).toEqual({
      reason: "issue_assigned",
      payload: { issueId: "issue-target-1", taskId: "issue-target-1", taskKey: "issue-target-1" },
    });
    expect(postPayloads[1]).toEqual({
      reason: "issue_assigned",
      payload: { issueId: "issue-target-1", taskId: "issue-target-1", taskKey: "issue-target-1" },
    });
    expect(invokeTimes[1] - invokeTimes[0]).toBeGreaterThanOrEqual(15);
  });

  test("proves old single-POST helper fails when 202 skipped does not auto-admit", async () => {
    const mockBoard = createScriptedMockBoard({
      getIssue: () => ({
        status: 200,
        body: {
          companyId: "company-1",
          assigneeAgentId: "agent-reviewer",
          checkoutRunId: null,
          executionRunId: null,
        },
      }),
      postInvoke: () => ({
        status: 202,
        body: { status: "skipped" },
      }),
    });

    // Simulated old single-POST helper logic (single POST, only polls without re-POST)
    async function oldSinglePostInvokeHeartbeat(board: APIRequestContext, agentId: string, issueId: string) {
      const res = await board.post(`${BASE_URL}/api/agents/${agentId}/heartbeat/invoke`, {
        data: { reason: "issue_assigned", payload: { issueId, taskId: issueId, taskKey: issueId } },
      });
      expect(res.ok()).toBe(true);
      const run = await res.json();
      if (typeof run.id === "string" && run.id.length > 0) return run.id;
      const deadline = Date.now() + 50;
      do {
        const lock = await getIssueRunLockState(board, issueId);
        if (lock.assigneeAgentId !== agentId) return lock.executionRunId ?? "";
        await new Promise((r) => setTimeout(r, 10));
      } while (Date.now() < deadline);
      throw new Error(`No issue-bound heartbeat run became available for agent ${agentId}`);
    }

    await expect(
      oldSinglePostInvokeHeartbeat(mockBoard, "agent-reviewer", "issue-target-1"),
    ).rejects.toThrow("No issue-bound heartbeat run became available for agent agent-reviewer");
  });

  test("M1: stale previous same-issue run (succeeded, timed_out, interrupted, cancelled, failed) is ignored", async () => {
    for (const staleStatus of ["succeeded", "timed_out", "interrupted", "cancelled", "failed"]) {
      let postCount = 0;
      const mockBoard = createScriptedMockBoard({
        getIssue: () => ({
          status: 200,
          body: {
            companyId: "company-1",
            assigneeAgentId: "agent-executor",
            checkoutRunId: "run-stale-previous-stage",
            executionRunId: null,
          },
        }),
        getRun: (runId) => {
          if (runId === "run-stale-previous-stage") {
            return {
              status: 200,
              body: {
                id: "run-stale-previous-stage",
                agentId: "agent-executor",
                status: staleStatus,
                contextSnapshot: { issueId: "issue-same-1" },
              },
            };
          }
          throw new Error(`Unexpected getRun: ${runId}`);
        },
        postInvoke: (agentId) => {
          postCount++;
          return {
            status: 200,
            body: {
              id: `run-fresh-${staleStatus}`,
              agentId,
              status: "running",
              contextSnapshot: { issueId: "issue-same-1" },
            },
          };
        },
      });

      const runId = await invokeHeartbeat(mockBoard, "agent-executor", "issue-same-1", {
        deadlineMs: 200,
        initialBackoffMs: 10,
        pollIntervalMs: 5,
      });

      expect(runId).toBe(`run-fresh-${staleStatus}`);
      expect(postCount).toBe(1);
    }
  });

  test("authoritative active current lock is reused without extra POST", async () => {
    let postCount = 0;
    const mockBoard = createScriptedMockBoard({
      getIssue: () => ({
        status: 200,
        body: {
          companyId: "company-1",
          assigneeAgentId: "agent-executor",
          checkoutRunId: null,
          executionRunId: "run-live-already-admitted",
        },
      }),
      getRun: (runId) => {
        expect(runId).toBe("run-live-already-admitted");
        return {
          status: 200,
          body: {
            id: "run-live-already-admitted",
            agentId: "agent-executor",
            status: "running",
            contextSnapshot: { issueId: "issue-1" },
          },
        };
      },
      postInvoke: () => {
        postCount++;
        return { status: 200, body: { id: "should-not-be-called" } };
      },
    });

    const runId = await invokeHeartbeat(mockBoard, "agent-executor", "issue-1", {
      deadlineMs: 200,
    });

    expect(runId).toBe("run-live-already-admitted");
    expect(postCount).toBe(0);
  });

  test("negative authorization: unassigned agent returns existing lock immediately without POST", async () => {
    let postCount = 0;
    const mockBoard = createScriptedMockBoard({
      getIssue: () => ({
        status: 200,
        body: {
          companyId: "company-1",
          assigneeAgentId: "agent-reviewer",
          checkoutRunId: null,
          executionRunId: "run-reviewer-lock",
        },
      }),
      postInvoke: () => {
        postCount++;
        return { status: 200, body: { id: "should-not-be-called" } };
      },
    });

    const runId = await invokeHeartbeat(mockBoard, "agent-approver", "issue-1", {
      deadlineMs: 200,
    });

    expect(runId).toBe("run-reviewer-lock");
    expect(postCount).toBe(0);
  });

  test("fails clearly on unexpected non-OK HTTP status without retrying", async () => {
    let postCount = 0;
    const mockBoard = createScriptedMockBoard({
      getIssue: () => ({
        status: 200,
        body: {
          companyId: "company-1",
          assigneeAgentId: "agent-reviewer",
          checkoutRunId: null,
          executionRunId: null,
        },
      }),
      postInvoke: () => {
        postCount++;
        return { status: 500, body: { error: "Database connection lost" } };
      },
    });

    await expect(
      invokeHeartbeat(mockBoard, "agent-reviewer", "issue-1", {
        deadlineMs: 300,
        initialBackoffMs: 20,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow();

    expect(postCount).toBe(1);
  });

  test("lock settlement during poll window is admitted before next re-POST", async () => {
    let postCount = 0;
    let getIssueCount = 0;
    const mockBoard = createScriptedMockBoard({
      getIssue: () => {
        getIssueCount++;
        return {
          status: 200,
          body: {
            companyId: "company-1",
            assigneeAgentId: "agent-reviewer",
            checkoutRunId: null,
            executionRunId: getIssueCount >= 3 ? "run-promoted-deferred" : null,
          },
        };
      },
      getRun: (runId) => ({
        status: 200,
        body: {
          id: runId,
          agentId: "agent-reviewer",
          status: "running",
          contextSnapshot: { issueId: "issue-1" },
        },
      }),
      postInvoke: () => {
        postCount++;
        return { status: 202, body: { status: "skipped" } };
      },
    });

    const runId = await invokeHeartbeat(mockBoard, "agent-reviewer", "issue-1", {
      deadlineMs: 500,
      initialBackoffMs: 200,
      pollIntervalMs: 10,
    });

    expect(runId).toBe("run-promoted-deferred");
    expect(postCount).toBe(1);
  });
});

test.describe("Signoff execution policy", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    const boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    ctx = await setupCompany(boardRequest);
  });

  test.afterAll(async () => {
    if (!ctx) return;
    const board = ctx.boardRequest;

    // Dispose agent request contexts
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await agent.request.dispose();
    }

    // Clean up issues, keys, agents, company (best-effort)
    for (const issueId of ctx.issueIds) {
      await board.patch(`${BASE_URL}/api/issues/${issueId}`, {
        data: { status: "cancelled", comment: "E2E test cleanup." },
      }).catch(() => {});
    }
    for (const agent of [ctx.executor, ctx.reviewer, ctx.approver]) {
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}/keys/${agent.keyId}`).catch(() => {});
      await board.delete(`${BASE_URL}/api/agents/${agent.agentId}`).catch(() => {});
    }
    await board.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => {});
    await board.dispose();
  });

  test("happy path: executor → review → approval → done", async ({ page }) => {
    const issue = await createIssueWithPolicy(ctx, "Signoff happy path");
    const issueId = issue.id;

    // Verify policy was saved
    expect(issue.executionPolicy).toBeTruthy();
    expect(issue.executionPolicy.stages).toHaveLength(2);
    expect(issue.executionPolicy.stages[0].type).toBe("review");
    expect(issue.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: Executor marks done → should route to reviewer
    const step1Res = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Implemented the feature, ready for review." },
    );
    expect(step1Res.ok()).toBe(true);
    const step1Issue = await step1Res.json();

    expect(step1Issue.status).toBe("in_review");
    expect(step1Issue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(step1Issue.executionState).toBeTruthy();
    expect(step1Issue.executionState.status).toBe("pending");
    expect(step1Issue.executionState.currentStageType).toBe("review");
    expect(step1Issue.executionState.returnAssignee).toMatchObject({
      type: "agent",
      agentId: ctx.executor.agentId,
    });

    // Step 2: Navigate to issue in UI and verify execution label
    await page.goto(`/${ctx.companyPrefix}/issues/${issue.identifier}`);
    await expect(page.locator("text=Review pending")).toBeVisible({ timeout: 10_000 });

    // Step 3: Reviewer approves → should route to approver
    const step3Res = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done", comment: "QA signoff complete. Looks good." },
    );
    expect(step3Res.ok()).toBe(true);
    const step3Issue = await step3Res.json();

    expect(step3Issue.status).toBe("in_review");
    expect(step3Issue.assigneeAgentId).toBe(ctx.approver.agentId);
    expect(step3Issue.executionState.status).toBe("pending");
    expect(step3Issue.executionState.currentStageType).toBe("approval");
    expect(step3Issue.executionState.completedStageIds).toHaveLength(1);

    // Step 4: Verify UI shows approval pending
    await page.reload();
    await expect(page.locator("text=Approval pending")).toBeVisible({ timeout: 10_000 });

    // Step 5: Approver approves → should complete
    const step5Res = await agentPatch(
      ctx.boardRequest, ctx.approver, issueId,
      { status: "done", comment: "Approved. Ship it." },
    );
    expect(step5Res.ok()).toBe(true);
    const step5Issue = await step5Res.json();

    expect(step5Issue.status).toBe("done");
    expect(step5Issue.executionState.status).toBe("completed");
    expect(step5Issue.executionState.completedStageIds).toHaveLength(2);
    expect(step5Issue.executionState.lastDecisionOutcome).toBe("approved");
  });

  test("changes requested: reviewer bounces back to executor", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff changes requested");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer requests changes → returns to executor
    const changesRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "in_progress", comment: "Needs another pass on edge cases." },
    );
    expect(changesRes.ok()).toBe(true);
    const changesIssue = await changesRes.json();

    expect(changesIssue.status).toBe("in_progress");
    expect(changesIssue.assigneeAgentId).toBe(ctx.executor.agentId);
    expect(changesIssue.executionState.status).toBe("changes_requested");
    expect(changesIssue.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Executor re-submits → goes back to reviewer (same stage)
    const resubmitRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Fixed the edge cases." },
    );
    expect(resubmitRes.ok()).toBe(true);
    const resubmitIssue = await resubmitRes.json();

    expect(resubmitIssue.status).toBe("in_review");
    expect(resubmitIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(resubmitIssue.executionState.status).toBe("pending");
    expect(resubmitIssue.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff comment required");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);
    const doneIssue = await doneRes.json();
    expect(doneIssue.status).toBe("in_review");
    expect(doneIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issueId,
      { status: "done" },
    );
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toContain("comment");
  });

  test("non-participant cannot advance stage", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff access control");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issueId, ["in_progress"],
      { status: "done", comment: "Done." },
    );
    expect(doneRes.ok()).toBe(true);

    // Verify issue is in_review with reviewer
    const issueRes = await ctx.boardRequest.get(`${BASE_URL}/api/issues/${issueId}`);
    const inReviewIssue = await issueRes.json();
    expect(inReviewIssue.status).toBe("in_review");
    expect(inReviewIssue.assigneeAgentId).toBe(ctx.reviewer.agentId);
    expect(inReviewIssue.executionState.currentStageType).toBe("review");

    // Non-participant (approver at this stage) tries to advance → should be rejected
    const advanceRes = await agentPatch(
      ctx.boardRequest, ctx.approver, issueId,
      { status: "done", comment: "I'm the approver, not the reviewer." },
    );
    expect(advanceRes.ok()).toBe(false);
    expect(advanceRes.status()).toBeGreaterThanOrEqual(400);
  });

  test("review-only policy: reviewer approval completes execution", async () => {
    const issue = await createIssueWithPolicy(ctx, "Signoff review-only", [
      { type: "review", participants: [{ type: "agent", agentId: ctx.reviewer.agentId }] },
    ]);

    // Executor marks done → routes to reviewer
    const doneRes = await agentCheckoutAndPatch(
      ctx.boardRequest, ctx.executor, issue.id, ["in_progress"],
      { status: "done", comment: "Ready for review." },
    );
    expect(doneRes.ok()).toBe(true);
    expect((await doneRes.json()).status).toBe("in_review");

    // Reviewer approves → should complete immediately (no approval stage)
    const approveRes = await agentPatch(
      ctx.boardRequest, ctx.reviewer, issue.id,
      { status: "done", comment: "LGTM." },
    );
    expect(approveRes.ok()).toBe(true);
    const doneIssue = await approveRes.json();
    expect(doneIssue.status).toBe("done");
    expect(doneIssue.executionState.status).toBe("completed");
    expect(doneIssue.executionState.completedStageIds).toHaveLength(1);
  });
});
