import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, isHermesCliAdvisoryLine } from "./execute.js";

/**
 * Output hygiene for chat-connected runs: Paperclip publishes a run's summary /
 * resultJson.result to the provider thread verbatim, regardless of run status. Two things
 * must therefore never reach that surface: Hermes CLI advisories printed ahead of the reply,
 * and the failure text of a run that exited non-zero.
 */

let child: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string } = {
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
};

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({ signal: null, ...child })),
  };
});

const TIRITH_BANNER =
  "⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only";
// Verbatim banner observed on the pilot (cli_model_switch_mixin); the model names are part of the
// fixture, not a model choice.
const MODEL_BANNER = "⚠️  Normalized model 'claude-haiku-4.5' to 'claude-haiku-4-5' for anthropic.";
const REPLY = "<!subteam^S0ABC> this looks like a **tech/provisioning_deploy** request.";

function makeContext(logs: Array<{ stream: string; chunk: string }>): AdapterExecutionContext {
  return {
    runId: "run-output-hygiene-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 30, graceSec: 2, env: { ANTHROPIC_API_KEY: "FAKE-KEY-FOR-TESTS-not-a-real-credential" } },
    context: { issueId: "issue-1", wakeReason: "manual" },
    authToken: "paperclip-run-token",
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
    onSpawn: async () => {},
  } as unknown as AdapterExecutionContext;
}

describe("isHermesCliAdvisoryLine", () => {
  it("matches the tirith and model-normalization banners, with or without ANSI dimming or OSC links", () => {
    expect(isHermesCliAdvisoryLine(TIRITH_BANNER)).toBe(true);
    expect(isHermesCliAdvisoryLine(`  \u001b[2m${TIRITH_BANNER}\u001b[0m`)).toBe(true);
    expect(isHermesCliAdvisoryLine(`\u001b]8;;https://example.invalid\u0007${TIRITH_BANNER}\u001b]8;;\u0007`)).toBe(true);
    expect(isHermesCliAdvisoryLine(MODEL_BANNER)).toBe(true);
  });

  it("leaves ordinary reply lines alone, including ones that merely contain a warning sign", () => {
    expect(isHermesCliAdvisoryLine(REPLY)).toBe(false);
    expect(isHermesCliAdvisoryLine("⚠ the printer on floor 3 is out of toner")).toBe(false);
    expect(isHermesCliAdvisoryLine("The tirith security scanner is a Hermes feature.")).toBe(false);
  });
});

describe("execute: Hermes CLI advisories never reach the summary", () => {
  beforeEach(() => {
    child = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  });

  it("strips leading advisories and keeps the reply byte-for-byte", async () => {
    child.stdout = `${TIRITH_BANNER}\n${MODEL_BANNER}\n${REPLY}\n\nsession_id: sess-1`;
    const result = await execute(makeContext([]));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(REPLY);
    expect((result.resultJson as { result: string }).result).toBe(REPLY);
    expect(result.summary).not.toContain("tirith");
    expect(result.summary).not.toContain("Normalized model");
  });
});

describe("execute: a non-zero exit never produces a publishable summary", () => {
  beforeEach(() => {
    child = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  });

  it("keeps the failure text in errorMessage only", async () => {
    child = {
      exitCode: 1,
      timedOut: false,
      stdout: `${TIRITH_BANNER}\nHTTP 401: Missing Authentication header\n`,
      stderr: "",
    };
    const result = await execute(makeContext([]));
    expect(result.exitCode).toBe(1);
    expect(result.summary).toBeUndefined();
    expect((result.resultJson as { result: string }).result).toBe("");
    expect(result.errorMessage).toBe("Hermes exited with code 1: HTTP 401: Missing Authentication header");
  });

  it("a clean exit with a session id still produces the summary (regression guard)", async () => {
    child.stdout = `${REPLY}\n\nsession_id: sess-2`;
    const result = await execute(makeContext([]));
    expect(result.summary).toBe(REPLY);
    expect(result.errorMessage).toBeUndefined();
  });

  it("advisory-only stdout on a non-zero exit yields the bare exit message", async () => {
    child = { exitCode: 1, timedOut: false, stdout: `${TIRITH_BANNER}\n`, stderr: "" };
    const result = await execute(makeContext([]));
    expect(result.summary).toBeUndefined();
    expect(result.errorMessage).toBe("Hermes exited with code 1");
  });

  it("an error-pattern stderr still wins over the stdout excerpt", async () => {
    child = { exitCode: 1, timedOut: false, stdout: "HTTP 401: Missing Authentication header\n", stderr: "Traceback (most recent call last): boom\n" };
    const result = await execute(makeContext([]));
    expect(result.summary).toBeUndefined();
    expect(result.errorMessage).toContain("Traceback");
    expect(result.errorMessage).not.toContain("HTTP 401");
  });

  it("a signal exit is a cancellation, not a failure: partial stdout and no errorMessage (unchanged)", async () => {
    child = { exitCode: null, timedOut: false, stdout: "partial output before SIGTERM\n", stderr: "" };
    (child as { signal?: string }).signal = "SIGTERM";
    const result = await execute(makeContext([]));
    expect(result.summary).toBe("partial output before SIGTERM");
    expect(result.errorMessage).toBeUndefined();
  });

  it("a timed-out run still publishes its partial stdout (behaviour intentionally unchanged)", async () => {
    child = { exitCode: null, timedOut: true, stdout: "partial answer so far\n", stderr: "" };
    const result = await execute(makeContext([]));
    expect(result.timedOut).toBe(true);
    expect(result.summary).toBe("partial answer so far");
  });

  it("ANSI escapes never survive into the retained reply or the error excerpt", async () => {
    child = { exitCode: 1, timedOut: false, stdout: "\u001b[31mHTTP 401: Missing Authentication header\u001b[0m\n", stderr: "" };
    const result = await execute(makeContext([]));
    expect(result.errorMessage).toBe("Hermes exited with code 1: HTTP 401: Missing Authentication header");
    child = { exitCode: 0, timedOut: false, stdout: `\u001b[1m${REPLY}\u001b[0m\n\nsession_id: sess-3`, stderr: "" };
    const ok = await execute(makeContext([]));
    expect(ok.summary).toBe(REPLY);
  });
});
