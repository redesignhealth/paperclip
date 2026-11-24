import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, companySkills, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";
import { SHARED_SKILLS_SOURCE_KIND } from "../services/shared-skills-source.js";
import { HttpError } from "../errors.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("company skill agent authoring and edit guards", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-skill-authoring-");
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-skill-home-"));
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
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
      metadata: { sourceKind: SHARED_SKILLS_SOURCE_KIND },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const agentActor = { type: "agent" as const, agentId: randomUUID() };
    const err = await svc.updateFile(companyId, skillId, "SKILL.md", "# Edited Content", agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.message).toBe("Shared skills are managed centrally and are read-only. Fork this skill to edit your own copy.");
    expect(err.details).toMatchObject({ code: "shared_skill_read_only", skillId });
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
    cleanupDirs.add(managedRoot);
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

  it("denies agent DELETE file on unmanaged/project-scanned local_path skill", async () => {
    const companyId = await createCompany();
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-scanned-skill-del-"));
    cleanupDirs.add(externalDir);
    await fs.writeFile(path.join(externalDir, "SKILL.md"), "# External Skill", "utf8");
    await fs.mkdir(path.join(externalDir, "references"), { recursive: true });
    await fs.writeFile(path.join(externalDir, "references", "guide.md"), "# Guide", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `project/project-1/external-skill-del`,
      slug: "external-skill-del",
      name: "External Skill Del",
      markdown: "# External Skill",
      sourceType: "local_path",
      sourceLocator: externalDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "project_scan", projectName: "Project", workspaceName: "ws" },
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "references/guide.md", kind: "reference" },
      ],
    });

    const agentActor = { type: "agent" as const, agentId: randomUUID() };
    const err = await svc.deleteFile(companyId, skillId, { path: "references/guide.md" }, agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("Agents can only delete files from managed local skills");
    expect(err.details).toMatchObject({ code: "skill_agent_delete_restricted" });
  });

  it("denies agent DELETE file on shared skill with 422 shared_skill_read_only", async () => {
    const companyId = await createCompany();
    const sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-skill-del-"));
    cleanupDirs.add(sharedDir);
    await fs.writeFile(path.join(sharedDir, "SKILL.md"), "# Shared Skill", "utf8");
    await fs.mkdir(path.join(sharedDir, "references"), { recursive: true });
    await fs.writeFile(path.join(sharedDir, "references", "guide.md"), "# Guide", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `shared/shared-skill-del`,
      slug: "shared-skill-del",
      name: "Shared Skill Del",
      markdown: "# Shared Skill",
      sourceType: "local_path",
      sourceLocator: sharedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: SHARED_SKILLS_SOURCE_KIND },
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "references/guide.md", kind: "reference" },
      ],
    });

    const agentActor = { type: "agent" as const, agentId: randomUUID() };
    const err = await svc.deleteFile(companyId, skillId, { path: "references/guide.md" }, agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.details).toMatchObject({ code: "shared_skill_read_only", skillId });
  });

  it("allows agent DELETE file on managed_local skill", async () => {
    const companyId = await createCompany();
    const managedRoot = path.join(home, "instances", "default", "skills", companyId);
    cleanupDirs.add(managedRoot);
    const managedDir = path.join(managedRoot, "agent-managed-skill-del-file");
    await fs.mkdir(path.join(managedDir, "references"), { recursive: true });
    cleanupDirs.add(managedDir);
    await fs.writeFile(path.join(managedDir, "SKILL.md"), "# Skill Content", "utf8");
    await fs.writeFile(path.join(managedDir, "references", "guide.md"), "# Guide Content", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/agent-managed-skill-del-file`,
      slug: "agent-managed-skill-del-file",
      name: "Managed Skill",
      markdown: "# Skill Content",
      sourceType: "local_path",
      sourceLocator: managedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "managed_local" },
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "references/guide.md", kind: "reference" },
      ],
    });

    const agentId = await createAgent(companyId);
    const agentActor = { type: "agent" as const, agentId };
    const result = await svc.deleteFile(companyId, skillId, { path: "references/guide.md" }, agentActor);
    expect(result).toMatchObject({
      path: "references/guide.md",
      deletedPaths: ["references/guide.md"],
    });

    const fileExists = await fs.stat(path.join(managedDir, "references", "guide.md")).then(() => true).catch(() => false);
    expect(fileExists).toBe(false);
  });

  it("denies agent DELETE skill on unmanaged/project-scanned skill", async () => {
    const companyId = await createCompany();
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-scanned-skill-del-skill-"));
    cleanupDirs.add(externalDir);
    await fs.writeFile(path.join(externalDir, "SKILL.md"), "# External Skill", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `project/project-1/external-skill-del-skill`,
      slug: "external-skill-del-skill",
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
    const err = await svc.deleteSkill(companyId, skillId, agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("Agents can only delete managed local skills");
    expect(err.details).toMatchObject({ code: "skill_agent_delete_restricted" });
  });

  it("denies agent DELETE skill on shared skill with 422 shared_skill_read_only", async () => {
    const companyId = await createCompany();
    const sharedDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-skill-del-skill-"));
    cleanupDirs.add(sharedDir);
    await fs.writeFile(path.join(sharedDir, "SKILL.md"), "# Shared Skill", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `shared/shared-skill-del-skill`,
      slug: "shared-skill-del-skill",
      name: "Shared Skill",
      markdown: "# Shared Skill",
      sourceType: "local_path",
      sourceLocator: sharedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: SHARED_SKILLS_SOURCE_KIND },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const agentActor = { type: "agent" as const, agentId: randomUUID() };
    const err = await svc.deleteSkill(companyId, skillId, agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.details).toMatchObject({ code: "shared_skill_read_only", skillId });
  });

  it("denies DELETE skill while attached to an agent with 422", async () => {
    const companyId = await createCompany();
    const managedRoot = path.join(home, "instances", "default", "skills", companyId);
    cleanupDirs.add(managedRoot);
    const managedDir = path.join(managedRoot, "agent-managed-skill-in-use");
    await fs.mkdir(managedDir, { recursive: true });
    cleanupDirs.add(managedDir);
    await fs.writeFile(path.join(managedDir, "SKILL.md"), "# Skill In Use", "utf8");

    const skillId = randomUUID();
    const skillKey = `company/${companyId}/agent-managed-skill-in-use`;
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: skillKey,
      slug: "agent-managed-skill-in-use",
      name: "In Use Skill",
      markdown: "# Skill In Use",
      sourceType: "local_path",
      sourceLocator: managedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "managed_local" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const usingAgentId = randomUUID();
    await db.insert(agents).values({
      id: usingAgentId,
      companyId,
      name: "Using Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [skillKey] } },
      status: "idle",
    });

    const agentActor = { type: "agent" as const, agentId: usingAgentId };
    const err = await svc.deleteSkill(companyId, skillId, agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("while it is still used by Using Agent");
  });

  it("allows agent DELETE skill on managed_local skill when unused", async () => {
    const companyId = await createCompany();
    const managedRoot = path.join(home, "instances", "default", "skills", companyId);
    cleanupDirs.add(managedRoot);
    const managedDir = path.join(managedRoot, "agent-managed-skill-del-skill");
    await fs.mkdir(managedDir, { recursive: true });
    cleanupDirs.add(managedDir);
    await fs.writeFile(path.join(managedDir, "SKILL.md"), "# Skill To Delete", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/agent-managed-skill-del-skill`,
      slug: "agent-managed-skill-del-skill",
      name: "To Delete Skill",
      markdown: "# Skill To Delete",
      sourceType: "local_path",
      sourceLocator: managedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "managed_local" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const agentId = await createAgent(companyId);
    const agentActor = { type: "agent" as const, agentId };
    const result = await svc.deleteSkill(companyId, skillId, agentActor);
    expect(result).toMatchObject({ id: skillId });

    const remaining = await db.select().from(companySkills).where(eq(companySkills.id, skillId));
    expect(remaining).toHaveLength(0);
  });

  it("allows board user DELETE skill on unmanaged/project-scanned skill", async () => {
    const companyId = await createCompany();
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-external-scanned-skill-del-"));
    cleanupDirs.add(externalDir);
    await fs.writeFile(path.join(externalDir, "SKILL.md"), "# Board External Skill", "utf8");

    const skillId = randomUUID();
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `project/project-1/board-external-skill-del`,
      slug: "board-external-skill-del",
      name: "Board External Skill",
      markdown: "# Board External Skill",
      sourceType: "local_path",
      sourceLocator: externalDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "project_scan", projectName: "Project", workspaceName: "ws" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const boardActor = { type: "user" as const, userId: "board-user" };
    const result = await svc.deleteSkill(companyId, skillId, boardActor);
    expect(result).toMatchObject({ id: skillId });
  });

  it("denies agent fork with reassignAgentIds containing a peer agent without agents:configure and causes no mutation", async () => {
    const companyId = await createCompany();
    const managedRoot = path.join(home, "instances", "default", "skills", companyId);
    cleanupDirs.add(managedRoot);
    const managedDir = path.join(managedRoot, "source-skill-to-fork");
    await fs.mkdir(managedDir, { recursive: true });
    cleanupDirs.add(managedDir);
    await fs.writeFile(path.join(managedDir, "SKILL.md"), "---\nname: Source Skill\n---\n# Source Skill", "utf8");

    const skillId = randomUUID();
    const skillKey = `company/${companyId}/source-skill-to-fork`;
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: skillKey,
      slug: "source-skill-to-fork",
      name: "Source Skill",
      markdown: "---\nname: Source Skill\n---\n# Source Skill",
      sourceType: "local_path",
      sourceLocator: managedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "managed_local" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const callingAgentId = await createAgent(companyId);
    const peerAgentId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "Peer Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [skillKey] } },
      status: "idle",
    });

    const agentActor = { type: "agent" as const, agentId: callingAgentId };
    const err = await svc.forkSkill(companyId, skillId, { reassignAgentIds: [peerAgentId] }, agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.details).toMatchObject({ code: "skill_agent_reassign_restricted" });

    // Assert NO mutation occurred: no forked skill created
    const forkedSkills = await db.select().from(companySkills).where(and(eq(companySkills.companyId, companyId), eq(companySkills.forkedFromSkillId, skillId)));
    expect(forkedSkills).toHaveLength(0);
  });

  it("allows agent fork with only self in reassignAgentIds", async () => {
    const companyId = await createCompany();
    const managedRoot = path.join(home, "instances", "default", "skills", companyId);
    cleanupDirs.add(managedRoot);
    const managedDir = path.join(managedRoot, "source-skill-self-fork");
    await fs.mkdir(managedDir, { recursive: true });
    cleanupDirs.add(managedDir);
    await fs.writeFile(path.join(managedDir, "SKILL.md"), "---\nname: Self Fork Source\n---\n# Self Fork Source", "utf8");

    const skillId = randomUUID();
    const skillKey = `company/${companyId}/source-skill-self-fork`;
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: skillKey,
      slug: "source-skill-self-fork",
      name: "Self Fork Source",
      markdown: "---\nname: Self Fork Source\n---\n# Self Fork Source",
      sourceType: "local_path",
      sourceLocator: managedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "managed_local" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const callingAgentId = randomUUID();
    await db.insert(agents).values({
      id: callingAgentId,
      companyId,
      name: "Self Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [skillKey] } },
      status: "idle",
    });

    const agentActor = { type: "agent" as const, agentId: callingAgentId };
    const result = await svc.forkSkill(companyId, skillId, { reassignAgentIds: [callingAgentId] }, agentActor);
    expect(result).toMatchObject({
      reassignments: [
        {
          agentId: callingAgentId,
          previousSkillKey: skillKey,
        },
      ],
    });
  });

  it("denies agent rename of a managed_local skill used by a peer agent without agents:configure and causes no mutation", async () => {
    const companyId = await createCompany();
    const managedRoot = path.join(home, "instances", "default", "skills", companyId);
    cleanupDirs.add(managedRoot);
    const managedDir = path.join(managedRoot, "peer-used-skill");
    await fs.mkdir(managedDir, { recursive: true });
    cleanupDirs.add(managedDir);
    await fs.writeFile(path.join(managedDir, "SKILL.md"), "---\nname: Peer Used Skill\n---\n# Peer Used Skill", "utf8");

    const skillId = randomUUID();
    const skillKey = `company/${companyId}/peer-used-skill`;
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: skillKey,
      slug: "peer-used-skill",
      name: "Peer Used Skill",
      markdown: "---\nname: Peer Used Skill\n---\n# Peer Used Skill",
      sourceType: "local_path",
      sourceLocator: managedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "managed_local" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const callingAgentId = await createAgent(companyId);
    const peerAgentId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "Peer Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [skillKey] } },
      status: "idle",
    });

    const agentActor = { type: "agent" as const, agentId: callingAgentId };
    const err = await svc.renameSkill(companyId, skillId, { name: "Renamed Peer Skill" }, agentActor).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.details).toMatchObject({ code: "skill_agent_reassign_restricted" });

    // Assert NO mutation occurred: skill in DB keeps original name and slug
    const [row] = await db.select().from(companySkills).where(eq(companySkills.id, skillId));
    expect(row!.name).toBe("Peer Used Skill");
    expect(row!.slug).toBe("peer-used-skill");
    expect(row!.key).toBe(skillKey);
  });

  it("allows board user rename of a managed_local skill used by a peer agent", async () => {
    const companyId = await createCompany();
    const managedRoot = path.join(home, "instances", "default", "skills", companyId);
    cleanupDirs.add(managedRoot);
    const managedDir = path.join(managedRoot, "board-renamed-skill");
    await fs.mkdir(managedDir, { recursive: true });
    cleanupDirs.add(managedDir);
    await fs.writeFile(path.join(managedDir, "SKILL.md"), "---\nname: Board Renamed Skill\n---\n# Board Renamed Skill", "utf8");

    const skillId = randomUUID();
    const skillKey = `company/${companyId}/board-renamed-skill`;
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: skillKey,
      slug: "board-renamed-skill",
      name: "Board Renamed Skill",
      markdown: "---\nname: Board Renamed Skill\n---\n# Board Renamed Skill",
      sourceType: "local_path",
      sourceLocator: managedDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      metadata: { sourceKind: "managed_local" },
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });

    const peerAgentId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "Peer Agent",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [skillKey] } },
      status: "idle",
    });

    const boardActor = { type: "user" as const, userId: "board-user" };
    const result = await svc.renameSkill(companyId, skillId, { name: "New Name For Skill" }, boardActor);
    expect(result).toMatchObject({
      previousName: "Board Renamed Skill",
      skill: expect.objectContaining({ name: "New Name For Skill" }),
    });
  });
});
