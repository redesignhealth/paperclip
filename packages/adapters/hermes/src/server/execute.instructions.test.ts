import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { buildPrompt, execute, renderHermesSystemPrompt } from "./execute.js";
import { sessionCodec } from "./index.js";

const SESSION_ID = "20261006_200000_abcdef";
const INSTRUCTIONS = "Synthetic governance marker: request approval before governed actions.";

interface Invocation {
  args: string[];
  queryFile: { path: string; body: string | null; mode: number; directoryMode: number } | null;
  systemPrompt: string | null;
  runId: string;
}

describe("Hermes managed instruction delivery (real capture process)", () => {
  let dir: string;
  let command: string;
  let instructionsFilePath: string;
  let capturePath: string;
  let origHardeningEnv: string | undefined;

  beforeEach(async () => {
    origHardeningEnv = process.env.PAPERCLIP_MEMORY_HARDENING;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-instructions-"));
    command = path.join(dir, "hermes.cjs");
    instructionsFilePath = path.join(dir, "instructions.md");
    capturePath = path.join(dir, "invocations.jsonl");
    await fs.writeFile(instructionsFilePath, INSTRUCTIONS);
    await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const queryPath = args.includes("--query-file") ? args[args.indexOf("--query-file") + 1] : null;
const exitBeforeRead = process.env.FIXTURE_EXIT_BEFORE_READ === "1";
const queryFile = queryPath ? {
  path: queryPath,
  body: exitBeforeRead ? null : fs.readFileSync(queryPath, "utf8"),
  mode: fs.statSync(queryPath).mode & 0o777,
  directoryMode: fs.statSync(path.dirname(queryPath)).mode & 0o777,
} : null;
fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args,
  queryFile,
  systemPrompt: process.env.HERMES_EPHEMERAL_SYSTEM_PROMPT ?? null,
  runId: process.env.PAPERCLIP_RUN_ID,
}) + "\\n");
if (exitBeforeRead) process.exit(2);
if (process.env.FIXTURE_HANG_AFTER_CAPTURE === "1") setInterval(() => {}, 1000);
if (process.env.FIXTURE_STDOUT) console.log(process.env.FIXTURE_STDOUT);
if (args.includes("missing-session")) {
  console.error("\\u001b[1;31mSession missing-session not found.\\u001b[0m");
  process.exit(1);
}
if (process.env.FIXTURE_PROVIDER_ERROR) {
  console.error(process.env.FIXTURE_PROVIDER_ERROR);
  process.exit(1);
}
console.log("Fixture completed\\nsession_id: ${SESSION_ID}");
`, { mode: 0o700 });
  });

  afterEach(async () => {
    if (origHardeningEnv !== undefined) {
      process.env.PAPERCLIP_MEMORY_HARDENING = origHardeningEnv;
    } else {
      delete process.env.PAPERCLIP_MEMORY_HARDENING;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-fresh",
      agent: {
        id: "agent-synthetic", companyId: "company-synthetic", name: "Hermes fixture",
        adapterType: "hermes_local", adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-synthetic" },
      config: {
        hermesCommand: command, provider: "openrouter", model: "fixture-model", cwd: dir,
        instructionsFilePath, env: { CAPTURE_PATH: capturePath }, timeoutSec: 10, graceSec: 1,
      },
      context: {
        issueId: "task-synthetic",
        paperclipTaskMarkdownAssignment: "Complete current synthetic task.",
        paperclipTaskMarkdownCompact: "Current synthetic task.",
        paperclipWake: {
          reason: "issue_commented",
          issue: { id: "task-synthetic", title: "Synthetic task", status: "in_progress" },
          comments: [{ id: "comment-synthetic", body: "Fresh human direction." }],
          commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
      onLog: async () => {},
      ...overrides,
    };
  }

  async function invocations(): Promise<Invocation[]> {
    return (await fs.readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  }

  function query(invocation: Invocation): string {
    return invocation.queryFile?.body ?? invocation.args[invocation.args.indexOf("-q") + 1];
  }

  it.each(["x".repeat(150_000), "経験🧠".repeat(20_000)])(
    "delivers a large prompt intact through a private file (%#)", async (body) => {
      const ctx = context();
      ctx.context.paperclipTaskMarkdownAssignment = body;
      const result = await execute(ctx);
      expect(result.exitCode).toBe(0);
      const [invocation] = await invocations();
      expect(invocation.args.slice(0, 3)).toEqual(["chat", "--query-file", invocation.queryFile?.path]);
      expect(invocation.args).not.toContain("-q");
      expect(invocation.queryFile?.body).toBe(buildPrompt(ctx, ctx.config));
      expect(invocation.queryFile?.body).toContain(body);
      if (process.platform !== "win32") {
        expect(invocation.queryFile?.mode).toBe(0o600);
        expect(invocation.queryFile?.directoryMode).toBe(0o700);
      }
      expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
      expect(invocation.args.every((arg) => Buffer.byteLength(arg) < 65_536)).toBe(true);
      await expect(fs.stat(path.dirname(invocation.queryFile!.path))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([131_071, 131_072])("selects transport at the UTF-8 byte boundary (%i)", async (bytes) => {
    const ctx = context();
    ctx.context.paperclipTaskMarkdownAssignment = "x";
    const fixedBytes = Buffer.byteLength(buildPrompt(ctx, ctx.config)) - 1;
    ctx.context.paperclipTaskMarkdownAssignment = "x".repeat(bytes - fixedBytes);
    const prompt = buildPrompt(ctx, ctx.config);
    expect(Buffer.byteLength(prompt)).toBe(bytes);
    expect((await execute(ctx)).exitCode).toBe(0);
    const [invocation] = await invocations();
    expect(query(invocation)).toBe(prompt);
    if (bytes < 131_072) {
      expect(invocation.args).toContain("-q");
      expect(invocation.args).not.toContain("--query-file");
      expect(invocation.queryFile).toBeNull();
    } else {
      expect(invocation.args).toContain("--query-file");
      expect(invocation.args).not.toContain("-q");
    }
  });

  it("delivers a large resumed turn and retains its session", async () => {
    const ctx = context();
    ctx.runtime.sessionParams = { sessionId: SESSION_ID };
    ctx.context.paperclipTaskMarkdownAssignmentCompact = "x".repeat(150_000);
    expect((await execute(ctx)).exitCode).toBe(0);
    const [invocation] = await invocations();
    expect(invocation.args).toContain("--query-file");
    expect(invocation.args.slice(invocation.args.indexOf("--resume"))).toEqual(["--resume", SESSION_ID]);
    expect(query(invocation)).toBe(buildPrompt(ctx, ctx.config, { resumedSession: true }));
  });

  it("removes the private directory when writing the prompt fails", async () => {
    const ctx = context();
    ctx.context.paperclipTaskMarkdownAssignment = "x".repeat(150_000);
    const write = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("Synthetic prompt write failure"));
    try {
      await expect(execute(ctx)).rejects.toThrow("Synthetic prompt write failure");
      const promptPath = String(write.mock.calls[0][0]);
      expect(path.basename(promptPath)).toBe("query.txt");
      await expect(fs.stat(path.dirname(promptPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      write.mockRestore();
    }
  });

  it("handles an early child exit and removes its unread large prompt", async () => {
    const ctx = context();
    ctx.context.paperclipTaskMarkdownAssignment = "x".repeat(1_000_000);
    ctx.config.env = { CAPTURE_PATH: capturePath, FIXTURE_EXIT_BEFORE_READ: "1" };
    const result = await execute(ctx);
    expect(result.exitCode).toBe(2);
    const [invocation] = await invocations();
    expect(invocation.queryFile?.body).toBeNull();
    await expect(fs.stat(path.dirname(invocation.queryFile!.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a large prompt after the child times out", async () => {
    const ctx = context();
    ctx.context.paperclipTaskMarkdownAssignment = "x".repeat(150_000);
    ctx.config.env = { CAPTURE_PATH: capturePath, FIXTURE_HANG_AFTER_CAPTURE: "1" };
    ctx.config.timeoutSec = 5;
    const result = await execute(ctx);
    expect(result.timedOut).toBe(true);
    if (process.platform !== "win32") expect(result.signal).toBe("SIGTERM");
    const [invocation] = await invocations();
    expect(invocation.queryFile?.body).toContain("x".repeat(150_000));
    await expect(fs.stat(path.dirname(invocation.queryFile!.path))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it.each([false, true])("keeps instructions out of fresh and resumed user turns (conversation=%s)", async (conversationMode) => {
    const fresh = context();
    fresh.context.conversationMode = conversationMode;
    const first = await execute(fresh);
    const params = sessionCodec.deserialize(sessionCodec.serialize(first.sessionParams ?? null));
    expect(params?.sessionId).toBe(SESSION_ID);
    await execute({ ...fresh, runId: "run-resumed", runtime: { ...fresh.runtime, sessionParams: params } });

    const [initial, resumed] = await invocations();
    expect(initial.args).not.toContain("--resume");
    expect(resumed.args.slice(resumed.args.indexOf("--resume"))).toEqual(["--resume", SESSION_ID]);
    for (const invocation of [initial, resumed]) {
      expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
      expect(invocation.systemPrompt).toContain(`Resolve any relative file references from ${dir}/`);
      expect(query(invocation)).not.toContain(INSTRUCTIONS);
      expect(query(invocation)).not.toContain("Safe multiline update pattern:");
      expect(query(invocation)).toContain("Fresh human direction.");
      expect(query(invocation)).toContain(invocation.runId);
      expect(query(invocation)).toContain("company-synthetic");
      expect(invocation.systemPrompt).toContain("$PAPERCLIP_API_KEY");
      expect(invocation.systemPrompt).toContain('-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"');
      expect(invocation.systemPrompt).toContain("body=$(cat <<'MD'");
      expect(invocation.systemPrompt).toContain("--data-binary @-");
      expect(invocation.systemPrompt).toContain('$api/issues/$PAPERCLIP_TASK_ID');
      expect(invocation.systemPrompt).not.toContain(invocation.runId);
    }
  });

  it("reapplies current instructions after edits and a session reset", async () => {
    const ctx = context();
    await execute(ctx);
    await fs.writeFile(instructionsFilePath, "Updated governance marker.");
    await execute({ ...ctx, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    await execute({ ...ctx, runId: "run-reset" });
    const [, edited, reset] = await invocations();
    for (const invocation of [edited, reset]) {
      expect(invocation.systemPrompt).toContain("Updated governance marker.");
      expect(invocation.systemPrompt).not.toContain(INSTRUCTIONS);
      expect(query(invocation)).not.toContain("Updated governance marker.");
    }
    expect(reset.args).not.toContain("--resume");
  });

  it("uses fresh wake context when persistence is disabled despite stored session params", async () => {
    const ctx = context();
    const result = await execute({ ...ctx, config: { ...ctx.config, persistSession: false }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    const [invocation] = await invocations();
    expect(invocation.args).not.toContain("--resume");
    expect(query(invocation)).toContain("## Paperclip Wake Payload");
    expect(query(invocation)).not.toContain("## Paperclip Resume Delta");
    expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
    expect(result.sessionParams).toBeUndefined();
  });

  it.each([false, true])("keeps custom templates and quiet mode dynamic while preserving a configured system overlay (hermesPromptSplit=%s)", async (splitEnabled) => {
    const ctx = context();
    await execute({ ...ctx, config: {
      ...ctx.config, quiet: true, promptTemplate: "Current custom direction for {{runId}}.",
      env: {
        CAPTURE_PATH: capturePath,
        HERMES_EPHEMERAL_SYSTEM_PROMPT: "User configured system guidance.",
        PAPERCLIP_MEMORY_HARDENING: splitEnabled ? "hermes-prompt-split" : "",
      },
    }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    const [invocation] = await invocations();
    expect(invocation.args).toContain("-Q");
    expect(query(invocation)).toContain("Current custom direction for run-fresh.");
    expect(query(invocation)).not.toContain(INSTRUCTIONS);
    expect(invocation.systemPrompt).toContain("User configured system guidance.");
    expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
    expect(invocation.systemPrompt).not.toContain("Current custom direction for run-fresh.");

    if (splitEnabled) {
      expect(query(invocation)).not.toContain("Paperclip runtime identity:");
      expect(query(invocation)).toContain("Paperclip invocation:\n- Run ID: run-fresh");
      expect(invocation.systemPrompt).toContain("Paperclip runtime identity:");
      expect(invocation.systemPrompt).not.toContain("You are agent agent-synthetic (Hermes fixture).");
    } else {
      expect(query(invocation)).toContain("Paperclip runtime identity:");
      expect(query(invocation)).not.toContain("Paperclip invocation:");
      expect(invocation.systemPrompt).not.toContain("Paperclip runtime identity:");
      expect(invocation.systemPrompt).toContain("You are agent agent-synthetic (Hermes fixture).");
    }
  });

  it.each([false, true])("drops communication guidance on resumed sessions (hermesPromptSplit=%s)", async (splitEnabled) => {
    const commGuidance = "Synthetic Slack connection guidance preference.";
    const ctx = context({
      runtime: {
        sessionId: SESSION_ID,
        sessionParams: { sessionId: SESSION_ID },
        sessionDisplayId: SESSION_ID.slice(0, 16),
        taskKey: "task-synthetic",
      },
      context: {
        issueId: "task-synthetic",
        paperclipTaskCommunicationGuidance: commGuidance,
        paperclipTaskMarkdownAssignment: "Complete current synthetic task assignment.",
        paperclipWake: {
          reason: "issue_commented",
          issue: { id: "task-synthetic", title: "Synthetic task", status: "in_progress" },
          comments: [{ id: "comment-resume", body: "New resume direction." }],
          commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
      config: {
        ...context().config,
        env: {
          CAPTURE_PATH: capturePath,
          PAPERCLIP_MEMORY_HARDENING: splitEnabled ? "hermes-prompt-split" : "",
        },
      },
    });

    await execute(ctx);
    const [invocation] = await invocations();
    expect(query(invocation)).not.toContain(commGuidance);
    expect(invocation.systemPrompt).not.toContain(commGuidance);
  });

  it("splits runtime identity, connection guidance, and runtime tools guidance into system prompt under hermes-prompt-split", async () => {
    const ctx = context({
      runtimeTools: { guidance: "Synthetic runtime tools guidance." } as any,
      context: {
        issueId: "task-synthetic",
        paperclipTaskCommunicationGuidance: "Synthetic Slack connection guidance preference.",
        paperclipTaskMarkdownAssignment: "Complete current synthetic task assignment.",
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "task-synthetic", title: "Synthetic task", status: "in_progress" },
          comments: [],
          commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
          fallbackFetchNeeded: false,
        },
      },
    });

    // 1. Flag ON:
    await execute({
      ...ctx,
      runId: "run-split-on",
      config: {
        ...ctx.config,
        env: {
          CAPTURE_PATH: capturePath,
          PAPERCLIP_MEMORY_HARDENING: "hermes-prompt-split",
        },
      },
    });

    // 2. Flag OFF:
    await execute({
      ...ctx,
      runId: "run-split-off",
      config: {
        ...ctx.config,
        env: {
          CAPTURE_PATH: capturePath,
          PAPERCLIP_MEMORY_HARDENING: "",
        },
      },
    });

    const [splitOn, splitOff] = await invocations();

    // Flag ON assertions
    const onQuery = query(splitOn);
    expect(onQuery).not.toContain("You are agent");
    expect(onQuery).not.toContain("Paperclip runtime identity:");
    expect(onQuery).not.toContain("Synthetic Slack connection guidance preference.");
    expect(onQuery).not.toContain("Synthetic runtime tools guidance.");
    expect(onQuery).not.toContain("Connection tools:");
    expect(onQuery).not.toContain("Memory:");
    expect(onQuery).toContain("Complete current synthetic task assignment.");
    expect(onQuery).toContain("## Paperclip Wake Payload");
    expect(onQuery).toContain("Paperclip invocation:\n- Run ID: run-split-on");

    const onSystem = splitOn.systemPrompt!;
    expect(onSystem).not.toContain("You are agent");
    expect(onSystem).not.toContain("Run ID:");
    expect(onSystem).not.toContain("run-split-on");
    expect(onSystem.split("Paperclip runtime identity:")).toHaveLength(2);
    expect(onSystem.split("Synthetic Slack connection guidance preference.")).toHaveLength(2);
    expect(onSystem.split("Synthetic runtime tools guidance.")).toHaveLength(2);
    expect(onSystem.split("Connection tools:")).toHaveLength(2);
    expect(onSystem.split("Memory:")).toHaveLength(2);
    expect(onSystem).toContain(INSTRUCTIONS);

    // Verify overlay ordering: instructions -> identity -> initial communication -> runtime tools -> API guidance -> connection tools
    const instructionsIdx = onSystem.indexOf(INSTRUCTIONS);
    const identityIdx = onSystem.indexOf("Paperclip runtime identity:");
    const commGuidanceIdx = onSystem.indexOf("Synthetic Slack connection guidance preference.");
    const toolsGuidanceIdx = onSystem.indexOf("Synthetic runtime tools guidance.");
    const apiGuidanceIdx = onSystem.indexOf("Paperclip API guidance:");
    const connectionToolsIdx = onSystem.indexOf("Connection tools:");
    expect(instructionsIdx).toBeGreaterThanOrEqual(0);
    expect(identityIdx).toBeGreaterThan(instructionsIdx);
    expect(commGuidanceIdx).toBeGreaterThan(identityIdx);
    expect(toolsGuidanceIdx).toBeGreaterThan(commGuidanceIdx);
    expect(apiGuidanceIdx).toBeGreaterThan(toolsGuidanceIdx);
    expect(connectionToolsIdx).toBeGreaterThan(apiGuidanceIdx);

    // Flag OFF assertions (byte-identical to today)
    const offQuery = query(splitOff);
    const expectedGoldenQuery = [
      'You are "Hermes fixture", an AI agent employee in a Paperclip-managed company.',
      "",
      "Paperclip runtime identity:",
      "- Agent ID: agent-synthetic",
      "- Company ID: company-synthetic",
      "- Run ID: run-split-off",
      "- API base: http://127.0.0.1:3100/api",
      "",
      "## Paperclip Wake Payload",
      "",
      "Use this wake to continue the task, applying new user direction and preserving its approval gates.",
      "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
      "Use this inline wake data first before refetching the issue thread.",
      "",
      "- reason: issue_assigned",
      "- issue: task-synthetic Synthetic task",
      "- fallback fetch needed: no",
      "- issue status: in_progress",
      "",
      "Synthetic runtime tools guidance.",
      "",
      "Synthetic Slack connection guidance preference.",
      "",
      "Complete current synthetic task assignment.",
    ].join("\n");
    expect(offQuery).toBe(expectedGoldenQuery);
    expect(offQuery).toContain("Paperclip runtime identity:");
    expect(offQuery).toContain("Synthetic Slack connection guidance preference.");
    expect(offQuery).toContain("Synthetic runtime tools guidance.");
    expect(offQuery).not.toContain("Paperclip invocation:");

    const offSystem = splitOff.systemPrompt!;
    const expectedGoldenSystem = [
      `${INSTRUCTIONS}\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${dir}/.`,
      renderHermesSystemPrompt(ctx.agent, { includeDefaultIdentity: true }),
    ].join("\n\n");
    expect(offSystem).toBe(expectedGoldenSystem);
    expect(offSystem).toContain("You are agent agent-synthetic (Hermes fixture).");
    expect(offSystem.split("You are agent agent-synthetic (Hermes fixture).")).toHaveLength(2);
    expect(offSystem).not.toContain("Paperclip runtime identity:");
    expect(offSystem).not.toContain("Synthetic Slack connection guidance preference.");
    expect(offSystem).not.toContain("Synthetic runtime tools guidance.");
  });

  it.each([false, true])("keeps an empty wake runnable with current identity (conversation=%s)", async (conversationMode) => {
    await execute(context({ context: { conversationMode } }));
    const [invocation] = await invocations();
    expect(query(invocation)).toContain("run-fresh");
    expect(query(invocation)).not.toContain(INSTRUCTIONS);
    expect(invocation.systemPrompt).toContain(INSTRUCTIONS);
  });

  it("surfaces a missing session without automatically restarting work", async () => {
    const ctx = context();
    const result = await execute({ ...ctx, runtime: { ...ctx.runtime, sessionParams: { sessionId: "missing-session" } } });
    const calls = await invocations();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--resume");
    expect(calls[0].systemPrompt).toContain(INSTRUCTIONS);
    expect(result.exitCode).toBe(1);
    expect(result.sessionParams).toBeUndefined();
  });

  it("does not retry provider failures as a missing session", async () => {
    const ctx = context();
    const result = await execute({ ...ctx, config: { ...ctx.config, env: { CAPTURE_PATH: capturePath, FIXTURE_PROVIDER_ERROR: "Error: provider unavailable" } }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    expect(await invocations()).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("Error: provider unavailable");
  });

  it("preserves failed work even when its output contains a missing-session diagnostic", async () => {
    const ctx = context();
    const result = await execute({ ...ctx, config: { ...ctx.config, env: {
      CAPTURE_PATH: capturePath,
      FIXTURE_STDOUT: `Already updated the task.\nSession ${SESSION_ID} not found.`,
      FIXTURE_PROVIDER_ERROR: "Error: provider unavailable after tool execution",
    } }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    expect(await invocations()).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    // TECH-6989: a non-zero exit never publishes stdout as the run summary (chat threads
    // receive the summary regardless of status); the failure stays in errorMessage.
    expect(result.summary).toBeUndefined();
    expect(result.errorMessage).toBe("Error: provider unavailable after tool execution");
  });

  it("removes an obsolete instruction overlay when the bundle is removed", async () => {
    const ctx = context();
    await execute(ctx);
    await execute({ ...ctx, config: { ...ctx.config, instructionsFilePath: undefined }, runtime: { ...ctx.runtime, sessionParams: { sessionId: SESSION_ID } } });
    const [, resumed] = await invocations();
    expect(resumed.systemPrompt).not.toContain(INSTRUCTIONS);
    expect(resumed.systemPrompt).toContain("Paperclip API guidance:");
    expect(query(resumed)).toContain("Fresh human direction.");
  });

  it("fails early and logs to stderr when PAPERCLIP_MEMORY_HARDENING contains an unknown token", async () => {
    const logs: Array<{ stream: string; chunk: string }> = [];
    const ctx = context({
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      config: {
        ...context().config,
        env: {
          CAPTURE_PATH: capturePath,
          PAPERCLIP_MEMORY_HARDENING: "hermes-prompt-split,unknown-typo-flag",
        },
      },
    });

    await expect(execute(ctx)).rejects.toThrow("Unknown PAPERCLIP_MEMORY_HARDENING token \"unknown-typo-flag\"");
    const stderrLogs = logs.filter((l) => l.stream === "stderr").map((l) => l.chunk).join("");
    expect(stderrLogs).toContain("[hermes] Invalid PAPERCLIP_MEMORY_HARDENING configuration:");
    expect(stderrLogs).toContain("unknown-typo-flag");
  });

  it("enables prompt split when PAPERCLIP_MEMORY_HARDENING is set in ambient process.env", async () => {
    process.env.PAPERCLIP_MEMORY_HARDENING = "hermes-prompt-split";
    const ctx = context({
      config: {
        ...context().config,
        env: { CAPTURE_PATH: capturePath },
      },
    });
    await execute(ctx);
    const [invocation] = await invocations();
    expect(query(invocation)).not.toContain("Paperclip runtime identity:");
    expect(query(invocation)).toContain("Paperclip invocation:\n- Run ID: run-fresh");
    expect(invocation.systemPrompt).toContain("Paperclip runtime identity:");
  });
});
