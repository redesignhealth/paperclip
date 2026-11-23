import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { companySkillService } from "../services/company-skills.js";
import { withSkillVersionCacheLock } from "../services/skill-version-cache.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("runtime skill listing vs the company skill cache lock (TECH-9904)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runtime-skill-read-not-blocked-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-skill-read-not-blocked-"));
    process.env.PAPERCLIP_HOME = home;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Skill lock", issuePrefix: `SL${companyId.slice(0, 6)}` });
    const svc = companySkillService(db);
    const skill = await svc.createLocalSkill(companyId, { name: "Lock probe skill" });
    return { companyId, svc, skill };
  }

  async function holdLock(companyId: string) {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const holder = withSkillVersionCacheLock(db, companyId, async () => { acquired(); await barrier; });
    await ready;
    return { release, holder };
  }

  it("lists read-only runtime skills while another caller holds the company lock", async () => {
    const { companyId, svc, skill } = await seedCompany();
    const { release, holder } = await holdLock(companyId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        svc.listRuntimeSkillEntries(companyId, { materializeMissing: false }),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
      ]);
      expect(result, "read-only listing must not queue behind the skill cache lock").not.toBeNull();
      expect(result!.map(entry => entry.key)).toContain(skill.key);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await holder;
    }
  }, 30_000);

  it("keeps materializing calls behind the company lock", async () => {
    const { companyId, svc } = await seedCompany();
    const { release, holder } = await holdLock(companyId);
    let settled = false;
    const pending = svc.listRuntimeSkillEntries(companyId, { materializeMissing: true }).finally(() => { settled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(settled).toBe(false);
    } finally {
      release();
      await holder;
    }
    expect((await pending).length).toBeGreaterThan(0);
  }, 30_000);

  it("resolves every skill and returns entries sorted by key under bounded concurrency", async () => {
    const { companyId, svc } = await seedCompany();
    for (let i = 0; i < 12; i++) await svc.createLocalSkill(companyId, { name: `Bulk skill ${i}` });
    const entries = await svc.listRuntimeSkillEntries(companyId, { materializeMissing: false });
    const keys = entries.map(entry => entry.key);
    expect(keys.length).toBeGreaterThanOrEqual(13);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  }, 30_000);
});
