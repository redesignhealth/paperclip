/**
 * Pure unit tests for partitionCandidates (TECH-8191 PR 4b).
 * Test 5 from plan §7.1: table-driven candidate partition.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  partitionCandidates,
  type CandidateSource,
} from "../../server/src/services/company-memory-upgrade/publish.js";
import type { LiveSourceRow } from "../../server/src/services/company-memory-upgrade/publish-tenant.js";
import type { CpAgentRow } from "../../server/src/services/company-memory-upgrade/agent-routing.js";
import { computeSourceContentSha256 } from "../../server/src/services/company-memory-upgrade/source-hash.js";

test("partitionCandidates pure predicate table", () => {
  const agent1Id = randomUUID();
  const agent2Id = randomUUID();

  const cpAgentMap = new Map<string, CpAgentRow>([
    [
      agent1Id.toLowerCase(),
      { id: agent1Id, name: "Agent 1", adapterType: "hermes_local", status: "active", pausedAt: null },
    ],
    [
      agent2Id.toLowerCase(),
      { id: agent2Id, name: "Agent 2", adapterType: "hermes_local", status: "active", pausedAt: null },
    ],
  ]);

  const baseText = "Memory content unchanged";
  const baseSha = computeSourceContentSha256(baseText);

  // 1. Tombstone: source absent from liveRows
  const tombstoneSrc: CandidateSource = {
    id: randomUUID(),
    agentId: agent1Id,
    sha: baseSha,
    outcome: "published",
  };

  // 2. Hash changed
  const hashChangedSrc: CandidateSource = {
    id: randomUUID(),
    agentId: agent1Id,
    sha: "old-sha-before-change",
    outcome: "published",
  };
  const hashChangedLive: LiveSourceRow = {
    id: hashChangedSrc.id,
    agentId: agent1Id,
    userId: null,
    data: "new content that hashes differently",
    createdAt: null,
    rawPayload: {},
  };

  // 3. Agent reassigned
  const reassignedSrc: CandidateSource = {
    id: randomUUID(),
    agentId: agent1Id,
    sha: baseSha,
    outcome: "published",
  };
  const reassignedLive: LiveSourceRow = {
    id: reassignedSrc.id,
    agentId: agent2Id,
    userId: null,
    data: baseText,
    createdAt: null,
    rawPayload: {},
  };

  // 4. Agent terminated / unroutable
  const unroutableSrc: CandidateSource = {
    id: randomUUID(),
    agentId: agent1Id,
    sha: baseSha,
    outcome: "published",
  };
  const unroutableLive: LiveSourceRow = {
    id: unroutableSrc.id,
    agentId: randomUUID(), // Unknown agent -> unroutable
    userId: null,
    data: baseText,
    createdAt: null,
    rawPayload: {},
  };

  // 5. Unchanged -> publishable
  const unchangedSrc: CandidateSource = {
    id: randomUUID(),
    agentId: agent1Id,
    sha: baseSha,
    outcome: "published",
  };
  const unchangedLive: LiveSourceRow = {
    id: unchangedSrc.id,
    agentId: agent1Id,
    userId: null,
    data: baseText,
    createdAt: null,
    rawPayload: {},
  };

  const liveRows = new Map<string, LiveSourceRow>([
    [hashChangedLive.id, hashChangedLive],
    [reassignedLive.id, reassignedLive],
    [unroutableLive.id, unroutableLive],
    [unchangedLive.id, unchangedLive],
  ]);

  const candidates = [
    tombstoneSrc,
    hashChangedSrc,
    reassignedSrc,
    unroutableSrc,
    unchangedSrc,
  ];

  const res = partitionCandidates(candidates, liveRows, cpAgentMap);

  assert.deepEqual(res.tombstones, [tombstoneSrc.id]);
  assert.equal(res.changed.length, 3);
  assert.equal(res.changed[0].id, hashChangedSrc.id);
  assert.equal(res.changed[1].id, reassignedSrc.id);
  assert.equal(res.changed[2].id, unroutableSrc.id);
  assert.deepEqual(res.publishable, [unchangedSrc]);
});
