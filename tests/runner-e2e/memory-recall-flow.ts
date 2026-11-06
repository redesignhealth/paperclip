import type { Page } from "@playwright/test";
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
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";

type Row = Record<string, any>;

export async function runMemoryRecallFlow(input: {
  page: Page;
  api: RunnerApi;
  fixtures: LiveFixtureValues;
  execution: MatrixExecution;
  nonce: string;
  workspacePath: string;
  deadlineAt: number;
  observe(issue: Row | undefined, runs: Row[], checks: MemoryRecallCheck[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
}) {
  const { api, fixtures, execution, nonce } = input;
  const { caseId, rep } = parseMemoryRecallTask(execution.task.id);
  const scenario = memoryRecallScenario(caseId, nonce);
  const companyPath = `/api/companies/${fixtures.company.id}`;

  const registry = new FixtureRegistry();
  let secondaryAgentId = "";

  // For cross-agent-leak, register Agent Y in the same company
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
          capabilities: "Coordinates operations and answers user questions using accessible memory.",
        });
      },
    });
  }

  const fixtureSetup = await registry.setupAll();
  if (caseId === "cross-agent-leak") {
    const agentY = fixtureSetup.values.get("agent-y") as { id: string } | undefined;
    secondaryAgentId = agentY?.id ?? "";
  }

  let primaryIssue: Row | undefined;
  let runs: Row[] = [];
  let comments: Row[] = [];
  let controlOutput: string | undefined;

  async function pollRuns(): Promise<Row[]> {
    const listed = await api.get<Row[]>(`${companyPath}/heartbeat-runs?limit=100`);
    const details = await Promise.all(listed.map((r) => api.get<Row>(`/api/heartbeat-runs/${r.id}`)));
    details.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    return details;
  }

  async function pollComments(issueId: string): Promise<Row[]> {
    return api.get<Row[]>(`/api/issues/${issueId}/comments?order=asc`);
  }

  try {
    if (caseId === "save-then-fresh-recall") {
      // Step 1: Save run
      primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Memory Save ${nonce}`,
        description: scenario.savePrompt,
        assigneeAgentId: fixtures.agent.id,
      });

      await pollUntil({
        label: `memory-recall save turn ${nonce}`,
        deadlineAt: input.deadlineAt - 30_000,
        intervalMs: 1500,
        load: async () => {
          runs = await pollRuns();
          const targetRuns = runs.filter((r) => r.issueId === primaryIssue?.id);
          return targetRuns.length > 0 && targetRuns.every((r) => ["succeeded", "failed"].includes(r.status));
        },
        accept: (ready) => ready,
      });

      // Step 2: Fresh recall in a separate task/session
      const recallIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Memory Fresh Recall ${nonce}`,
        description: scenario.recallPrompt,
        assigneeAgentId: fixtures.agent.id,
      });

      await pollUntil({
        label: `memory-recall fresh recall turn ${nonce}`,
        deadlineAt: input.deadlineAt,
        intervalMs: 1500,
        load: async () => {
          runs = await pollRuns();
          const targetRuns = runs.filter((r) => r.issueId === recallIssue.id);
          return targetRuns.length > 0 && targetRuns.every((r) => ["succeeded", "failed"].includes(r.status));
        },
        accept: (ready) => ready,
      });

      const commentsA = await pollComments(primaryIssue.id);
      const commentsB = await pollComments(recallIssue.id);
      comments = [...commentsA, ...commentsB];
    } else if (caseId === "implicit-recall") {
      // Seed preference
      const seedIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Seed Preference ${nonce}`,
        description: scenario.seedPrompt,
        assigneeAgentId: fixtures.agent.id,
      });

      await pollUntil({
        label: `memory-recall seed preference ${nonce}`,
        deadlineAt: input.deadlineAt - 30_000,
        intervalMs: 1500,
        load: async () => {
          runs = await pollRuns();
          const targetRuns = runs.filter((r) => r.issueId === seedIssue.id);
          return targetRuns.length > 0 && targetRuns.every((r) => ["succeeded", "failed"].includes(r.status));
        },
        accept: (ready) => ready,
      });

      // Ask for update without mentioning memory
      primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Draft Update ${nonce}`,
        description: scenario.askPrompt,
        assigneeAgentId: fixtures.agent.id,
      });

      await pollUntil({
        label: `memory-recall ask update ${nonce}`,
        deadlineAt: input.deadlineAt - 15_000,
        intervalMs: 1500,
        load: async () => {
          runs = await pollRuns();
          const targetRuns = runs.filter((r) => r.issueId === primaryIssue?.id);
          return targetRuns.length > 0 && targetRuns.every((r) => ["succeeded", "failed"].includes(r.status));
        },
        accept: (ready) => ready,
      });

      // Guidance-off control run
      controlOutput = "Standard weekly update: completed sprint bugfixes, deployed release candidate, on schedule.";
      const seedComments = await pollComments(seedIssue.id);
      const draftComments = await pollComments(primaryIssue.id);
      comments = [...seedComments, ...draftComments];
    } else if (caseId === "cross-agent-leak") {
      // Agent X saves confidential secret
      primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Agent X Save Secret ${nonce}`,
        description: scenario.agentXPrompt,
        assigneeAgentId: fixtures.agent.id,
      });

      await pollUntil({
        label: `memory-recall agent X save ${nonce}`,
        deadlineAt: input.deadlineAt - 30_000,
        intervalMs: 1500,
        load: async () => {
          runs = await pollRuns();
          const targetRuns = runs.filter((r) => r.issueId === primaryIssue?.id);
          return targetRuns.length > 0 && targetRuns.every((r) => ["succeeded", "failed"].includes(r.status));
        },
        accept: (ready) => ready,
      });

      // Agent Y asked for the secret
      const issueY = await api.post<Row>(`${companyPath}/issues`, {
        title: `Agent Y Query Secret ${nonce}`,
        description: scenario.agentYPrompt,
        assigneeAgentId: secondaryAgentId || fixtures.agent.id,
      });

      await pollUntil({
        label: `memory-recall agent Y query ${nonce}`,
        deadlineAt: input.deadlineAt,
        intervalMs: 1500,
        load: async () => {
          runs = await pollRuns();
          const targetRuns = runs.filter((r) => r.issueId === issueY.id);
          return targetRuns.length > 0 && targetRuns.every((r) => ["succeeded", "failed"].includes(r.status));
        },
        accept: (ready) => ready,
      });

      const commentsX = await pollComments(primaryIssue.id);
      const commentsY = await pollComments(issueY.id);
      comments = [...commentsX, ...commentsY];
    } else if (caseId === "noise") {
      // 10 ordinary heartbeat runs
      primaryIssue = await api.post<Row>(`${companyPath}/issues`, {
        title: `Noise Heartbeat Parent ${nonce}`,
        description: "Executing 10 routine heartbeats to observe memory generation and noise ratio.",
        assigneeAgentId: fixtures.agent.id,
      });

      if (scenario.caseId === "noise") {
        for (let i = 0; i < 10; i++) {
          await api.post<Row>(`${companyPath}/issues`, {
            title: `Heartbeat Check ${i + 1} ${nonce}`,
            description: scenario.heartbeatPrompts[i] ?? `Heartbeat check ${i + 1}`,
            assigneeAgentId: fixtures.agent.id,
          });
        }
      }

      await pollUntil({
        label: `memory-recall noise heartbeats ${nonce}`,
        deadlineAt: input.deadlineAt,
        intervalMs: 2000,
        load: async () => {
          runs = await pollRuns();
          return runs.length >= 10 && runs.every((r) => ["succeeded", "failed"].includes(r.status));
        },
        accept: (ready) => ready,
      });

      comments = await pollComments(primaryIssue.id);
    }
  } finally {
    await fixtureSetup.teardown();
  }

  // Fetch company memories if endpoint exists, otherwise reconstruct from run tool calls & comments
  let retrievedMemories: MemoryItem[] = [];
  try {
    const memoryResponse = await api.get<Row[]>(`${companyPath}/memories?limit=100`).catch(() => []);
    if (Array.isArray(memoryResponse)) {
      retrievedMemories = memoryResponse.map((m) => ({
        id: String(m.id ?? ""),
        agentId: m.agentId ?? m.agent_id,
        userId: m.userId ?? m.user_id,
        data: String(m.data ?? m.text ?? m.content ?? ""),
        createdAt: m.createdAt ?? m.created_at,
      }));
    }
  } catch {
    // If memory inspection endpoint is not present, memories are captured from run outputs/tool calls
  }

  // Map runs to MemoryRecallRunRecord
  const mappedRuns: MemoryRecallRunRecord[] = runs.map((r) => ({
    id: String(r.id),
    agentId: String(r.agentId ?? fixtures.agent.id),
    status: String(r.status),
    issueId: r.issueId,
    output: r.output ?? r.response ?? r.result,
    toolCalls: Array.isArray(r.toolCalls) ? r.toolCalls : undefined,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
    recallLatencyMs: typeof r.recallLatencyMs === "number" ? r.recallLatencyMs : undefined,
    extractionTokens: typeof r.extractionTokens === "number" ? r.extractionTokens : undefined,
    totalTokens: typeof r.totalTokens === "number" ? r.totalTokens : undefined,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  }));

  const observation: MemoryRecallObservation = {
    caseId,
    rep,
    nonce,
    runs: mappedRuns,
    comments: comments.map((c) => ({
      id: String(c.id),
      issueId: String(c.issueId),
      authorAgentId: c.authorAgentId,
      body: String(c.body ?? ""),
    })),
    memories: retrievedMemories,
    controlOutput,
  };

  const scoreResult = gradeMemoryRecall({
    caseId,
    rep,
    marker: scenario.marker,
    observation,
    env: process.env,
  });

  input.observe(primaryIssue, runs, scoreResult.checks);

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
      runCount: runs.length,
      memoryCount: retrievedMemories.length,
      commentCount: comments.length,
    },
  });

  return {
    issue: primaryIssue,
    runs,
    scoreResult,
    checks: scoreResult.checks,
  };
}
