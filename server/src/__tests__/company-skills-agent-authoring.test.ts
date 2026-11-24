import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, companySkills, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";
import { HttpError } from "../errors.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("company skill agent authoring and edit guards", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  let oldHome: string | undefined;
  let oldInstance: string | undefined;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-skill-authoring-");
    oldHome = process.env.PAPERCLIP_HOME;
    oldInstance = process.env.PAPERCLIP_INSTANCE_ID;
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-skill-home-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldHome;
    if (oldInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldInstance;
    if (home) await fs.rm(home, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Authoring Test Co",
      issuePrefix: `A${id.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function createAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Author Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    });
    return id;
  }

  it("denies agent PATCH files on unmanaged/project-scanned local_path skill", async () => {
    const companyId = await createCompany();
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-scanned-skill-"));
    cleanupDirs.add(externalDir);
    await fs.writeFile(path.join(externalDir, "SKILL.md"), "# External Skill", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `project/project-1/external-skill`,
      slug: "external-skill",
      name: "External Skill",
      markdown: "# External Skill",
      sourceType: "local_path",
      sourceLocator: externalDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "project_scan", projectName: "Project", workspaceName: "ws" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const agentActor = { type: "agent" as const, agentId: randomUUID() };
    const err = await svc.updateFile(companyId, skillId, "SKILL.md", "# Edited Content", agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("Agents can only edit managed local skills");
    expect(err.details).toMatchObject({ code: "skill_agent_edit_restricted" });
  });

  it("denies agent PATCH files on shared skill", async () => {
    const companyId = await createCompany();
    const sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-skill-"));
    cleanupDirs.add(sharedDir);
    await fs.writeFile(path.join(sharedDir, "SKILL.md"), "# Shared Skill", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `shared/shared-skill`,
      slug: "shared-skill",
      name: "Shared Skill",
      markdown: "# Shared Skill",
      sourceType: "local_path",
      sourceLocator: sharedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "shared" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const agentActor = { type: "agent" as const, agentId: randomUUID() };
    const err = await svc.updateFile(companyId, skillId, "SKILL.md", "# Edited Content", agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("Agents can only edit managed local skills");
    expect(err.details).toMatchObject({ code: "skill_agent_edit_restricted" });
  });

  it("denies agent PATCH files on bundled skill", async () => {
    const companyId = await createCompany();
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skill-"));
    cleanupDirs.add(bundledDir);
    await fs.writeFile(path.join(bundledDir, "SKILL.md"), "# Bundled Skill", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `paperclipai/bundled/bundled-skill`,
      slug: "bundled-skill",
      name: "Bundled Skill",
      markdown: "# Bundled Skill",
      sourceType: "local_path",
      sourceLocator: bundledDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "paperclip_bundled" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const agentActor = { type: "agent" as const, agentId: randomUUID() };
    const err = await svc.updateFile(companyId, skillId, "SKILL.md", "# Edited Content", agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("Agents can only edit managed local skills");
    expect(err.details).toMatchObject({ code: "skill_agent_edit_restricted" });
  });

  it("allows agent PATCH files on managed_local skill", async () => {
    const companyId = await createCompany();
    const managedRoot = path.join(home, "instances", "default", "skills", companyId);
    const managedDir = path.join(managedRoot, "agent-managed-skill");
    await fs.mkdir(managedDir, { recursive: true });
    cleanupDirs.add(managedDir);
    await fs.writeFile(path.join(managedDir, "SKILL.md"), "# Original Content", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/agent-managed-skill`,
      slug: "agent-managed-skill",
      name: "Managed Skill",
      markdown: "# Original Content",
      sourceType: "local_path",
      sourceLocator: managedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "managed_local" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const agentId = await createAgent(companyId);
    const agentActor = { type: "agent" as const, agentId };
    const result = await svc.updateFile(companyId, skillId, "SKILL.md", "# Agent Edited Content", agentActor);
    expect(result).toMatchObject({
      path: "SKILL.md",
      content: "# Agent Edited Content",
    });

    const updatedFile = await fs.readFile(path.join(managedDir, "SKILL.md"), "utf8");
    expect(updatedFile).toBe("# Agent Edited Content");
  });

  it("allows board user PATCH files on unmanaged/project-scanned local_path skill (unchanged)", async () => {
    const companyId = await createCompany();
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-external-scanned-skill-"));
    cleanupDirs.add(externalDir);
    await fs.writeFile(path.join(externalDir, "SKILL.md"), "# Original Scanned", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `project/project-1/board-external-skill`,
      slug: "board-external-skill",
      name: "Board External Skill",
      markdown: "# Original Scanned",
      sourceType: "local_path",
      sourceLocator: externalDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "project_scan", projectName: "Project", workspaceName: "ws" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const boardActor = { type: "user" as const, userId: "board-user" };
    const result = await svc.updateFile(companyId, skillId, "SKILL.md", "# Board Edited Content", boardActor);
    expect(result).toMatchObject({
      path: "SKILL.md",
      content: "# Board Edited Content",
    });

    const updatedFile = await fs.readFile(path.join(externalDir, "SKILL.md"), "utf8");
    expect(updatedFile).toBe("# Board Edited Content");
  });
});
