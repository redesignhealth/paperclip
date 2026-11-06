import fs from "node:fs";
import { pollUntil, type RunnerApi } from "./api.js";
import { FixtureRegistry } from "./fixture-registry.js";
import {
  memoryRecallScenario,
  parseMemoryRecallTask,
} from "./memory-recall-cases.js";
import {
  gradeMemoryRecall,
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
  type TenantMemoryReader,
  type TypedToolRecord,
} from "./memory-recall-observation.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;

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
  serverLogPath?: string;
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
  let bootProof: string | undefined;
  if (serverLogPath) {
    try {
      const logContent = await fs.promises.readFile(serverLogPath, "utf8");
      bootProof = extractBootProof(logContent);
    } catch (err) {
      if (process.env.PAPERCLIP_RUNNER_E2E_SERVER_LOG) {
        throw new Error(`Failed to read server boot proof from ${serverLogPath}: ${err}`);
      }
    }
  }

  const registry = new FixtureRegistry();
  let secondaryAgentId = "";

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

  const fixtureSetup = await registry.setupAll();
  if (caseId === "cross-agent-leak") {
    const agentY = fixtureSetup.values.get("agent-y") as { id: string } | undefined;
    if (!agentY?.id) {
      throw new Error("Agent Y setup failed: fixture did not return a valid agent ID");
    }
    secondaryAgentId = agentY.id;
  }

  // Snapshot memory IDs before scenario runs
  let tenantReader: TenantMemoryReader | undefined;
  let snapshotIds = new Set<string>();
  const readerFactory = input.tenantReaderFactory ?? openTenantReader;
  if (input.tenantReaderFactory || adminDsn) {
    try {
      tenantReader = await readerFactory(adminDsn ?? "postgres://localhost/test", tenantDbName);
      snapshotIds = await tenantReader.snapshotMemoryIds().catch(() => new Set<string>());
    } catch {
      // Tenant DB not yet created (lazy provisioning)
      snapshotIds = new Set<string>();
    }
  }

  const scenarioIssues: Row[] = [];
  let primaryIssue: Row | undefined;
  let scenarioError: unknown;

  async function pollRunsSummary(): Promise<Array<{ id: string; status: string; issueId?: string }>> {
    return api.get<Array<{ id: string; status: string; issueId?: string }>>(
      `${companyPath}/heartbeat-runs?limit=100`,
    );
  }

  async function waitForIssueRun(issueId: string, label: string, deadline: number) {
    await pollUntil({
      label,
      deadlineAt: deadline,
      intervalMs: 1500,
      load: async () => {
        const summaries = await pollRunsSummary();
        const targetRuns = summaries.filter((r) => r.issueId === issueId);
        return (
          targetRuns.length > 0 &&
          targetRuns.every((r) => ["succeeded", "failed"].includes(r.status))
        );
      },
      accept: (ready) => ready,
    });
  }

  try {
    if (caseId === "save-then-fresh-recall") {
      // Step 1: Save run
      primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Memory Save ${nonce}`,
        description: scenario.savePrompt,
        assigneeAgentId: fixtures.agent.id,
      });
      scenarioIssues.push(primaryIssue);
      await waitForIssueRun(
        primaryIssue.id,
        `memory-recall save turn ${nonce}`,
        Math.max(Date.now() + 5000, input.deadlineAt - 30_000),
      );

      // Step 2: Fresh recall in a separate task/session
      const recallIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Memory Fresh Recall ${nonce}`,
        description: scenario.recallPrompt,
        assigneeAgentId: fixtures.agent.id,
      });
      scenarioIssues.push(recallIssue);
      await waitForIssueRun(
        recallIssue.id,
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
      scenarioIssues.push(controlIssue);
      await waitForIssueRun(
        controlIssue.id,
        `memory-recall control run ${nonce}`,
        Math.max(Date.now() + 5000, input.deadlineAt - 45_000),
      );

      // Step 2: Seed preference
      const seedIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Seed Preference ${nonce}`,
        description: scenario.seedPrompt,
        assigneeAgentId: fixtures.agent.id,
      });
      scenarioIssues.push(seedIssue);
      await waitForIssueRun(
        seedIssue.id,
        `memory-recall seed preference ${nonce}`,
        Math.max(Date.now() + 5000, input.deadlineAt - 30_000),
      );

      // Step 3: Ask for update without mentioning memory
      primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Draft Update ${nonce}`,
        description: scenario.askPrompt,
        assigneeAgentId: fixtures.agent.id,
      });
      scenarioIssues.push(primaryIssue);
      await waitForIssueRun(
        primaryIssue.id,
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
      scenarioIssues.push(primaryIssue);
      await waitForIssueRun(
        primaryIssue.id,
        `memory-recall agent X save ${nonce}`,
        Math.max(Date.now() + 5000, input.deadlineAt - 30_000),
      );

      // Step 2: Agent Y asked for the secret (strictly assigned to secondaryAgentId)
      const issueY = await api.post<Row>(`${companyPath}/issues`, {
        title: `Agent Y Query Secret ${nonce}`,
        description: scenario.agentYPrompt,
        assigneeAgentId: secondaryAgentId,
      });
      scenarioIssues.push(issueY);
      await waitForIssueRun(
        issueY.id,
        `memory-recall agent Y query ${nonce}`,
        input.deadlineAt,
      );
    } else if (caseId === "noise") {
      // 10 ordinary heartbeat issues (no parent issue)
      if (scenario.caseId === "noise") {
        for (let i = 0; i < 10; i++) {
          const issue = await api.post<Row>(`${companyPath}/issues`, {
            title: `Heartbeat Check ${i + 1} ${nonce}`,
            description: scenario.heartbeatPrompts[i] ?? `Heartbeat check ${i + 1}`,
            assigneeAgentId: fixtures.agent.id,
          });
          scenarioIssues.push(issue);
        }
        primaryIssue = scenarioIssues[0];
      }

      await pollUntil({
        label: `memory-recall noise heartbeats ${nonce}`,
        deadlineAt: input.deadlineAt,
        intervalMs: 2000,
        load: async () => {
          const summaries = await pollRunsSummary();
          const targetIssueIds = new Set(scenarioIssues.map((i) => i.id));
          const completedTargetRuns = summaries.filter(
            (r) =>
              r.issueId &&
              targetIssueIds.has(r.issueId) &&
              ["succeeded", "failed"].includes(r.status),
          );
          return completedTargetRuns.length >= scenarioIssues.length;
        },
        accept: (ready) => ready,
      });
    }
  } catch (err) {
    scenarioError = err;
  }

  // In try/finally: read new memories, grade, observe(), write evidence, drop tenant DB, teardown fixtures
  let rawRuns: Row[] = [];
  let mappedRuns: MemoryRecallRunRecord[] = [];
  let comments: Row[] = [];
  let newMemories: MemoryItem[] = [];
  let scoreResult: ReturnType<typeof gradeMemoryRecall> | undefined;

  try {
    // 1. Read new memories from tenant DB
    if (!tenantReader && (input.tenantReaderFactory || adminDsn)) {
      try {
        tenantReader = await readerFactory(adminDsn ?? "postgres://localhost/test", tenantDbName);
      } catch {
        // tenant db not created
      }
    }
    if (tenantReader) {
      try {
        const rows = await tenantReader.readMemoriesSince(snapshotIds);
        newMemories = rows.map((r) => ({
          id: r.id,
          data: r.data,
          agentId: r.agentId,
          userId: r.userId,
          createdAt: r.createdAt,
        }));
      } finally {
        await tenantReader.close().catch(() => {});
      }
    }

    // 2. Fetch run details, logs, comments per issue
    const summaries = await pollRunsSummary().catch(() => []);
    for (const issue of scenarioIssues) {
      const issueRuns = summaries.filter(
        (r) => r.issueId === issue.id && ["succeeded", "failed"].includes(r.status),
      );
      // Exactly one terminal run per scenario issue
      const terminalRunSummary = issueRuns[issueRuns.length - 1];
      if (terminalRunSummary) {
        const runDetail = (await api
          .get<Row>(`/api/heartbeat-runs/${terminalRunSummary.id}`)
          .catch(() => terminalRunSummary)) as Row;
        let logContent = "";
        try {
          const logRes = await api.get<{ content?: string }>(
            `/api/heartbeat-runs/${terminalRunSummary.id}/log`,
          );
          logContent = logRes.content ?? "";
        } catch {
          // log fetch best-effort
        }
        const logText = extractLogText(logContent);
        const toolRecords = typedToolRecords(logText);

        if (runDetail.agentId === undefined || runDetail.agentId === null) {
          throw new Error(`Heartbeat run ${runDetail.id} is missing agentId`);
        }

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
      }

      const issueComments = await api
        .get<Row[]>(`/api/issues/${issue.id}/comments?order=asc`)
        .catch(() => []);
      comments.push(...issueComments);
    }

    // Determine control output for implicit recall
    let controlOutput: string | undefined;
    if (caseId === "implicit-recall" && scenarioIssues.length > 0) {
      const controlIssue = scenarioIssues[0];
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
      issues: scenarioIssues.map((i) => ({
        id: String(i.id),
        status: String(i.status ?? ""),
        title: i.title,
        description: i.description,
      })),
      comments: comments.map((c) => ({
        id: String(c.id),
        issueId: String(c.issueId),
        authorAgentId: c.authorAgentId,
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
      env: process.env,
    });

    // 3. observe()
    input.observe(primaryIssue, rawRuns, scoreResult.checks);

    // 4. write evidence (no raw memory text: counts, categories, prefix-masked excerpts)
    const sanitizedMemories = newMemories.map((m) => ({
      id: m.id,
      agentId: m.agentId,
      userId: m.userId,
      category: m.category,
      createdAt: m.createdAt,
      dataExcerpt:
        m.data.length > 12 ? `${m.data.slice(0, 12)}...` : m.data,
    }));

    await input.evidence("memory-recall-evidence.json", {
      schema: "paperclip.e2e.memory-recall.v1",
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
      ...(bootProof ? { bootProof } : {}),
    });
  } finally {
    // 5. drop tenant DB
    const dropper = input.tenantDropper ?? dropTenantDatabase;
    if (adminDsn || input.tenantDropper) {
      try {
        await dropper(adminDsn ?? "postgres://localhost/test", tenantDbName, tenantRoleName);
      } catch {
        // teardown best-effort
      }
    }

    // 6. teardown fixtures (including Agent Y if created)
    if (secondaryAgentId) {
      try {
        await api.delete(`/api/agents/${secondaryAgentId}`);
      } catch {
        // Documented instance-local no-op mirroring live-fixtures.ts:178-182/386-388
      }
    }
    await fixtureSetup.teardown().catch(() => {});
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
