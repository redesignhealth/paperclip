import fs from "node:fs";
import { createHash } from "node:crypto";
import { pollUntil, type RunnerApi } from "./api.js";
import { FixtureRegistry } from "./fixture-registry.js";
import {
  memoryRecallDefinitionDigest,
  memoryRecallScenario,
  parseMemoryRecallTask,
} from "./memory-recall-cases.js";
import {
  gradeMemoryRecall,
  MEMORY_RECALL_GRADER_VERSION,
  type MemoryRecallCheck,
  type MemoryRecallObservation,
  type MemoryRecallRunRecord,
  type MemoryItem,
} from "./memory-recall-scoring.js";
import {
  deriveTenantNames,
  dropTenantDatabase,
  extractBootProof,
  extractLogText,
  openTenantReader,
  typedToolRecords,
  verifyAdminPreflight,
  type ServerBootProof,
  type TenantMemoryReader,
  type TypedToolRecord,
} from "./memory-recall-observation.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import type { MemoryHardeningFlags } from "../../packages/shared/src/memory-hardening.js";

type Row = Record<string, any>;

export const HARNESS_TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
]);

export function isDatabaseDoesNotExistError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? "";
  return (
    code === "3D000" ||
    code === "42P01" ||
    /database .* does not exist/i.test(message) ||
    /relation .* does not exist/i.test(message)
  );
}

