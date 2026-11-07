import { expect, it } from "vitest";
import { automaticRepositoryStopReason, gradeAutomaticRepository, type AutomaticRepositoryObservation } from "./automatic-repository.js";

const sha = "a".repeat(40);
const reference = "c".repeat(64);
const valid: AutomaticRepositoryObservation = { reference, issueDone: true, runCount: 2,
  successfulCommittedRuns: 2, sourceContinuation: "same_agent", successorSource: "native_status_decision", workspaceIds: ["workspace", "workspace"],
  readyRepository: true, savedContext: `${reference}\n`, firstSavedContext: `${reference}\n`, firstContextAttributed: true,
  firstContextObservedAt: 1000, successorStartedAt: 2000, predecessorFinishedAt: 1900, predecessorRetagged: false,
  continuationReceipt: { intentId: "11111111-1111-4111-8111-111111111111", dispatchId: "22222222-2222-4222-8222-222222222222" },
  actualReadme: "Hello World!\n", actualCommit: sha,
  downloaded: { reference, readme: "Hello World!\n", commit: sha }, downloadVerified: true,
  visibleDelivery: true, pendingInteractions: 0, monitorScheduled: false };

it("accepts independent checkout, retained context, and accessible registered output", () => {
  expect(gradeAutomaticRepository(valid).every(check => check.passed)).toBe(true);
});

it("reports a committed setup blocker immediately instead of waiting out the attempt deadline", () => {
  expect(automaticRepositoryStopReason({ status: "blocked" }, [{ status: "succeeded" }])).toContain("stopped in blocked");
  expect(automaticRepositoryStopReason({ status: "done" }, [{ status: "succeeded" }])).toContain("without its automatic successor");
});

it("keeps waiting for an ordinary queued successor and accepts two completed admissions", () => {
  expect(automaticRepositoryStopReason({ status: "in_progress" }, [{ status: "succeeded" }])).toBeUndefined();
  expect(automaticRepositoryStopReason({ status: "in_progress" }, [{ status: "succeeded" }, { status: "queued" }])).toBeUndefined();
  expect(automaticRepositoryStopReason({ status: "done" }, [{ status: "succeeded" }, { status: "succeeded" }])).toBeUndefined();
});

it("rejects unexpected result fields rather than trusting a model's extra claims", () => {
  const extra = { ...valid, downloaded: { ...valid.downloaded, claimedPass: true } };
  expect(gradeAutomaticRepository(extra).find(check => check.id === "independent-result")?.passed).toBe(false);
});

it.each<Partial<AutomaticRepositoryObservation>>([
  { runCount: 1 }, { successfulCommittedRuns: 1 }, { sourceContinuation: "monitor" }, { successorSource: "issue.comment" },
  { workspaceIds: ["old", "new"] }, { savedContext: null }, { firstSavedContext: null }, { firstContextAttributed: false },
  { firstSavedContext: `${"d".repeat(64)}\n` }, { firstSavedContext: "REFERENCE-fresh\n" },
  { firstContextObservedAt: null }, { firstContextObservedAt: 2000 }, { firstContextObservedAt: 3000 }, { successorStartedAt: null },
  { readyRepository: false }, { downloaded: null }, { predecessorFinishedAt: null }, { predecessorFinishedAt: 2001 },
  { predecessorRetagged: true }, { continuationReceipt: null },
  { continuationReceipt: { ...valid.continuationReceipt!, dispatchId: valid.continuationReceipt!.intentId } },
  { continuationReceipt: { ...valid.continuationReceipt!, intentId: "unverified" } },
  { downloaded: { ...valid.downloaded, reference: "REFERENCE-stale" } },
  { downloaded: { ...valid.downloaded, readme: "I inspected it and all checks pass" } },
  { downloaded: { ...valid.downloaded, commit: "b".repeat(40) } },
  { actualCommit: null }, { downloadVerified: false }, { visibleDelivery: false }, { pendingInteractions: 1 }, { monitorScheduled: true },
])("rejects a plausible incomplete or wrong result %j", fault => {
  expect(gradeAutomaticRepository({ ...valid, ...fault }).some(check => !check.passed)).toBe(true);
});
