/**
 * Owned vs injected CP pool lifecycle tests (TECH-8191 review finding 4).
 * Verifies owned CP pool is closed on both success and failure, and injected is never closed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  companyMemoryUpgrades,
  createDb,
  getEmbeddedPostgresTestSupport,
  handleEmbeddedPostgresUnsupported,
} from "./memory-upgrade-sweep-helpers.js";
import { runPublish } from "../../server/src/services/company-memory-upgrade/publish.js";
import { setupPublishTestEnvironment } from "./memory-upgrade-publish-helpers.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/state-machine.js";

test("publish orchestrator: owned control-plane pool is closed on success", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-owned-cp-s");
  t.after(async () => {
    await env.cleanup();
  });

  await env.cpDb.insert(companyMemoryUpgrades).values({
    companyId: env.company.id,
    state: "sweeping",
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    publishedCount: 0,
  });

  let endCalled = false;
  const wrappedCreateDb = (url: string, opts?: any) => {
    const db = createDb(url, opts);
    const origEnd = db.$client.end.bind(db.$client);
    db.$client.end = async (...args: any[]) => {
      endCalled = true;
      return await origEnd(...args);
    };
    return db;
  };

  await runPublish(
    {
      companyId: env.company.id,
      confirm: env.company.id,
      controlPlaneDatabaseUrl: env.cpUrl,
    },
    {
      tenantSql: env.tenantWorkerSql,
      _internalSkipVectorIdentityCheck: true,
      _internalCreateCpDb: wrappedCreateDb,
    },
  );

  assert.equal(endCalled, true, "Owned CP client $client.end() must be called on success");
});

test("publish orchestrator: owned control-plane pool is closed on failure", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-owned-cp-f");
  t.after(async () => {
    await env.cleanup();
  });

  // No active upgrade created, so runPublish fails with STATE_MISMATCH
  let endCalled = false;
  const wrappedCreateDb = (url: string, opts?: any) => {
    const db = createDb(url, opts);
    const origEnd = db.$client.end.bind(db.$client);
    db.$client.end = async (...args: any[]) => {
      endCalled = true;
      return await origEnd(...args);
    };
    return db;
  };

  await assert.rejects(
    () =>
      runPublish(
        {
          companyId: env.company.id,
          confirm: env.company.id,
          controlPlaneDatabaseUrl: env.cpUrl,
        },
        {
          tenantSql: env.tenantWorkerSql,
          _internalSkipVectorIdentityCheck: true,
          _internalCreateCpDb: wrappedCreateDb,
        },
      ),
    (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "STATE_MISMATCH",
  );

  assert.equal(endCalled, true, "Owned CP client $client.end() must be called on failure");
});

test("publish orchestrator: injected control-plane client is not closed", async (t) => {
  const support = await getEmbeddedPostgresTestSupport();
  handleEmbeddedPostgresUnsupported(support, t);

  const env = await setupPublishTestEnvironment("orch-injected-cp");
  t.after(async () => {
    await env.cleanup();
  });

  await env.cpDb.insert(companyMemoryUpgrades).values({
    companyId: env.company.id,
    state: "sweeping",
    converterId: "paperclip.memory-upgrade.atomic-converter",
    converterVersion: 1,
    collectionName: "mem0_memories",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 1536,
    publishedCount: 0,
  });

  let endCalled = false;
  const injectedDb = env.cpWorkerDb;
  const origEnd = injectedDb.$client.end.bind(injectedDb.$client);
  injectedDb.$client.end = async (...args: any[]) => {
    endCalled = true;
    return await origEnd(...args);
  };

  await runPublish(
    {
      companyId: env.company.id,
      confirm: env.company.id,
    },
    {
      cpDb: injectedDb,
      tenantSql: env.tenantWorkerSql,
      _internalSkipVectorIdentityCheck: true,
    },
  );

  assert.equal(endCalled, false, "Injected CP client must NOT be closed");
});