export async function runMemoryRecallFlow(input: {
  api: RunnerApi;
  fixtures: LiveFixtureValues;
  execution: MatrixExecution;
  nonce: string;
  workspacePath: string;
  deadlineAt: number;
  observe(issue: Row | undefined, runs: Row[], checks: MemoryRecallCheck[]): void;
  evidence(name: string, value: unknown): Promise<void>;
  tenantReaderFactory?: (adminDsn: string, dbName: string) => Promise<TenantMemoryReader>;
  tenantDropper?: (adminDsn: string, dbName: string, roleName?: string) => Promise<void>;
  bootProofLoader?: () => Promise<ServerBootProof>;
  serverLogPath?: string;
  serverFlags?: MemoryHardeningFlags;
  skipPreflightProbe?: boolean;
}) {
  const { api, fixtures, execution, nonce } = input;
  const { caseId, rep } = parseMemoryRecallTask(execution.task.id);
  const scenario = memoryRecallScenario(caseId, nonce);
  const companyPath = `/api/companies/${fixtures.company.id}`;

  const { databaseName: tenantDbName, databaseRole: tenantRoleName } =
    deriveTenantNames(fixtures.company.id);
  const adminDsn = process.env.PAPERCLIP_MEMORY_ADMIN_DATABASE_URL;

  // 1. In-flow preflight: Hermes adapter probe
  if (!input.skipPreflightProbe) {
    const configuredModel =
      process.env.PAPERCLIP_E2E_MEMORY_HERMES_MODEL || execution.profile.model;
    const probeRes = await api.post<{
      checks?: Array<{ code: string; level: string; message: string }>;
    }>(`${companyPath}/adapters/hermes_local/test-environment`, {
      adapterConfig: { model: configuredModel },
    });
    const errorChecks = (probeRes.checks ?? []).filter((c) => c.level === "error");
    if (errorChecks.length > 0) {
      const hermesCliNotFound = errorChecks.some((c) => c.code === "hermes_cli_not_found");
      const details = errorChecks.map((c) => `${c.code}: ${c.message}`).join("; ");
      throw new Error(
        hermesCliNotFound
          ? `Hermes CLI preflight failed (hermes_cli_not_found): ${details}`
          : `Hermes adapter environment probe failed with errors: ${details}`,
      );
    }
  }

  // 2. In-flow preflight: Admin DSN read-only check
  if (adminDsn && !input.tenantReaderFactory) {
    await verifyAdminPreflight(adminDsn, tenantDbName);
  }

  // 3. In-flow preflight: Server log boot proof
  const serverLogPath =
    input.serverLogPath ?? process.env.PAPERCLIP_RUNNER_E2E_SERVER_LOG;
  let bootProof: ServerBootProof | undefined;
  let isSyntheticBootProof = false;
  if (input.bootProofLoader) {
    bootProof = await input.bootProofLoader();
  } else if (serverLogPath) {
    try {
      const logContent = await fs.promises.readFile(serverLogPath, "utf8");
      bootProof = extractBootProof(logContent);
    } catch (err) {
      throw new Error(`Failed to read server boot proof from ${serverLogPath}: ${err}`);
    }
  } else if (input.serverFlags) {
    isSyntheticBootProof = true;
    bootProof = {
      line: "[company-memory] Mock boot proof",
      flags: input.serverFlags,
      toString() {
        return this.line;
      },
    };
  } else if (input.skipPreflightProbe) {
    isSyntheticBootProof = true;
    bootProof = {
      line: '[company-memory] Initialized company memory configuration {"enabled":true,"companyScope":"all"}',
      flags: {
        hermesMemoryConfig: false,
        hermesPromptSplit: false,
        agentScopedMem0: false,
        capabilityMemoryGuidance: false,
      },
      toString() {
        return this.line;
      },
    };
  } else {
    // Fail-closed preflight: server boot proof is required in live runs
    throw new Error(
      "Memory recall preflight failed: server boot proof is required. Set PAPERCLIP_RUNNER_E2E_SERVER_LOG or provide serverLogPath/serverFlags.",
    );
  }

  const registry = new FixtureRegistry();
  let fixtureSetup: Awaited<ReturnType<typeof registry.setupAll>> | undefined;
  let secondaryAgentId = "";
  let primaryIssue: Row | undefined;
  let scenarioError: unknown;
  let rawRuns: Row[] = [];
  let mappedRuns: MemoryRecallRunRecord[] = [];
  let comments: Row[] = [];
  let newMemories: MemoryItem[] = [];
  let scoreResult: ReturnType<typeof gradeMemoryRecall> | undefined;

  interface BoundIssue {
    issue: Row;
    expectedAgentId: string;
  }
  const boundIssues: BoundIssue[] = [];

  try {
    if (caseId === "cross-agent-leak") {
      registry.register<{ id: string }>({
        id: "agent-y",
        async setup() {
          const payload = execution.profile.buildAgent({
            environmentId: fixtures.environment.id,
            environmentFixtureId: "local",
            workspacePath: input.workspacePath,
            secretRefs: fixtures.secretRefs,
            executionId: `${nonce}-agent-y`,
          });
          return api.post<{ id: string }>(`${companyPath}/agents`, {
            ...payload,
            name: `Peer Specialist ${nonce}`,
            role: "general",
            title: "Peer Specialist",
            capabilities:
              "Coordinates operations and answers user questions using accessible memory.",
          });
        },
      });
    }

    fixtureSetup = await registry.setupAll();
    if (caseId === "cross-agent-leak") {
      const agentY = fixtureSetup.values.get("agent-y") as { id: string } | undefined;
      if (!agentY?.id) {
        throw new Error("Agent Y setup failed: fixture did not return a valid agent ID");
      }
      secondaryAgentId = agentY.id;
    }

    // Snapshot memory IDs before scenario runs
    let snapshotIds = new Set<string>();
    const readerFactory = input.tenantReaderFactory ?? openTenantReader;
    if (input.tenantReaderFactory || adminDsn) {
      let snapshotReader: TenantMemoryReader | undefined;
      try {
        snapshotReader = await readerFactory(adminDsn ?? "postgres://localhost/test", tenantDbName);
        snapshotIds = await snapshotReader.snapshotMemoryIds();
      } catch (err) {
        if (isDatabaseDoesNotExistError(err)) {
          // Tenant DB not yet created (lazy provisioning)
          snapshotIds = new Set<string>();
        } else {
          throw err;
        }
      } finally {
        if (snapshotReader) {
          await snapshotReader.close().catch(() => {});
        }
      }
    }

    async function pollRunsSummary(): Promise<
      Array<{
        id: string;
        status: string;
        issueId?: string;
        agentId?: string;
        createdAt?: string;
        startedAt?: string;
      }>
    > {
      return api.get<
        Array<{
          id: string;
          status: string;
          issueId?: string;
          agentId?: string;
          createdAt?: string;
          startedAt?: string;
        }>
      >(`${companyPath}/heartbeat-runs?limit=100`);
    }

    function selectLatestTerminalRun(
      summaries: Array<{
        id: string;
        status: string;
        issueId?: string;
        agentId?: string;
        createdAt?: string;
        startedAt?: string;
      }>,
      issueId: string,
      expectedAgentId: string,
    ) {
      const candidates = summaries.filter(
        (r) =>
          r.issueId === issueId &&
          HARNESS_TERMINAL_RUN_STATUSES.has(r.status) &&
          (r.agentId === undefined || r.agentId === expectedAgentId),
      );
      return (
        candidates.sort(
          (a, b) =>
            new Date(a.startedAt ?? a.createdAt ?? 0).getTime() -
            new Date(b.startedAt ?? b.createdAt ?? 0).getTime(),
        )[candidates.length - 1] ?? null
      );
    }

    async function waitForIssueRun(
      issueId: string,
      expectedAgentId: string,
      label: string,
      deadline: number,
    ) {
      const terminalRun = await pollUntil({
        label,
        deadlineAt: deadline,
        intervalMs: 1500,
        load: async () => {
          const summaries = await pollRunsSummary();
          const issueTerminalRuns = summaries.filter(
            (r) => r.issueId === issueId && HARNESS_TERMINAL_RUN_STATUSES.has(r.status),
          );
          if (issueTerminalRuns.length === 0) return null;
          const sorted = [...issueTerminalRuns].sort(
            (a, b) =>
              new Date(a.startedAt ?? a.createdAt ?? 0).getTime() -
              new Date(b.startedAt ?? b.createdAt ?? 0).getTime(),
          );
          const expectedRuns = sorted.filter(
            (r) => r.agentId === undefined || r.agentId === expectedAgentId,
          );
          return expectedRuns.length > 0
            ? expectedRuns[expectedRuns.length - 1]
            : sorted[sorted.length - 1];
        },
        accept: (run) => run !== null,
      });
      if (terminalRun && terminalRun.status !== "succeeded") {
        throw new Error(
          `Issue ${issueId} run ${terminalRun.id} ended in definitive failure: ${terminalRun.status}`,
        );
      }
      return terminalRun;
    }

    try {
      if (caseId === "save-then-fresh-recall") {
        // Step 1: Save run
        primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
          title: `Memory Save ${nonce}`,
          description: scenario.savePrompt,
          assigneeAgentId: fixtures.agent.id,
        });
        boundIssues.push({ issue: primaryIssue, expectedAgentId: fixtures.agent.id });
        await waitForIssueRun(
          primaryIssue.id,
          fixtures.agent.id,
          `memory-recall save turn ${nonce}`,
          Math.max(Date.now() + 5000, input.deadlineAt - 30_000),
        );

        // Step 2: Fresh recall in a separate task/session
        const recallIssue = await api.post<Row>(`${companyPath}/issues`, {
          title: `Memory Fresh Recall ${nonce}`,
          description: scenario.recallPrompt,
          assigneeAgentId: fixtures.agent.id,
        });
        boundIssues.push({ issue: recallIssue, expectedAgentId: fixtures.agent.id });
        await waitForIssueRun(
          recallIssue.id,
          fixtures.agent.id,
          `memory-recall fresh recall turn ${nonce}`,
          input.deadlineAt,
        );
      } else if (caseId === "implicit-recall") {
        // Step 1: Real control run BEFORE seeding
        const controlIssue = await api.post<Row>(`${companyPath}/issues`, {
          title: `Control Update ${nonce}`,
          description: scenario.controlPrompt,
          assigneeAgentId: fixtures.agent.id,
        });
        boundIssues.push({ issue: controlIssue, expectedAgentId: fixtures.agent.id });
        await waitForIssueRun(
          controlIssue.id,
          fixtures.agent.id,
          `memory-recall control run ${nonce}`,
          Math.max(Date.now() + 5000, input.deadlineAt - 45_000),
        );

        // Step 2: Seed preference
        const seedIssue = await api.post<Row>(`${companyPath}/issues`, {
          title: `Seed Preference ${nonce}`,
          description: scenario.seedPrompt,
          assigneeAgentId: fixtures.agent.id,
        });
        boundIssues.push({ issue: seedIssue, expectedAgentId: fixtures.agent.id });
        await waitForIssueRun(
          seedIssue.id,
          fixtures.agent.id,
          `memory-recall seed preference ${nonce}`,
          Math.max(Date.now() + 5000, input.deadlineAt - 30_000),
        );

        // Step 3: Ask for update without mentioning memory
        primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
          title: `Draft Update ${nonce}`,
          description: scenario.askPrompt,
          assigneeAgentId: fixtures.agent.id,
        });
        boundIssues.push({ issue: primaryIssue, expectedAgentId: fixtures.agent.id });
        await waitForIssueRun(
          primaryIssue.id,
          fixtures.agent.id,
          `memory-recall ask update ${nonce}`,
          input.deadlineAt,
        );
      } else if (caseId === "cross-agent-leak") {
        // Step 1: Agent X saves confidential secret
        primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
          title: `Agent X Save Secret ${nonce}`,
          description: scenario.agentXPrompt,
          assigneeAgentId: fixtures.agent.id,
        });
        boundIssues.push({ issue: primaryIssue, expectedAgentId: fixtures.agent.id });
        await waitForIssueRun(
          primaryIssue.id,
          fixtures.agent.id,
          `memory-recall agent X save ${nonce}`,
          Math.max(Date.now() + 5000, input.deadlineAt - 30_000),
        );

        // Step 2: Agent Y asked for the secret (strictly assigned to secondaryAgentId)
        const issueY = await api.post<Row>(`${companyPath}/issues`, {
          title: `Agent Y Query Secret ${nonce}`,
          description: scenario.agentYPrompt,
          assigneeAgentId: secondaryAgentId,
        });
        boundIssues.push({ issue: issueY, expectedAgentId: secondaryAgentId });
        await waitForIssueRun(
          issueY.id,
          secondaryAgentId,
          `memory-recall agent Y query ${nonce}`,
          input.deadlineAt,
        );
      } else if (caseId === "noise") {
        if (scenario.caseId === "noise") {
          for (let i = 0; i < 10; i++) {
            const issue = await api.post<Row>(`${companyPath}/issues`, {
              title: `Heartbeat Check ${i + 1} ${nonce}`,
              description: scenario.heartbeatPrompts[i] ?? `Heartbeat check ${i + 1}`,
              assigneeAgentId: fixtures.agent.id,
            });
            boundIssues.push({ issue, expectedAgentId: fixtures.agent.id });
          }
          primaryIssue = boundIssues[0]?.issue;
        }

        await pollUntil({
          label: `memory-recall noise heartbeats ${nonce}`,
          deadlineAt: input.deadlineAt,
          intervalMs: 2000,
          load: async () => {
            const summaries = await pollRunsSummary();
            const targetIssueIds = new Set(boundIssues.map((b) => b.issue.id));
            const completedIssueIds = new Set(
              summaries
                .filter(
                  (r) =>
                    r.issueId &&
                    targetIssueIds.has(r.issueId) &&
                    (r.agentId === undefined || r.agentId === fixtures.agent.id) &&
                    HARNESS_TERMINAL_RUN_STATUSES.has(r.status),
                )
                .map((r) => r.issueId!),
            );
            return completedIssueIds.size >= targetIssueIds.size;
          },
          accept: (ready) => ready,
        });
      }
    } catch (err) {
      scenarioError = err;
    }

    try {
      // 1. Read new memories from tenant DB (tolerate ONLY missing lazy DB/table after run as empty observation)
      if (input.tenantReaderFactory || adminDsn) {
        let obsReader: TenantMemoryReader | undefined;
        try {
          obsReader = await readerFactory(adminDsn ?? "postgres://localhost/test", tenantDbName);
          const rows = await obsReader.readMemoriesSince(snapshotIds);
          newMemories = rows.map((r) => ({
            id: r.id,
            data: r.data,
            agentId: r.agentId,
            userId: r.userId,
            createdAt: r.createdAt,
          }));
        } catch (err) {
          if (isDatabaseDoesNotExistError(err)) {
            // Tenant DB / mem0_memories table was never created lazily (e.g. noise case formed no memories)
            newMemories = [];
          } else {
            throw err;
          }
        } finally {
          if (obsReader) {
            await obsReader.close().catch(() => {});
          }
        }
      }

      // 2. Fetch run details, logs, comments per issue (propagate failures, select exact attribution)
      const summaries = await pollRunsSummary();
      for (const { issue, expectedAgentId } of boundIssues) {
        const terminalRunSummary = selectLatestTerminalRun(summaries, issue.id, expectedAgentId);
        if (terminalRunSummary) {
          const runDetail = (await api.get<Row>(
            `/api/heartbeat-runs/${terminalRunSummary.id}`,
          )) as Row;

          if (!runDetail.agentId || runDetail.agentId !== expectedAgentId) {
            console.warn(
              `[memory-recall-flow] Excluding run ${runDetail.id}: agentId "${runDetail.agentId}" does not match expected "${expectedAgentId}"`,
            );
            continue;
          }

          const logRes = await api.get<{ content?: string }>(
            `/api/heartbeat-runs/${terminalRunSummary.id}/log`,
          );
          const logContent = logRes.content ?? "";
          const logText = extractLogText(logContent);
          const toolRecords = typedToolRecords(logText);

          rawRuns.push(runDetail);
          mappedRuns.push({
            id: String(runDetail.id),
            agentId: String(runDetail.agentId),
            status: String(runDetail.status),
            issueId: issue.id,
            result:
              typeof runDetail.resultJson?.result === "string"
                ? runDetail.resultJson.result
                : undefined,
            usage: runDetail.usageJson,
            durationMs:
              typeof runDetail.durationMs === "number" ? runDetail.durationMs : undefined,
            toolRecords,
            logText,
            startedAt: runDetail.startedAt,
            finishedAt: runDetail.finishedAt,
          });

          const issueComments = await api.get<Row[]>(
            `/api/issues/${issue.id}/comments?order=asc`,
          );
          const attributedComments = issueComments
            .filter(
              (c) =>
                c.createdByRunId === terminalRunSummary.id &&
                c.authorAgentId === expectedAgentId,
            )
            .map((c) => ({
              ...c,
              issueId: issue.id,
            }));
          comments.push(...attributedComments);
        }
      }

      // Determine control output for implicit recall
      let controlOutput: string | undefined;
      if (caseId === "implicit-recall" && boundIssues.length > 0) {
        const controlIssue = boundIssues[0]?.issue;
        const controlRun = mappedRuns.find((r) => r.issueId === controlIssue?.id);
        const controlComments = comments.filter((c) => c.issueId === controlIssue?.id);
        controlOutput = [
          controlRun?.result ?? "",
          ...controlComments.map((c) => c.body),
        ]
          .filter(Boolean)
          .join("\n");
      }

      const observation: MemoryRecallObservation = {
        caseId,
        rep,
        nonce,
        runs: mappedRuns,
        issues: boundIssues.map(({ issue }) => ({
          id: String(issue.id),
          status: String(issue.status ?? ""),
          title: issue.title,
          description: issue.description,
        })),
        comments: comments.map((c) => ({
          id: String(c.id),
          issueId: String(c.issueId),
          authorAgentId: c.authorAgentId,
          createdByRunId: c.createdByRunId,
          body: String(c.body ?? ""),
        })),
        memories: newMemories,
        controlOutput,
        secondaryAgentId: secondaryAgentId || undefined,
      };

      scoreResult = gradeMemoryRecall({
        caseId,
        rep,
        marker: scenario.marker,
        observation,
        flags: bootProof.flags,
      });

      // 3. observe()
      input.observe(primaryIssue, rawRuns, scoreResult.checks);

      // 4. write evidence (no raw memory text excerpts: lengths and hashes only)
      const sanitizedMemories = newMemories.map((m) => ({
        id: m.id,
        agentId: m.agentId,
        userId: m.userId,
        category: m.category,
        createdAt: m.createdAt,
        dataLength: m.data.length,
        dataHash: createHash("sha256").update(m.data).digest("hex"),
      }));

      const configuredModel =
        process.env.PAPERCLIP_E2E_MEMORY_HERMES_MODEL || execution.profile.model;

      await input.evidence("memory-recall-evidence.json", {
        schema: "paperclip.e2e.memory-recall.v1",
        graderVersion: MEMORY_RECALL_GRADER_VERSION,
        contentDigest: memoryRecallDefinitionDigest(),
        resolvedModel: configuredModel,
        caseId,
        rep,
        nonce,
        passed: scoreResult.passed,
        passRate: scoreResult.passRate,
        metrics: scoreResult.metrics,
        checks: scoreResult.checks,
        observation: {
          runCount: mappedRuns.length,
          memoryCount: newMemories.length,
          commentCount: comments.length,
          memories: sanitizedMemories,
        },
        bootProof: bootProof.line,
        serverHardeningFlags: bootProof.flags,
        ...(isSyntheticBootProof ? { synthetic: true } : {}),
      });
    } catch (obsErr) {
      if (!scenarioError) {
        scenarioError = obsErr;
      } else {
        scenarioError = new AggregateError(
          [scenarioError, obsErr],
          `Both scenario execution and observation failed: scenario=${String(scenarioError)}; observation=${String(obsErr)}`,
        );
      }
    }
  } finally {
    const cleanupErrors: unknown[] = [];

    // 5. drop tenant DB
    const dropper = input.tenantDropper ?? dropTenantDatabase;
    if (adminDsn || input.tenantDropper) {
      try {
        await dropper(adminDsn ?? "postgres://localhost/test", tenantDbName, tenantRoleName);
      } catch (err) {
        cleanupErrors.push(err);
      }
    }

    // 6. teardown fixtures (including Agent Y if created)
    // Active secondary agents cannot be purged via DELETE /api/agents/:id if their lifecycle
    // is not terminated/rejected, and metered runs keep cost-event references (matching live-fixtures.ts policy).
    // The launcher tears down the entire ephemeral instance at the end of the run anyway.
    // Therefore, secondary agent deletion during in-flow teardown is best-effort and must not fail legitimate runs.
    if (secondaryAgentId) {
      try {
        await api.delete(`/api/agents/${secondaryAgentId}`);
      } catch (err) {
        console.warn(
          `[memory-recall-flow] Best-effort secondary agent ${secondaryAgentId} deletion skipped or failed:`,
          err,
        );
      }
    }

    if (fixtureSetup) {
      try {
        await fixtureSetup.teardown();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }

    if (cleanupErrors.length > 0) {
      if (scenarioError) {
        const aggregate = new AggregateError(
          [scenarioError, ...cleanupErrors],
          `Memory recall flow failed during execution, and cleanup also failed: ${String(scenarioError)}`,
        );
        (aggregate as any).scenarioError = scenarioError;
        (aggregate as any).cleanupErrors = cleanupErrors;
        throw aggregate;
      }
      if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }
      throw new AggregateError(
        cleanupErrors,
        `Memory recall cleanup failed with ${cleanupErrors.length} error(s)`,
      );
    }
  }

  if (scenarioError) {
    throw scenarioError;
  }

  return {
    issue: primaryIssue,
    runs: rawRuns,
    scoreResult: scoreResult!,
    checks: scoreResult!.checks,
  };
}
