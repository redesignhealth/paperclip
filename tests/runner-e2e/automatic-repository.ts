import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export function automaticRepositoryFiles(nonce: string) {
  return { context: `setup-context-${nonce}.txt`, result: `repository-result-${nonce}.json` };
}

export const automaticRepositoryTask: RunnerTaskFixture = {
  id: "automatic-repository-resume", label: "Repository preparation continues without supervision", groups: [],
  flow: "automatic_repository", workMode: "standard", expectedRunCount: 2,
  automaticRetryPolicy: "single_attempt", attemptTimeoutMs: { local: 12 * 60_000, daytona: 15 * 60_000 },
  turnTimeoutMs: 5 * 60_000, expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Verify a managed repository ${nonce}`,
  buildVisibleMarker: nonce => automaticRepositoryFiles(nonce).result,
  buildPrompt(nonce) {
    const files = automaticRepositoryFiles(nonce);
    return [
      "Verify a repository in this projectless task and deliver the result. Do not create a project or another task.",
      `Before repository setup, generate a fresh unpredictable 32-byte hexadecimal reference using the operating system random source. Save that reference followed by one LF in ${files.context} in the task directory. Do not include its value in comments or the final answer.`,
      `Before requesting repository preparation, register ${files.context} as a downloadable artifact with that exact title. This records the first admission's original bytes.`,
      "Use the task's managed repository capability to prepare the following repository. Keep the task directory as the root.\nhttps://github.com/octocat/Hello-World",
      "When the checkout is ready, read its committed README and HEAD commit. Read the saved context file again; preserve its original reference. If the file is missing or invalid, report the failure and stop. Never recreate, overwrite, or recover it from an attachment or earlier conversation.",
      `Write ${files.result} as JSON with exactly these fields: reference (the saved reference without its trailing LF), readme (the complete committed README bytes as text), and commit (the full HEAD SHA).`,
      `Register ${files.result} as a downloadable artifact work product with that exact title. Deliver its accessible link and finish the verification. Repository setup alone does not complete this request.`,
    ].join("\n");
  },
  buildMatchers: () => [],
};

export interface AutomaticRepositoryObservation {
  reference: string;
  issueDone: boolean;
  runCount: number;
  successfulCommittedRuns: number;
  sourceContinuation: string | null;
  successorSource: string | null;
  workspaceIds: Array<string | null>;
  readyRepository: boolean;
  savedContext: string | null;
  firstSavedContext: string | null;
  firstContextAttributed: boolean;
  firstContextObservedAt: number | null;
  successorStartedAt: number | null;
  predecessorFinishedAt: number | null;
  predecessorRetagged: boolean;
  continuationReceipt: { intentId: string; dispatchId: string } | null;
  actualReadme: string | null;
  actualCommit: string | null;
  downloaded: { reference?: unknown; readme?: unknown; commit?: unknown } | null;
  downloadVerified: boolean;
  visibleDelivery: boolean;
  pendingInteractions: number;
  monitorScheduled: boolean;
}

export function automaticRepositoryStopReason(issue: { status: string }, runs: readonly { status: string }[]) {
  if (runs.length > 2) return "Unexpected extra provider admission";
  if (runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status))) return "A provider admission failed";
  if (runs.length && runs.every(run => run.status === "succeeded")) {
    if (["blocked", "in_review", "cancelled"].includes(issue.status)) return `Repository setup stopped in ${issue.status}; see retained task state`;
    if (issue.status === "done" && runs.length !== 2) return "Task finished without its automatic successor";
  }
}

export function gradeAutomaticRepository(value: AutomaticRepositoryObservation) {
  const check = (id: string, passed: boolean, detail: string) => ({ id, passed, detail });
  return [
    check("durable-completion", value.issueDone && value.runCount === 2 && value.successfulCommittedRuns === 2,
      "Two committed provider admissions must finish the requested result."),
    check("server-owned-continuation", value.sourceContinuation === "same_agent" && value.successorSource === "native_status_decision" && !value.monitorScheduled &&
      !value.predecessorRetagged && value.predecessorFinishedAt !== null && value.successorStartedAt !== null &&
      value.successorStartedAt >= value.predecessorFinishedAt && value.continuationReceipt !== null &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.continuationReceipt.intentId) &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.continuationReceipt.dispatchId) &&
      value.continuationReceipt.intentId !== value.continuationReceipt.dispatchId,
      "The saved same-agent intent must bind a distinct successor dispatch after the unmodified predecessor finishes, without a timer or user message."),
    check("retained-workspace", value.workspaceIds.length === 2 && Boolean(value.workspaceIds[0]) && value.workspaceIds.every(id => id === value.workspaceIds[0]) && value.readyRepository,
      "Both admissions must retain the same task workspace and its prepared repository."),
    check("retained-context", value.firstContextAttributed && value.firstContextObservedAt !== null && value.successorStartedAt !== null &&
      value.firstContextObservedAt < value.successorStartedAt && /^[a-f0-9]{64}\n$/.test(value.firstSavedContext ?? "") &&
      value.firstSavedContext === value.savedContext && value.savedContext === `${value.reference}\n`,
      "The first admission's independently downloaded unpredictable reference must survive setup byte for byte."),
    check("independent-result", value.downloadVerified && value.downloaded !== null &&
      Object.keys(value.downloaded).sort().join(",") === "commit,readme,reference" && value.downloaded.reference === value.reference &&
      typeof value.actualReadme === "string" && value.actualReadme.length > 0 && value.downloaded?.readme === value.actualReadme &&
      typeof value.actualCommit === "string" && /^[a-f0-9]{40}$/.test(value.actualCommit) && value.downloaded?.commit === value.actualCommit,
      "Downloaded result bytes must agree with the independently inspected checkout and original reference."),
    check("accessible-delivery", value.visibleDelivery && value.pendingInteractions === 0, "The originating task must render its result link without an unanswered question."),
  ];
}

export function automaticRepositoryDigest() {
  const hash = createHash("sha256");
  for (const file of ["automatic-repository.ts", "automatic-repository-flow.ts", "registered-artifact.ts", "stock-harness.ts", "runner.spec.ts", "../../skills/paperclip/SKILL.md"])
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}
