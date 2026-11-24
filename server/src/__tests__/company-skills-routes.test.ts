import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockCaptureRunIdentity = vi.hoisted(() => vi.fn());

const mockSkillSourceService = vi.hoisted(() => ({ sourceForSkill: vi.fn(), importFromUrl: vi.fn(), discover: vi.fn(), branches: vi.fn() }));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  list: vi.fn(),
  categoryCounts: vi.fn(),
  detail: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  createVersion: vi.fn(),
  starSkill: vi.fn(),
  unstarSkill: vi.fn(),
  forkSkill: vi.fn(),
  renameSkill: vi.fn(),
  forkPrecheck: vi.fn(),
  listComments: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  importFromSource: vi.fn(),
  installFromCatalog: vi.fn(),
  createLocalSkill: vi.fn(),
  updateSkill: vi.fn(),
  updateFile: vi.fn(),
  deleteFile: vi.fn(),
  browseProjectWorkspace: vi.fn(),
  scanProjectWorkspaces: vi.fn(),
  deleteSkill: vi.fn(),
  auditSkill: vi.fn(),
  getById: vi.fn(),
  installUpdate: vi.fn(),
  resetSkill: vi.fn(),
  listTestInputs: vi.fn(),
  createTestInput: vi.fn(),
  updateTestInput: vi.fn(),
  deleteTestInput: vi.fn(),
  listTestRunTemplates: vi.fn(),
  createTestRunTemplate: vi.fn(),
  updateTestRunTemplate: vi.fn(),
  deleteTestRunTemplate: vi.fn(),
  createTestRun: vi.fn(),
  listTestRuns: vi.fn(),
  getTestRunDetail: vi.fn(),
  cancelTestRun: vi.fn(),
  deleteTestRun: vi.fn(),
  pruneExpiredTestHarnessIssues: vi.fn(),
}));

const mockCompanySkillPolicyService = vi.hoisted(() => ({
  resolveAgentPrincipal: vi.fn(),
  evaluate: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockCatalogService = vi.hoisted(() => ({
  listCatalogSkillsOrEmpty: vi.fn(),
  getCatalogSkillOrThrow: vi.fn(),
  readCatalogSkillFile: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  listByIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackSkillImported = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockReflectionCoachMutationGate = vi.hoisted(() => ({
  assertConsented: vi.fn(),
}));

function allowSkillChangeDecision(reason = "allow_direct_change") {
  return {
    allowed: true,
    action: "skill_config:update",
    reason,
    explanation: "Allowed.",
    grant: {
      principalType: "agent",
      principalId: "agent-1",
      permissionKey: reason === "allow_consented_change" ? "skills:suggest-changes" : "skills:create",
      scope: null,
    },
  };
}

function denySkillChangeDecision(reason = "deny_no_grant", explanation = "Missing permission: skills:create or skills:suggest-changes.") {
  return {
    allowed: false,
    action: "skill_config:update",
    reason,
    explanation,
  };
}

function denyTaskAssignDecision(reason = "deny_missing_grant", explanation = "Missing permission: tasks:assign") {
  return {
    allowed: false,
    action: "tasks:assign",
    reason,
    explanation,
  };
}

function denySkillPolicy(action = "skills.import") {
  return {
    allowed: false,
    action,
    reason: "explicit_rule",
    policyRevision: 1,
    matchedRuleId: "deny-skill-mutation",
    remediation: "Contact a company administrator to change the skill policy.",
  };
}

function registerModuleMocks() {
  vi.doMock("../services/run-identity.js", async () => ({
    ...await vi.importActual<typeof import("../services/run-identity.js")>("../services/run-identity.js"),
    captureRunIdentity: mockCaptureRunIdentity,
  }));
  vi.doMock("../services/skill-sources.js", () => ({ skillSourceService: () => mockSkillSourceService }));
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackSkillImported: mockTrackSkillImported,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    persistActivity: vi.fn(),
    publishActivity: vi.fn(),
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  // This route-contract harness supplies no database. Private-source decisions
  // are exercised with the real database in project-skill-sources.test.ts.
  vi.doMock("../services/skill-access.js", async () => {
    const actual = await vi.importActual<typeof import("../services/skill-access.js")>("../services/skill-access.js");
    return { ...actual, skillAccessService: (db: Parameters<typeof actual.skillAccessService>[0]) => ({
      ...actual.skillAccessService(db), assertSource: async () => {},
    }) };
  });

  vi.doMock("../services/company-skills.js", async () => {
    const actual = await vi.importActual<typeof import("../services/company-skills.js")>(
      "../services/company-skills.js",
    );
    return {
      ...actual,
      companySkillService: () => mockCompanySkillService,
    };
  });

  vi.doMock("../services/company-skill-policy.js", async () => {
    const actual = await vi.importActual<typeof import("../services/company-skill-policy.js")>(
      "../services/company-skill-policy.js",
    );
    return {
      ...actual,
      companySkillPolicyService: () => mockCompanySkillPolicyService,
    };
  });

  vi.doMock("../services/skills-catalog.js", () => mockCatalogService);

  vi.doMock("../services/change-consent-gate.js", async () => {
    const actual = await vi.importActual<typeof import("../services/change-consent-gate.js")>(
      "../services/change-consent-gate.js",
    );
    return {
      ...actual,
      changeConsentGateService: () => mockReflectionCoachMutationGate,
    };
  });

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companySkillService: () => mockCompanySkillService,
    issueService: () => mockIssueService,
    heartbeatService: () => mockHeartbeatService,
    projectService: () => mockProjectService,
    logActivity: mockLogActivity,
  }));
}

function boardActor(userId = "local-board", source = "local_implicit") {
  return {
    type: "board",
    userId: userId,
    companyIds: ["company-1"],
    source: source,
    isInstanceAdmin: false,
  };
}

function assignedAgentActor() {
  return {
    type: "agent",
    agentId: "55555555-5555-4555-8555-555555555555",
    companyId: "company-1",
    runId: "run-1",
  };
}

function createCatalogSkill() {
  return {
    id: "paperclipai:bundled:software-development:review",
    key: "paperclipai/bundled/software-development/review",
    kind: "bundled",
    category: "software-development",
    slug: "review",
    name: "review",
    description: "Review code",
    path: "catalog/bundled/software-development/review",
    entrypoint: "SKILL.md",
    trustLevel: "markdown_only",
    compatibility: "compatible",
    defaultInstall: false,
    recommendedForRoles: ["engineer"],
    requires: [],
    tags: ["review"],
    files: [{ path: "SKILL.md", kind: "skill", sizeBytes: 8, sha256: "abc" }],
    contentHash: "sha256:abc",
  };
}

function createSkillTestRunDetails(overrides: Record<string, unknown> = {}) {
  return {
  id: "22222222-2222-4222-8222-222222222222",
  companyId: "company-1",
  skillId: "skill-1",
  inputId: "11111111-1111-4111-8111-111111111111",
  inputSnapshot: "Try the skill",
  skillVersionId: "33333333-3333-4333-8333-333333333333",
  agentId: "55555555-5555-4555-8555-555555555555",
  agentConfigSnapshot: { adapterType: "codex_local" },
  issueId: "44444444-4444-4444-8444-444444444444",
  templateId: "built-in:default-test-template",
  templateName: "Default test template",
  templateBody: "Default {{skillName}}",
  renderedTemplateBody: "Default Review",
  harnessIssueDescription: "Try the skill\n\n---\n\nDefault Review",
  status: "queued",
  outputDocumentKey: "output",
  outputSnapshot: "",
  error: null,
  deletedAt: null,
  supersededAt: null,
  harnessIssueExpiresAt: null,
  harnessIssueDeletedAt: null,
    ...overrides,
  };
}

describe("company skill mutation permissions", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ companySkillRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/company-skills.js")>("../routes/company-skills.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { companySkillRoutes, errorHandler };
  });

  function createApp(
    actor: Record<string, unknown>,
    onResponse?: (res: express.Response) => void,
    dbOverride?: any,
  ) {
    const { companySkillRoutes, errorHandler } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      (req as any).actor = actor;
      onResponse?.(res);
      next();
    });
    app.use("/api", companySkillRoutes(dbOverride ?? ({} as any)));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureRunIdentity.mockResolvedValue({ run: { responsibleUserId: "validated-owner" } });
    mockSkillSourceService.sourceForSkill.mockResolvedValue(null);
    mockSkillSourceService.importFromUrl.mockImplementation((companyId, source) => mockCompanySkillService.importFromSource(companyId, source));
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [],
      warnings: [],
    });
    mockProjectService.list.mockResolvedValue([]);
    mockProjectService.listByIds.mockResolvedValue([]);
    mockCompanySkillService.browseProjectWorkspace.mockResolvedValue({
      projectId: "p-1",
      workspaceId: "w-1",
      workspaceName: "ws",
      path: ".",
      parentPath: null,
      entries: [],
      truncated: false,
    });
    mockCompanySkillService.scanProjectWorkspaces.mockResolvedValue({
      scannedProjects: 0,
      scannedWorkspaces: 0,
      discovered: 0,
      imported: [],
      updated: [],
      skipped: [],
      conflicts: [],
      candidates: [],
      warnings: [],
    });
    mockCatalogService.listCatalogSkillsOrEmpty.mockReturnValue([]);
    mockCompanySkillService.list.mockResolvedValue([]);
    mockCompanySkillService.categoryCounts.mockResolvedValue([]);
    mockCompanySkillService.detail.mockResolvedValue(null);
    mockCompanySkillService.listVersions.mockResolvedValue([]);
    mockCompanySkillService.getVersion.mockResolvedValue(null);
    mockCompanySkillService.createVersion.mockResolvedValue({
      id: "version-1",
      companyId: "company-1",
      companySkillId: "skill-1",
      revisionNumber: 1,
      label: "v1",
      fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# Skill" }],
      authorAgentId: null,
      authorUserId: "board",
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.starSkill.mockResolvedValue({
      skillId: "skill-1",
      starred: true,
      starCount: 1,
    });
    mockCompanySkillService.unstarSkill.mockResolvedValue({
      skillId: "skill-1",
      starred: false,
      starCount: 0,
    });
    const forkedSkill = {
      id: "skill-fork",
      companyId: "company-1",
      key: "company/company-1/review-fork",
      slug: "review-fork",
      name: "Review Fork",
      description: null,
      markdown: "# Review",
      sourceType: "local_path",
      sourceLocator: "/tmp/review-fork",
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      iconUrl: null,
      color: null,
      tagline: null,
      authorName: null,
      homepageUrl: null,
      categories: [],
      sharingScope: "company",
      publicShareToken: null,
      forkedFromSkillId: "skill-1",
      forkedFromCompanyId: "company-1",
      starCount: 0,
      installCount: 1,
      forkCount: 0,
      currentVersionId: null,
      metadata: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    };
    mockCompanySkillService.forkSkill.mockResolvedValue({
      skill: forkedSkill,
      original: {
        id: "skill-1",
        name: "Review",
        slug: "review",
        sourceType: "github",
        sourceLocator: "https://github.com/acme/review",
        sourceRef: "abc123",
      },
      reassignments: [],
    });
    mockCompanySkillService.renameSkill.mockResolvedValue({
      skill: { ...forkedSkill, id: "skill-1", name: "Ship PR", slug: "ship-pr", key: "company/company-1/ship-pr" },
      previousName: "Review",
      previousSlug: "review",
      previousKey: "company/company-1/review",
      reassignments: [
        { agentId: "11111111-1111-4111-8111-111111111111", previousSkillKey: "company/company-1/review", nextSkillKey: "company/company-1/ship-pr" },
      ],
    });
    mockCompanySkillService.forkPrecheck.mockResolvedValue({
      skillId: "skill-1",
      original: {
        id: "skill-1",
        name: "Review",
        slug: "review",
        sourceType: "github",
        sourceLocator: "https://github.com/acme/review",
        sourceRef: "abc123",
      },
      agentUsageCount: 0,
      usedByAgents: [],
      existingForks: [],
    });
    mockCompanySkillService.listComments.mockResolvedValue([]);
    mockCompanySkillService.createComment.mockResolvedValue({
      id: "comment-1",
      companyId: "company-1",
      companySkillId: "skill-1",
      parentCommentId: null,
      authorAgentId: null,
      authorUserId: "board",
      body: "Looks good",
      deletedAt: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.updateComment.mockResolvedValue({
      id: "comment-1",
      companyId: "company-1",
      companySkillId: "skill-1",
      parentCommentId: null,
      authorAgentId: null,
      authorUserId: "board",
      body: "Updated",
      deletedAt: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.deleteComment.mockResolvedValue({
      id: "comment-1",
      companyId: "company-1",
      companySkillId: "skill-1",
      parentCommentId: null,
      authorAgentId: null,
      authorUserId: "board",
      body: "Updated",
      deletedAt: new Date("2026-05-26T00:01:00.000Z"),
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:01:00.000Z"),
    });
    mockCompanySkillService.installFromCatalog.mockResolvedValue({
      action: "created",
      skill: {
        id: "skill-1",
        companyId: "company-1",
        key: "paperclipai/bundled/software-development/review",
        slug: "review",
        name: "review",
        description: "Review code",
        markdown: "# Review",
        sourceType: "catalog",
        sourceLocator: "/tmp/review",
        sourceRef: "sha256:abc",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {
          sourceKind: "catalog",
          catalogId: "paperclipai:bundled:software-development:review",
          originHash: "sha256:abc",
        },
        createdAt: new Date("2026-05-26T00:00:00.000Z"),
        updatedAt: new Date("2026-05-26T00:00:00.000Z"),
      },
      catalogSkill: createCatalogSkill(),
      warnings: [],
    });
    mockCompanySkillService.createLocalSkill.mockResolvedValue({
      id: "skill-1",
      companyId: "company-1",
      key: "company/company-1/review",
      slug: "review",
      name: "Review",
      description: null,
      markdown: "# Review",
      sourceType: "local_path",
      sourceLocator: "/tmp/review",
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      iconUrl: null,
      color: null,
      tagline: null,
      authorName: null,
      homepageUrl: null,
      categories: [],
      sharingScope: "company",
      publicShareToken: null,
      forkedFromSkillId: null,
      forkedFromCompanyId: null,
      starCount: 0,
      installCount: 1,
      forkCount: 0,
      currentVersionId: null,
      metadata: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.updateSkill.mockResolvedValue({
      id: "skill-1",
      slug: "review",
      categories: ["memory", "review"],
      sharingScope: "company",
    });
    mockCompanySkillService.updateFile.mockResolvedValue({
      skillId: "skill-1",
      path: "SKILL.md",
      kind: "skill",
      content: "# Review",
      language: "markdown",
      markdown: true,
      editable: true,
    });
    mockCompanySkillService.deleteFile.mockResolvedValue({
      skillId: "skill-1",
      path: "references",
      target: "folder",
      deletedPaths: ["references/example.md"],
    });
    mockCompanySkillService.scanProjectWorkspaces.mockResolvedValue({
      scannedProjects: 0,
      scannedWorkspaces: 0,
      discovered: 0,
      imported: [],
      updated: [],
      skipped: [],
      conflicts: [],
      candidates: [],
      warnings: [],
    });
    mockCompanySkillService.deleteSkill.mockResolvedValue({
      id: "skill-1",
      slug: "find-skills",
      name: "Find Skills",
    });
    mockCompanySkillService.auditSkill.mockResolvedValue({
      skillId: "skill-1",
      installedHash: "sha256:abc",
      originHash: "sha256:abc",
      verdict: "pass",
      codes: [],
      findings: [],
      scannedAt: "2026-05-26T00:00:00.000Z",
      scanVersion: "1",
    });
    mockCompanySkillService.getById.mockResolvedValue({
      id: "skill-1",
      slug: "review",
      sourceRef: "sha256:abc",
      metadata: { originHash: "sha256:abc" },
    });
    mockCompanySkillService.installUpdate.mockResolvedValue({
      id: "skill-1",
      slug: "review",
      sourceRef: "sha256:def",
      metadata: { originHash: "sha256:def" },
    });
    mockCompanySkillService.resetSkill.mockResolvedValue({
      id: "skill-1",
      slug: "review",
      sourceRef: "sha256:def",
      metadata: { originHash: "sha256:def" },
    });
    mockCompanySkillService.pruneExpiredTestHarnessIssues.mockResolvedValue({ pruned: 0 });
    mockCompanySkillService.listTestInputs.mockResolvedValue([]);
    mockCompanySkillService.createTestInput.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      skillId: "skill-1",
      name: "smoke/input",
      content: "Try the skill",
      createdBy: "board",
      deletedAt: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    });
    mockCompanySkillService.updateTestInput.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      skillId: "skill-1",
      name: "smoke/renamed",
      content: "Try the skill again",
      createdBy: "board",
      deletedAt: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:01:00.000Z"),
    });
    mockCompanySkillService.deleteTestInput.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      skillId: "skill-1",
      name: "smoke/renamed",
      content: "Try the skill again",
      createdBy: "board",
      deletedAt: new Date("2026-05-26T00:02:00.000Z"),
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:02:00.000Z"),
    });
    const templateResponse = {
      id: "66666666-6666-4666-8666-666666666666",
      companyId: "company-1",
      name: "Custom template",
      description: "Custom run guidance",
      body: "Run {{skillName}} into {{outputDocumentKey}}.",
      builtIn: false,
      createdByAgentId: null,
      createdByUserId: "local-board",
      updatedByAgentId: null,
      updatedByUserId: "local-board",
      deletedAt: null,
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
    };
    mockCompanySkillService.listTestRunTemplates.mockResolvedValue([{
      ...templateResponse,
      id: "built-in:default-test-template",
      name: "Default test template",
      description: "Paperclip default",
      body: "Default {{skillName}}",
      builtIn: true,
      createdByUserId: null,
      updatedByUserId: null,
    }, templateResponse]);
    mockCompanySkillService.createTestRunTemplate.mockResolvedValue(templateResponse);
    mockCompanySkillService.updateTestRunTemplate.mockResolvedValue({
      ...templateResponse,
      name: "Renamed template",
      updatedAt: new Date("2026-05-26T00:01:00.000Z"),
    });
    mockCompanySkillService.deleteTestRunTemplate.mockResolvedValue({
      ...templateResponse,
      deletedAt: new Date("2026-05-26T00:02:00.000Z"),
      updatedAt: new Date("2026-05-26T00:02:00.000Z"),
    });
    mockCompanySkillService.listTestRuns.mockResolvedValue([]);
    mockCompanySkillService.getTestRunDetail.mockResolvedValue(null);
    mockCompanySkillService.createTestRun.mockResolvedValue({
      ...createSkillTestRunDetails(),
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:00:00.000Z"),
      cost: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      taskExpired: false,
    });
    mockCompanySkillService.cancelTestRun.mockResolvedValue({
      ...createSkillTestRunDetails({ status: "cancelled", error: "Cancelled by operator" }),
      createdAt: new Date("2026-05-26T00:00:00.000Z"),
      updatedAt: new Date("2026-05-26T00:01:00.000Z"),
      cost: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      taskExpired: false,
    });
    mockIssueService.create.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-1",
      identifier: "PAP-999",
      title: "Skill test: Review",
    });
    mockIssueService.getById.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-1",
      status: "in_progress",
      executionRunId: "run-1",
    });
    mockIssueService.update.mockResolvedValue({});
    mockHeartbeatService.wakeup.mockResolvedValue({});
    mockHeartbeatService.cancelRun.mockResolvedValue({});
    mockCatalogService.listCatalogSkillsOrEmpty.mockReturnValue([]);
    mockCatalogService.getCatalogSkillOrThrow.mockReturnValue(createCatalogSkill());
    mockCatalogService.readCatalogSkillFile.mockResolvedValue({
      catalogSkillId: "paperclipai:bundled:software-development:review",
      path: "SKILL.md",
      kind: "skill",
      content: "# Review",
      language: "markdown",
      markdown: true,
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue(allowSkillChangeDecision());
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockCompanySkillPolicyService.resolveAgentPrincipal.mockImplementation(async (_companyId, agentId) => ({
      type: "agent",
      id: agentId,
      role: "engineer",
    }));
    mockCompanySkillPolicyService.evaluate.mockImplementation(async (input) => ({
      allowed: true,
      action: input.action,
      reason: "no_policy_default",
      policyRevision: 0,
      matchedRuleId: null,
      remediation: null,
    }));
    mockReflectionCoachMutationGate.assertConsented.mockResolvedValue(undefined);
  });

  it("allows local board operators to mutate company skills", async () => {
    const res = await request(await createApp(boardActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toEqual({
      imported: [],
      warnings: [],
    });
  });

  it("forwards preview and selective scan-projects requests through the existing skill mutation gate", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    mockCompanySkillService.scanProjectWorkspaces.mockResolvedValue({
      scannedProjects: 1,
      scannedWorkspaces: 1,
      discovered: 1,
      imported: [],
      updated: [],
      skipped: [],
      conflicts: [],
      candidates: [{
        slug: "review",
        name: "Review",
        description: null,
        workspaceId,
        workspaceName: "Primary",
        projectId: "22222222-2222-4222-8222-222222222222",
        projectName: "Paperclip",
        directoryRoot: ".codex/skills",
        relativePath: ".codex/skills/review",
        status: "new",
      }],
      warnings: [],
    });
    const app = await createApp(boardActor());

    const preview = await request(app)
      .post("/api/companies/company-1/skills/scan-projects")
      .send({ mode: "preview", workspaceIds: [workspaceId] });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.candidates).toHaveLength(1);
    expect(mockCompanySkillService.scanProjectWorkspaces).toHaveBeenCalledWith("company-1", {
      mode: "preview",
      workspaceIds: [workspaceId],
    });

    const selective = await request(app)
      .post("/api/companies/company-1/skills/scan-projects")
      .send({
        mode: "import",
        workspaceIds: [workspaceId],
        selection: [{ workspaceId, path: ".codex/skills/review", slug: "review-project" }],
      });
    expect(selective.status, JSON.stringify(selective.body)).toBe(200);
    expect(mockCompanySkillService.scanProjectWorkspaces).toHaveBeenLastCalledWith("company-1", {
      mode: "import",
      workspaceIds: [workspaceId],
      selection: [{ workspaceId, path: ".codex/skills/review", slug: "review-project" }],
    });
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "skill_config:update",
      resource: { type: "company", companyId: "company-1" },
    }));
    expect(mockLogActivity).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skills_scanned",
      details: expect.objectContaining({ mode: "import", candidateCount: 1 }),
    }));
  });

  it("blocks unauthorized preview scan-projects requests before candidate data is returned", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision(
      "deny_actor_restricted",
      "Actor is restricted from changing skill configuration.",
    ));

    const res = await request(await createApp(boardActor("board-user", "session")))
      .post("/api/companies/company-1/skills/scan-projects")
      .send({ mode: "preview", workspaceIds: [workspaceId] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Actor is restricted from changing skill configuration.");
    expect(mockCompanySkillService.scanProjectWorkspaces).not.toHaveBeenCalled();
  });

  it("allows board users with skills:create to create, import, install, update, delete, audit, and reset company skills", async () => {
    const app = await createApp(boardActor("board-user", "session"));

    await request(app)
      .post("/api/companies/company-1/skills")
      .send({ name: "Review", slug: "review", markdown: "# Review" })
      .expect(201);
    await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" })
      .expect(201);
    await request(app)
      .post("/api/companies/company-1/skills/install-catalog")
      .send({ catalogSkillId: "paperclipai:bundled:software-development:review" })
      .expect(201);
    await request(app)
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ description: "Updated" })
      .expect(200);
    await request(app)
      .delete("/api/companies/company-1/skills/skill-1")
      .expect(200);
    await request(app)
      .post("/api/companies/company-1/skills/skill-1/audit")
      .send({})
      .expect(200);
    await request(app)
      .post("/api/companies/company-1/skills/skill-1/reset")
      .send({})
      .expect(200);

    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "skill_config:update",
      resource: { type: "company", companyId: "company-1" },
    }));
    expect(mockAccessService.canUser).not.toHaveBeenCalledWith("company-1", "board-user", "agents:create");
    expect(mockCompanySkillService.createLocalSkill).toHaveBeenCalled();
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalled();
    expect(mockCompanySkillService.installFromCatalog).toHaveBeenCalled();
    expect(mockCompanySkillService.updateSkill).toHaveBeenCalled();
    expect(mockCompanySkillService.deleteSkill).toHaveBeenCalled();
    expect(mockCompanySkillService.auditSkill).toHaveBeenCalled();
    expect(mockCompanySkillService.resetSkill).toHaveBeenCalled();
  });

  it("allows board users without skills:create when no explicit skill policy exists", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const res = await request(await createApp(boardActor("board-user", "session")))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "skill_config:update",
      resource: { type: "company", companyId: "company-1" },
    }));
    expect(mockAccessService.canUser).not.toHaveBeenCalledWith("company-1", "board-user", "agents:create");
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalled();
  });

  it("returns a structured denial when an explicit skill policy blocks the action", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockCompanySkillPolicyService.evaluate.mockResolvedValue({
      allowed: false,
      action: "skills.import",
      reason: "explicit_rule",
      policyRevision: 4,
      matchedRuleId: "deny-external",
      remediation: "Contact a company administrator to change the skill policy.",
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://packages.example.com/skill.tgz" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({
      error: "Skill action denied by company policy",
      code: "skill_policy_denied",
      reason: "explicit_rule",
      remediation: "Contact a company administrator to change the skill policy.",
    });
    expect(JSON.stringify(res.body)).not.toContain("deny-external");
    expect(JSON.stringify(res.body)).not.toContain("policyRevision");
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("rejects secret-bearing remote import URLs without echoing the secret", async () => {
    const source = "https://github.com/acme/private-skill?token=secret#token=secret";

    const res = await request(await createApp(boardActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: "Remote skill source URLs cannot include credentials, query parameters, or fragments.",
    });
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(mockCompanySkillPolicyService.evaluate).not.toHaveBeenCalled();
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("rejects malformed remote import URLs before policy evaluation", async () => {
    const res = await request(await createApp(boardActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: "Invalid remote skill source URL.",
    });
    expect(mockCompanySkillPolicyService.evaluate).not.toHaveBeenCalled();
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("keeps platform actor restrictions separate from optional policy denials", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision(
      "deny_low_trust_boundary",
      "Low-trust agents cannot use company-wide skill APIs.",
    ));

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      code: "skill_actor_restricted",
      details: { reason: "platform_invariant" },
    });
    expect(mockCompanySkillPolicyService.evaluate).not.toHaveBeenCalled();
  });

  it("blocks shorthand GitHub imports when policy denies the canonical git source locator", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockCompanySkillPolicyService.evaluate.mockImplementation(async (input: { resource?: { sourceType?: string; sourceLocator?: string } }) => {
      const resource = input.resource ?? {};
      return resource.sourceType === "git" && resource.sourceLocator === "https://github.com/vercel-labs/agent-browser"
        ? denySkillPolicy("skills.import")
        : {
          allowed: true,
          action: "skills.import",
          reason: "policy_default",
          policyRevision: 1,
          matchedRuleId: null,
          remediation: null,
        };
    });

    const res = await request(await createApp(boardActor("board-user", "session")))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Skill action denied by company policy");
    expect(mockCompanySkillPolicyService.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      action: "skills.import",
      resource: expect.objectContaining({
        sourceType: "git",
        sourceLocator: "https://github.com/vercel-labs/agent-browser",
      }),
    }));
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("normalizes stored GitHub locators before evaluating mutation policy", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockCompanySkillService.getById.mockResolvedValue({
      id: "skill-1",
      key: "company/company-1/review",
      sourceType: "github",
      sourceLocator: "https://WWW.GitHub.com/Acme/Review.git",
    });
    mockCompanySkillPolicyService.evaluate.mockImplementation(async (input: { resource?: { sourceLocator?: string } }) => (
      input.resource?.sourceLocator === "https://github.com/acme/review"
        ? denySkillPolicy("skills.edit")
        : {
          allowed: true,
          action: "skills.edit",
          reason: "policy_default",
          policyRevision: 1,
          matchedRuleId: null,
          remediation: null,
        }
    ));

    const res = await request(await createApp(boardActor("board-user", "session")))
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ name: "Updated review" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillPolicyService.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      action: "skills.edit",
      resource: expect.objectContaining({
        sourceType: "git",
        sourceLocator: "https://github.com/acme/review",
      }),
    }));
    expect(mockCompanySkillService.updateSkill).not.toHaveBeenCalled();
  });

  it("evaluates skill version creation with the skills.create policy action", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockCompanySkillService.getById.mockResolvedValue({
      id: "skill-1",
      key: "company/company-1/review",
      sourceType: "github",
      sourceLocator: "https://github.com/acme/review",
    });
    mockCompanySkillPolicyService.evaluate.mockResolvedValue(denySkillPolicy("skills.create"));

    const res = await request(await createApp(boardActor("board-user", "session")))
      .post("/api/companies/company-1/skills/skill-1/versions")
      .send({ label: "v1" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillPolicyService.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      action: "skills.create",
      companyId: "company-1",
      resource: expect.objectContaining({
        skillId: "skill-1",
      }),
    }));
    expect(mockCompanySkillService.createVersion).not.toHaveBeenCalled();
  });

  it("blocks npx skills add imports when policy denies the canonical git source locator", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockCompanySkillPolicyService.evaluate.mockImplementation(async (input: { resource?: { sourceType?: string; sourceLocator?: string } }) => {
      const resource = input.resource ?? {};
      return resource.sourceType === "git" && resource.sourceLocator === "https://github.com/vercel-labs/agent-browser"
        ? denySkillPolicy("skills.import")
        : {
          allowed: true,
          action: "skills.import",
          reason: "policy_default",
          policyRevision: 1,
          matchedRuleId: null,
          remediation: null,
        };
    });

    const res = await request(await createApp(boardActor("board-user", "session")))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "npx skills add Vercel-Labs/Agent-Browser --skill agent-browser -g" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Skill action denied by company policy");
    expect(mockCompanySkillPolicyService.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      action: "skills.import",
      resource: expect.objectContaining({
        sourceType: "git",
        sourceLocator: "https://github.com/vercel-labs/agent-browser",
      }),
    }));
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "tree directory",
      source: "https://github.com/Vercel-Labs/Agent-Browser/tree/main/skills/Upper.MD",
      sourceLocator: "https://github.com/vercel-labs/agent-browser/tree/main/skills/Upper.MD",
    },
    {
      label: "blob file",
      source: "https://github.com/Vercel-Labs/Agent-Browser/blob/main/skills/Upper/SKILL.MD",
      sourceLocator: "https://github.com/vercel-labs/agent-browser/blob/main/skills/Upper/SKILL.MD",
    },
  ])("blocks uppercase .MD GitHub $label imports when policy denies the canonical git source locator", async ({ source, sourceLocator }) => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockCompanySkillPolicyService.evaluate.mockImplementation(async (input: { resource?: { sourceType?: string; sourceLocator?: string } }) => {
      const resource = input.resource ?? {};
      return resource.sourceType === "git" && resource.sourceLocator === sourceLocator
        ? denySkillPolicy("skills.import")
        : {
          allowed: true,
          action: "skills.import",
          reason: "policy_default",
          policyRevision: 1,
          matchedRuleId: null,
          remediation: null,
        };
    });

    const res = await request(await createApp(boardActor("board-user", "session")))
      .post("/api/companies/company-1/skills/import")
      .send({ source });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Skill action denied by company policy");
    expect(mockCompanySkillPolicyService.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      action: "skills.import",
      resource: expect.objectContaining({
        sourceType: "git",
        sourceLocator,
      }),
    }));
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("serves catalog listing without mutating company skills", async () => {
    mockCatalogService.listCatalogSkillsOrEmpty.mockReturnValue([
      createCatalogSkill(),
    ]);

    const res = await request(await createApp(boardActor()))
      .get("/api/skills/catalog?kind=bundled&q=review");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCatalogService.listCatalogSkillsOrEmpty).toHaveBeenCalledWith({ kind: "bundled", q: "review" });
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
    expect(mockCompanySkillService.installFromCatalog).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("requires authentication for catalog read routes", async () => {
    const app = await createApp({ type: "none" });

    const list = await request(app).get("/api/skills/catalog");
    const detail = await request(app).get("/api/skills/catalog/review");
    const file = await request(app).get("/api/skills/catalog/review/files?path=SKILL.md");

    expect(list.status, JSON.stringify(list.body)).toBe(401);
    expect(detail.status, JSON.stringify(detail.body)).toBe(401);
    expect(file.status, JSON.stringify(file.body)).toBe(401);
    expect(mockCatalogService.listCatalogSkillsOrEmpty).not.toHaveBeenCalled();
    expect(mockCatalogService.getCatalogSkillOrThrow).not.toHaveBeenCalled();
    expect(mockCatalogService.readCatalogSkillFile).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated skill imports before parsing source details", async () => {
    const app = await createApp({ type: "none" });

    const res = await request(app)
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/acme/private-skill?token=secret#token=secret" });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(mockAccessService.decide).not.toHaveBeenCalled();
    expect(mockCompanySkillPolicyService.evaluate).not.toHaveBeenCalled();
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated skill edits before loading stored policy resources", async () => {
    const app = await createApp({ type: "none" });

    const res = await request(app)
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ description: "Updated" });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
    expect(mockCompanySkillService.getById).not.toHaveBeenCalled();
    expect(mockCompanySkillPolicyService.evaluate).not.toHaveBeenCalled();
    expect(mockCompanySkillService.updateSkill).not.toHaveBeenCalled();
  });

  it("serves catalog detail and files by catalog reference", async () => {
    const app = await createApp(boardActor());

    const detail = await request(app)
      .get("/api/skills/catalog/review");
    const file = await request(app)
      .get("/api/skills/catalog/review/files?path=SKILL.md");

    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expect(mockCatalogService.getCatalogSkillOrThrow).toHaveBeenCalledWith("review");
    expect(mockCatalogService.readCatalogSkillFile).toHaveBeenCalledWith("review", "SKILL.md");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("installs catalog skills with mutation permissions and logs provenance", async () => {
    const res = await request(await createApp(boardActor()))
      .post("/api/companies/company-1/skills/install-catalog")
      .send({
        catalogSkillId: "paperclipai:bundled:software-development:review",
        slug: "review",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.installFromCatalog).toHaveBeenCalledWith("company-1", {
      catalogSkillId: "paperclipai:bundled:software-development:review",
      slug: "review",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      action: "company.skill_catalog_installed",
      entityType: "company_skill",
      entityId: "skill-1",
      details: expect.objectContaining({
        catalogId: "paperclipai:bundled:software-development:review",
        catalogKey: "paperclipai/bundled/software-development/review",
        originHash: "sha256:abc",
      }),
    }));
  });

  it("tracks public GitHub skill imports with an explicit skill reference", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "vercel-labs/agent-browser/find-skills",
          slug: "find-skills",
          name: "Find Skills",
          description: null,
          markdown: "# Find Skills",
          sourceType: "github",
          sourceLocator: "https://github.com/vercel-labs/agent-browser",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            hostname: "github.com",
            owner: "vercel-labs",
            repo: "agent-browser",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp(boardActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: "vercel-labs/agent-browser/find-skills",
    });
  });

  it.each(["responsible-person", "local-board"])("does not persist API-key refresh authority from %s", async (onBehalfOfUserId) => {
    const agent = { ...assignedAgentActor(), source: "agent_key", runId: undefined, onBehalfOfUserId,
      onBehalfOfMemberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }] };
    const response = await request(createApp(agent)).post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/acme/public-skills" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(mockSkillSourceService.importFromUrl).toHaveBeenCalledWith("company-1", expect.anything(),
      expect.objectContaining({ setup: { userId: null, agentId: agent.agentId, localTrusted: false } }));
  });

  it("derives refresh authority from the authenticated run instead of caller responsibility", async () => {
    const agent = { ...assignedAgentActor(), source: "agent_jwt", onBehalfOfUserId: "unverified-person",
      onBehalfOfMemberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }] };
    const response = await request(createApp(agent)).post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/acme/public-skills" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(mockCaptureRunIdentity).toHaveBeenCalledWith(expect.anything(), { companyId: "company-1", agentId: agent.agentId, runId: "run-1" });
    expect(mockSkillSourceService.importFromUrl).toHaveBeenCalledWith("company-1", expect.anything(),
      expect.objectContaining({ setup: { userId: "validated-owner", agentId: agent.agentId, localTrusted: false } }));
  });

  it("rejects a run-authenticated import without a run identity", async () => {
    await request(createApp({ ...assignedAgentActor(), source: "agent_jwt", runId: undefined }))
      .post("/api/companies/company-1/skills/import").send({ source: "https://github.com/acme/public-skills" }).expect(403);
    expect(mockSkillSourceService.importFromUrl).not.toHaveBeenCalled();
  });

  it('streams discovery updates and a final result while retaining JSON compatibility', async () => {
    const result = { candidates: [], commitSha: 'a'.repeat(40) };
    mockSkillSourceService.discover.mockImplementation(async (_input, _context, options) => {
      await options?.onProgress({ type: 'progress', phase: 'listing', totalSkills: null, checkedSkills: 0, currentPath: null, checkedFiles: 0, totalFiles: null });
      return result;
    });
    const app = createApp({ type: 'board', userId: 'board', companyIds: ['company-1'], source: 'local_implicit' });
    const base = '/api/companies/company-1/skill-sources/discover';
    const stream = await request(app).post(base).set('Accept', 'application/x-ndjson').send({ repositoryUrl: 'https://github.com/acme/skills' }).expect(200);
    expect(stream.headers['content-type']).toContain('application/x-ndjson');
    expect(stream.headers['cache-control']).toBe('no-cache, no-transform');
    expect(stream.text.trim().split('\n').map((line: string) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: 'progress', phase: 'listing' }), { type: 'complete', discovery: result },
    ]);
    const json = await request(app).post(base).send({ repositoryUrl: 'https://github.com/acme/skills' }).expect(200);
    expect(json.body).toEqual(result);
  });
  it('terminates failed streams with an error instead of a complete or partial discovery', async () => {
    mockSkillSourceService.discover.mockImplementation(async (_input, _context, options) => {
      await options.onProgress({ type: 'progress', phase: 'listing' });
      throw new Error('Internal credential detail must not leak');
    });
    const res = await request(createApp({ type: 'board', userId: 'board', companyIds: ['company-1'], source: 'local_implicit' }))
      .post('/api/companies/company-1/skill-sources/discover').set('Accept', 'application/x-ndjson').send({ repositoryUrl: 'https://github.com/acme/skills' }).expect(200);
    const events = res.text.trim().split('\n').map((line: string) => JSON.parse(line));
    expect(events.at(-1)).toEqual({ type: 'error', error: 'Repository scan interrupted. Try again.', status: 500 });
    expect(events.some((event: { type: string }) => event.type === 'complete')).toBe(false);
    expect(res.text).not.toContain('credential detail');
  });
  it('aborts discovery and closes a connected client whose progress stream never drains', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let response: express.Response | undefined;
    let signal: AbortSignal | undefined;
    const write = vi.fn(() => false);
    mockSkillSourceService.discover.mockImplementation(async (_input, _context, options) => {
      signal = options.signal;
      await options.onProgress({ type: 'progress', phase: 'downloading' });
      throw new Error('A stalled scan must abort before continuing');
    });
    try {
      const app = createApp({ type: 'board', userId: 'board', companyIds: ['company-1'], source: 'local_implicit' }, res => {
        response = res;
        res.write = write;
      });
      const pending = request(app).post('/api/companies/company-1/skill-sources/discover')
        .set('Accept', 'application/x-ndjson').send({ repositoryUrl: 'https://github.com/acme/skills' })
        .then(() => null, error => error);
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toBeTruthy();
      expect(signal?.aborted).toBe(true);
      expect(response?.destroyed).toBe(true);
      expect(response?.listenerCount('drain')).toBe(0);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      response?.destroy();
    }
  });

  it("requires an explicit skill disposition and revision when removing a source", async () => {
    const app = createApp({ type: "board", userId: "member", companyIds: ["company-1"], source: "session" });
    const path = "/api/companies/company-1/skill-sources/source-id";
    for (const body of [{}, { revision: 0 }, { skills: "delete" }, { revision: 0, skills: "ignore" }]) {
      await request(app).delete(path).send(body).expect(400);
    }
  });

  it('lists authorized source branches with a validated connection override', async () => {
    const app = createApp({ type: 'board', userId: 'member', companyIds: ['company-1'], source: 'session' });
    const connectionId = '00000000-0000-4000-8000-000000000042';
    const data = { defaultBranch: 'master', branches: [{ name: 'master', isDefault: true }], truncated: false };
    mockSkillSourceService.branches.mockResolvedValue(data);
    const path = '/api/companies/company-1/skill-sources/source-id/branches';
    expect((await request(app).get(path).query({ connectionId }).expect(200)).body).toEqual(data);
    expect(mockSkillSourceService.branches).toHaveBeenCalledWith('company-1', 'source-id', { connectionId }, expect.objectContaining({ read: expect.any(Function) }), expect.any(AbortSignal));
    await request(app).get(path).query({ connectionId: 'invalid' }).expect(400);
  });

  it("rejects cross-company source reads and mutations for board users and agents", async () => {
    for (const actor of [
      { type: "board", userId: "member", companyIds: ["company-1"], isInstanceAdmin: true, source: "session" },
      { type: "agent", agentId: "agent-1", companyId: "company-1" },
    ]) {
      const app = createApp(actor);
      const base = "/api/companies/company-2/skill-sources";
      const responses = await Promise.all([
        request(app).get(base), request(app).get(`${base}/repositories`), request(app).get(`${base}/source-id`), request(app).get(`${base}/source-id/branches`),
        request(app).post(`${base}/discover`).send({ repositoryUrl: "https://github.com/acme/skills" }),
        request(app).post(`${base}/discover`).set('Accept', 'application/x-ndjson').send({ repositoryUrl: "https://github.com/acme/skills" }),
        request(app).post(`${base}/preview`).send({ repositoryUrl: "https://github.com/acme/skills", commitSha: "a".repeat(40), skillPath: "SKILL.md", filePath: "SKILL.md" }),
        request(app).post(base).send({ repositoryUrl: "https://github.com/acme/skills", commitSha: "a".repeat(40), selectedPaths: [] }),
        request(app).patch(`${base}/source-id`).send({ revision: 0, selectedPaths: [], excludedFolders: [] }),
        request(app).post(`${base}/source-id/refresh`), request(app).delete(`${base}/source-id`),
      ]);
      for (const response of responses) expect(response.status).toBe(403);
    }
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("omits source-managed repository identities from import telemetry", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({ imported: [{
      sourceType: "github", key: "github/private-repo/private-skill-name", slug: "private-skill-name",
      metadata: { hostname: "github.com", skillSourceId: "source-1" },
    }], warnings: [] });
    await request(createApp({ type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit" }))
      .post("/api/companies/company-1/skills/import").send({ source: "https://github.com/acme/private" }).expect(201);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), { sourceType: "github", skillRef: null });
  });

  it("does not expose a skill reference for non-public skill imports", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "private-skill",
          slug: "private-skill",
          name: "Private Skill",
          description: null,
          markdown: "# Private Skill",
          sourceType: "github",
          sourceLocator: "https://ghe.example.com/acme/private-skill",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: {
            hostname: "ghe.example.com",
            owner: "acme",
            repo: "private-skill",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp(boardActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://ghe.example.com/acme/private-skill" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it("does not expose a skill reference when GitHub metadata is missing", async () => {
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [
        {
          id: "skill-1",
          companyId: "company-1",
          key: "unknown/private-skill",
          slug: "private-skill",
          name: "Private Skill",
          description: null,
          markdown: "# Private Skill",
          sourceType: "github",
          sourceLocator: "https://github.com/acme/private-skill",
          sourceRef: null,
          trustLevel: "markdown_only",
          compatibility: "compatible",
          fileInventory: [],
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      warnings: [],
    });

    const res = await request(await createApp(boardActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/acme/private-skill" });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTrackSkillImported).toHaveBeenCalledWith(expect.anything(), {
      sourceType: "github",
      skillRef: null,
    });
  });

  it("allows same-company agents without skill change grants when no explicit policy exists", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockAgentService.getById.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      permissions: { canCreateSkills: false },
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "skill_config:update",
      resource: { type: "company", companyId: "company-1" },
    }));
    expect(mockAccessService.hasPermission).not.toHaveBeenCalledWith("company-1", "agent", "55555555-5555-4555-8555-555555555555", "agents:create");
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalled();
  });

  it("blocks agent catalog installs for other companies", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      permissions: { canCreateSkills: true },
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-2/skills/install-catalog")
      .send({ catalogSkillId: "paperclipai:bundled:software-development:review" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.installFromCatalog).not.toHaveBeenCalled();
  });

  it("allows standard agents without skills:create grant to create local skills when no policy exists", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills")
      .send({ name: "Custom Agent Skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.createLocalSkill).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "Custom Agent Skill" }),
      expect.anything(),
    );
  });

  it("allows standard agents without skills:create grant to patch skill files when no policy exists", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const res = await request(await createApp(assignedAgentActor()))
      .patch("/api/companies/company-1/skills/skill-1/files")
      .send({ path: "SKILL.md", content: "# Custom Skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.updateFile).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      "SKILL.md",
      "# Custom Skill",
      expect.anything(),
      expect.anything(),
    );
  });

  it("blocks cross-company agents from creating company skills", async () => {
    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-2/skills")
      .send({ name: "Custom Agent Skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      code: "skill_company_boundary_denied",
    });
    expect(mockCompanySkillService.createLocalSkill).not.toHaveBeenCalled();
  });

  it("denies low-trust agents from creating skills with platform invariant error", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision(
      "deny_low_trust_boundary",
      "Low-trust agents cannot use company-wide skill APIs.",
    ));

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills")
      .send({ name: "Custom Agent Skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      code: "skill_actor_restricted",
      details: { reason: "platform_invariant" },
    });
    expect(mockCompanySkillService.createLocalSkill).not.toHaveBeenCalled();
  });

  it("denies agents from creating skills with forkedFromSkillId", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills")
      .send({ name: "Custom Agent Skill", forkedFromSkillId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      code: "skill_agent_field_restricted",
      error: "Agents cannot fork skills when creating a company skill",
    });
    expect(mockCompanySkillService.createLocalSkill).not.toHaveBeenCalled();
  });

  it("denies agents from creating skills with public_link and global sharingScope", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const publicRes = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills")
      .send({ name: "Custom Agent Skill", sharingScope: "public_link" });

    expect(publicRes.status, JSON.stringify(publicRes.body)).toBe(403);
    expect(publicRes.body).toMatchObject({
      code: "skill_agent_field_restricted",
      error: "Agents can only create company skills with 'company' sharing scope",
    });

    const globalRes = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills")
      .send({ name: "Custom Agent Skill", sharingScope: "global" });

    expect(globalRes.status).toBe(400);
    expect(mockCompanySkillService.createLocalSkill).not.toHaveBeenCalled();
  });

  it("allows agents to create skills with company sharingScope", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills")
      .send({ name: "Custom Agent Skill", sharingScope: "company" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.createLocalSkill).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "Custom Agent Skill", sharingScope: "company" }),
      expect.anything(),
    );
  });

  it("allows board users to create skills with public_link and forkedFromSkillId", async () => {
    const res = await request(await createApp({ type: "board", source: "local_implicit", userId: "user-1" }))
      .post("/api/companies/company-1/skills")
      .send({
        name: "Board Forked Skill",
        sharingScope: "public_link",
        forkedFromSkillId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.createLocalSkill).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "Board Forked Skill",
        sharingScope: "public_link",
        forkedFromSkillId: "11111111-1111-4111-8111-111111111111",
      }),
      expect.anything(),
    );
  });

  it("denies agents from updating skills with public_link and global sharingScope", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const publicRes = await request(await createApp(assignedAgentActor()))
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ sharingScope: "public_link" });

    expect(publicRes.status, JSON.stringify(publicRes.body)).toBe(403);
    expect(publicRes.body).toMatchObject({
      code: "skill_agent_field_restricted",
      error: "Agents can only set 'company' sharing scope on company skills",
    });

    const globalRes = await request(await createApp(assignedAgentActor()))
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ sharingScope: "global" });

    expect(globalRes.status).toBe(400);
    expect(mockCompanySkillService.updateSkill).not.toHaveBeenCalled();
  });

  it("denies agents from forking skills with explicit non-company sharingScope", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const publicRes = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/skill-1/fork")
      .send({ sharingScope: "public_link" });

    expect(publicRes.status, JSON.stringify(publicRes.body)).toBe(403);
    expect(publicRes.body).toMatchObject({
      code: "skill_agent_field_restricted",
      error: "Agents can only fork skills with 'company' sharing scope",
    });

    const privateRes = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/skill-1/fork")
      .send({ sharingScope: "private" });

    expect(privateRes.status, JSON.stringify(privateRes.body)).toBe(403);
    expect(privateRes.body).toMatchObject({
      code: "skill_agent_field_restricted",
      error: "Agents can only fork skills with 'company' sharing scope",
    });

    expect(mockCompanySkillService.forkSkill).not.toHaveBeenCalled();
  });

  it("allows board users to fork skills with explicit public_link sharingScope", async () => {
    const res = await request(await createApp({ type: "board", source: "local_implicit", userId: "user-1" }))
      .post("/api/companies/company-1/skills/skill-1/fork")
      .send({ sharingScope: "public_link" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.forkSkill).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      expect.objectContaining({ sharingScope: "public_link" }),
      expect.anything(),
    );
  });

  it("allows agents to update skills with company sharingScope", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());

    const res = await request(await createApp(assignedAgentActor()))
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ sharingScope: "company", description: "Updated description" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.updateSkill).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      expect.objectContaining({ sharingScope: "company", description: "Updated description" }),
      expect.anything(),
    );
  });

  it("allows board users to update skills with public_link sharingScope", async () => {
    const res = await request(await createApp({ type: "board", source: "local_implicit", userId: "user-1" }))
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ sharingScope: "public_link" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.updateSkill).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      expect.objectContaining({ sharingScope: "public_link" }),
      expect.anything(),
    );
  });

  it("rejects file deletion from an agent-JWT run that is not task-bound", async () => {
    mockCaptureRunIdentity.mockResolvedValueOnce({ run: { responsibleUserId: "validated-owner" } });

    const res = await request(await createApp({ ...assignedAgentActor(), source: "agent_jwt" }))
      .delete("/api/companies/company-1/skills/skill-1/files")
      .send({ path: "references/guide.md", target: "file" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      error: "Skill tools require a task-bound run",
    });
    expect(mockCompanySkillService.deleteFile).not.toHaveBeenCalled();
  });

  it("rejects skill deletion from an agent-JWT run that is not task-bound", async () => {
    mockCaptureRunIdentity.mockResolvedValueOnce({ run: { responsibleUserId: "validated-owner" } });

    const res = await request(await createApp({ ...assignedAgentActor(), source: "agent_jwt" }))
      .delete("/api/companies/company-1/skills/skill-1");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      error: "Skill tools require a task-bound run",
    });
    expect(mockCompanySkillService.deleteSkill).not.toHaveBeenCalled();
  });

  it("rejects test run creation from an agent-JWT run that is not task-bound", async () => {
    mockCaptureRunIdentity.mockResolvedValueOnce({ run: { responsibleUserId: "validated-owner" } });

    const res = await request(await createApp({ ...assignedAgentActor(), source: "agent_jwt" }))
      .post("/api/companies/company-1/skills/skill-1/test-runs")
      .send({ agentId: "55555555-5555-4555-8555-555555555555", content: "Test content" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      error: "Skill tools require a task-bound run",
    });
    expect(mockCompanySkillService.createTestRun).not.toHaveBeenCalled();
  });

  it("denies agent browse-project when project:read is not allowed", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "project:read") {
        return { allowed: false, action: "project:read", reason: "deny_no_grant", explanation: "Project read denied." };
      }
      return allowSkillChangeDecision();
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/browse-project")
      .send({ projectId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      code: "skill_agent_project_read_restricted",
    });
    expect(mockCompanySkillService.browseProjectWorkspace).not.toHaveBeenCalled();
  });

  it("allows agent browse-project when project:read is allowed", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "project:read") {
        return { allowed: true, action: "project:read", reason: "allow", explanation: "Allowed." };
      }
      return denySkillChangeDecision();
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/browse-project")
      .send({ projectId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.browseProjectWorkspace).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ projectId: "11111111-1111-4111-8111-111111111111" }),
    );
  });

  it("allows board browse-project without agent project:read check", async () => {
    const res = await request(await createApp({ type: "board", source: "local_implicit", userId: "user-1" }))
      .post("/api/companies/company-1/skills/browse-project")
      .send({ projectId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.browseProjectWorkspace).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ projectId: "11111111-1111-4111-8111-111111111111" }),
    );
  });

  it("denies agent scan-projects when project:read is not allowed for any project", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "project:read") {
        return { allowed: false, action: "project:read", reason: "deny_no_grant", explanation: "Project read denied." };
      }
      return allowSkillChangeDecision();
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/scan-projects")
      .send({ projectIds: ["11111111-1111-4111-8111-111111111111"] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      code: "skill_agent_project_read_restricted",
    });
    expect(mockCompanySkillService.scanProjectWorkspaces).not.toHaveBeenCalled();
  });

  it("allows agent scan-projects when project:read is allowed", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "project:read") {
        return { allowed: true, action: "project:read", reason: "allow", explanation: "Allowed." };
      }
      return denySkillChangeDecision();
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/scan-projects")
      .send({ projectIds: ["11111111-1111-4111-8111-111111111111"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.scanProjectWorkspaces).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ projectIds: ["11111111-1111-4111-8111-111111111111"] }),
    );
  });

  it("allows board scan-projects without agent project:read check", async () => {
    const res = await request(await createApp({ type: "board", source: "local_implicit", userId: "user-1" }))
      .post("/api/companies/company-1/skills/scan-projects")
      .send({ projectIds: ["11111111-1111-4111-8111-111111111111"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.scanProjectWorkspaces).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ projectIds: ["11111111-1111-4111-8111-111111111111"] }),
    );
  });

  it("rejects file patch without idempotencyKey from an agent-JWT run that is not task-bound", async () => {
    mockCaptureRunIdentity.mockResolvedValueOnce({ run: { responsibleUserId: "validated-owner" } });

    const res = await request(await createApp({ ...assignedAgentActor(), source: "agent_jwt" }))
      .patch("/api/companies/company-1/skills/skill-1/files")
      .send({ path: "SKILL.md", content: "# Edited Content" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      error: "Skill tools require a task-bound run",
    });
    expect(mockCompanySkillService.updateFile).not.toHaveBeenCalled();
  });

  it("rejects file patch from an Ask or Plan mode task", async () => {
    mockCaptureRunIdentity.mockResolvedValueOnce({
      run: { id: "run-1", responsibleUserId: "validated-owner", nativeIssueId: "issue-1" },
    });
    const askDb = {
      select: () => ({
        from: () => ({
          where: async () => [{ id: "issue-1", companyId: "company-1", workMode: "ask", conversationSessionGeneration: 0 }],
        }),
      }),
    };

    const res = await request(await createApp({ ...assignedAgentActor(), source: "agent_jwt" }, undefined, askDb))
      .patch("/api/companies/company-1/skills/skill-1/files")
      .send({ path: "SKILL.md", content: "# Edited Content" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      error: "Skill creation is unavailable in Ask or Plan mode",
    });
    expect(mockCompanySkillService.updateFile).not.toHaveBeenCalled();
  });

  it("allows file patch from a skill_test mode task", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockCaptureRunIdentity.mockResolvedValueOnce({
      run: { id: "run-1", responsibleUserId: "validated-owner", nativeIssueId: "issue-1" },
    });
    const skillTestDb = {
      select: () => ({
        from: () => ({
          where: async () => [{ id: "issue-1", companyId: "company-1", workMode: "skill_test", conversationSessionGeneration: 0 }],
        }),
      }),
    };

    const res = await request(await createApp({ ...assignedAgentActor(), source: "agent_jwt" }, undefined, skillTestDb))
      .patch("/api/companies/company-1/skills/skill-1/files")
      .send({ path: "SKILL.md", content: "# Edited Content" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.updateFile).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      "SKILL.md",
      "# Edited Content",
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects skill audit from an agent-JWT run that is not task-bound", async () => {
    mockCaptureRunIdentity.mockResolvedValueOnce({ run: { responsibleUserId: "validated-owner" } });

    const res = await request(await createApp({ ...assignedAgentActor(), source: "agent_jwt" }))
      .post("/api/companies/company-1/skills/skill-1/audit");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      error: "Skill tools require a task-bound run",
    });
    expect(mockCompanySkillService.auditSkill).not.toHaveBeenCalled();
  });

  it("blocks skill creation when an explicit skill policy denies skills.create for agents", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockCompanySkillPolicyService.evaluate.mockResolvedValue(denySkillPolicy("skills.create"));

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills")
      .send({ name: "Custom Agent Skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      code: "skill_policy_denied",
      error: "Skill action denied by company policy",
    });
    expect(mockCompanySkillService.createLocalSkill).not.toHaveBeenCalled();
  });

  it("rejects skill creation from an agent-JWT run that is not task-bound", async () => {
    mockCaptureRunIdentity.mockResolvedValueOnce({ run: { responsibleUserId: "validated-owner" } });

    const res = await request(await createApp({ ...assignedAgentActor(), source: "agent_jwt" }))
      .post("/api/companies/company-1/skills")
      .send({ name: "Custom Agent Skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toMatchObject({
      error: "Skill tools require a task-bound run",
    });
    expect(mockCompanySkillService.createLocalSkill).not.toHaveBeenCalled();
  });

  it("passes store list filters and category count requests to the service", async () => {
    const app = await createApp({ type: "board", source: "local_implicit" });

    await request(app)
      .get("/api/companies/company-1/skills?sort=stars&categories[]=memory&category=git&scope=company&q=review&include=lastEditor")
      .expect(200);
    expect(mockCompanySkillService.list).toHaveBeenCalledWith("company-1", {
      q: "review",
      sort: "stars",
      categories: ["git", "memory"],
      scope: "company",
      include: ["lastEditor"],
    });

    await request(app).get("/api/companies/company-1/skills/categories").expect(200);
    expect(mockCompanySkillService.categoryCounts).toHaveBeenCalledWith("company-1");
  });

  it("accepts category updates and logs the skill mutation", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    const res = await request(app)
      .patch("/api/companies/company-1/skills/skill-1")
      .send({ categories: ["memory", "review"], sharingScope: "company" })
      .expect(200);

    expect(res.body).toMatchObject({
      id: "skill-1",
      categories: ["memory", "review"],
      sharingScope: "company",
    });
    expect(mockCompanySkillService.updateSkill).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      {
        categories: ["memory", "review"],
        sharingScope: "company",
      },
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "company.skill_updated",
      entityType: "company_skill",
      entityId: "skill-1",
      details: {
        slug: "review",
        categories: ["memory", "review"],
        sharingScope: "company",
      },
    }));
  });

  it("creates skill versions and logs the mutation", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    await request(app)
      .post("/api/companies/company-1/skills/skill-1/versions")
      .send({ label: "v1" })
      .expect(201);

    expect(mockCompanySkillService.createVersion).toHaveBeenCalledWith("company-1", "skill-1", { label: "v1" }, {
      type: "user",
      userId: "user-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_version_created",
      entityType: "company_skill_version",
      entityId: "version-1",
    }));
  });

  it("deletes skill files and logs the mutation", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    const res = await request(app)
      .delete("/api/companies/company-1/skills/skill-1/files")
      .send({ path: "references", target: "folder" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(mockCompanySkillService.deleteFile).toHaveBeenCalledWith("company-1", "skill-1", {
      path: "references",
      target: "folder",
    }, expect.anything());
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_file_deleted",
      entityType: "company_skill",
      entityId: "skill-1",
      details: {
        path: "references",
        target: "folder",
        deletedPaths: ["references/example.md"],
      },
    }));
  });

  it("stars, forks, and comments on skills through company-scoped endpoints", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    await request(app).post("/api/companies/company-1/skills/skill-1/star").send({}).expect(200);
    expect(mockCompanySkillService.starSkill).toHaveBeenCalledWith("company-1", "skill-1", {
      type: "user",
      userId: "user-1",
    });

    const forkRes = await request(app)
      .post("/api/companies/company-1/skills/skill-1/fork")
      .send({ slug: "review-fork", reassignAgentIds: ["11111111-1111-4111-8111-111111111111"] })
      .expect(201);
    expect(forkRes.body).toMatchObject({
      skill: { id: "skill-fork", slug: "review-fork" },
      original: { id: "skill-1", slug: "review" },
      reassignments: [],
    });
    expect(mockCompanySkillService.forkSkill).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      { slug: "review-fork", reassignAgentIds: ["11111111-1111-4111-8111-111111111111"] },
      expect.anything(),
    );

    await request(app).get("/api/companies/company-1/skills/skill-1/fork-precheck").expect(200);
    expect(mockCompanySkillService.forkPrecheck).toHaveBeenCalledWith("company-1", "skill-1", {
      type: "user",
      userId: "user-1",
    });

    await request(app).post("/api/companies/company-1/skills/skill-1/comments").send({ body: "Looks good" }).expect(201);
    expect(mockCompanySkillService.createComment).toHaveBeenCalledWith("company-1", "skill-1", { body: "Looks good" }, {
      type: "user",
      userId: "user-1",
    });

    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_starred",
      entityId: "skill-1",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_forked",
      entityId: "skill-fork",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_comment_created",
      entityId: "comment-1",
    }));
  });

  it("renames a skill and logs the rename activity", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    const res = await request(app)
      .post("/api/companies/company-1/skills/skill-1/rename")
      .send({ name: "Ship PR", slug: "ship-pr" })
      .expect(200);

    expect(res.body).toMatchObject({
      skill: { id: "skill-1", name: "Ship PR", slug: "ship-pr", key: "company/company-1/ship-pr" },
      previousName: "Review",
      previousSlug: "review",
      previousKey: "company/company-1/review",
    });
    expect(mockCompanySkillService.renameSkill).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      { name: "Ship PR", slug: "ship-pr" },
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_renamed",
      entityType: "company_skill",
      entityId: "skill-1",
      details: expect.objectContaining({
        previousSlug: "review",
        slug: "ship-pr",
        reassignedAgentIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    }));
  });

  it("does not log rename activity for a normalized no-op", async () => {
    mockCompanySkillService.renameSkill.mockResolvedValueOnce({
      skill: {
        id: "skill-1",
        name: "Review",
        slug: "review",
        key: "company/company-1/review",
      },
      previousName: "Review",
      previousSlug: "review",
      previousKey: "company/company-1/review",
      reassignments: [],
    });
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    await request(app)
      .post("/api/companies/company-1/skills/skill-1/rename")
      .send({ name: "Review", slug: "review" })
      .expect(200);

    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_renamed",
    }));
  });

  it("attributes rename activity to the calling agent API key", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      runId: "run-1",
      keyId: "agent-key-1",
      source: "agent_key",
    });

    await request(app)
      .post("/api/companies/company-1/skills/skill-1/rename")
      .send({ name: "Ship PR", slug: "ship-pr" })
      .expect(200);

    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "company.skill_renamed",
      actorType: "agent",
      agentId: "55555555-5555-4555-8555-555555555555",
      runId: "run-1",
      agentApiKeyId: "agent-key-1",
    }));
  });

  it("rejects a rename request with a missing name", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    await request(app)
      .post("/api/companies/company-1/skills/skill-1/rename")
      .send({ slug: "ship-pr" })
      .expect(400);
    expect(mockCompanySkillService.renameSkill).not.toHaveBeenCalled();
  });

  it("rejects a rename request with a multiline name", async () => {
    const app = await createApp({ type: "board", source: "local_implicit", userId: "user-1" });

    await request(app)
      .post("/api/companies/company-1/skills/skill-1/rename")
      .send({ name: "Ship PR\nslug: injected" })
      .expect(400);
    expect(mockCompanySkillService.renameSkill).not.toHaveBeenCalled();
  });

  it("does not synthesize a shared board user id for board actors without user ids", async () => {
    const app = await createApp({ type: "board", source: "local_implicit" });

    await request(app).post("/api/companies/company-1/skills/skill-1/star").send({}).expect(200);

    expect(mockCompanySkillService.starSkill).toHaveBeenCalledWith("company-1", "skill-1", {
      type: "user",
      userId: null,
    });
  });

  it("allows agents with direct skills:create grants to mutate company skills", async () => {
    mockAccessService.decide.mockResolvedValue(allowSkillChangeDecision("allow_direct_change"));
    mockAgentService.getById.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      permissions: { canCreateSkills: false },
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "skill_config:update",
      resource: { type: "company", companyId: "company-1" },
    }));
    expect(mockReflectionCoachMutationGate.assertConsented).not.toHaveBeenCalled();
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("does not require consent for suggest-tier skill mutations under the open default", async () => {
    const { forbidden } = await import("../errors.js");
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision(
      "deny_missing_consent",
      "Permission skills:suggest-changes requires accepted change consent before applying this mutation.",
    ));
    mockReflectionCoachMutationGate.assertConsented.mockRejectedValue(forbidden("gate required", {
      code: "reflection_coach_mutation_gate_required",
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "reflection-coach",
      companyId: "company-1",
      runId: "run-apply",
    }))
      .post("/api/companies/company-1/skills")
      .send({ name: "Reflection Draft", slug: "reflection-draft", markdown: "# Draft" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockReflectionCoachMutationGate.assertConsented).not.toHaveBeenCalled();
    expect(mockCompanySkillService.createLocalSkill).toHaveBeenCalled();
  });



  it("allows suggest-tier skill mutations without a second consent decision", async () => {
    mockAccessService.decide
      .mockResolvedValueOnce(denySkillChangeDecision(
        "deny_missing_consent",
        "Permission skills:suggest-changes requires accepted change consent before applying this mutation.",
      ))
      .mockResolvedValueOnce(allowSkillChangeDecision("allow_consented_change"));
    mockAgentService.getById.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockReflectionCoachMutationGate.assertConsented).not.toHaveBeenCalled();
    expect(mockAccessService.decide).toHaveBeenCalledTimes(1);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "company-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("allows same-company agents without either legacy skill grant", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockAgentService.getById.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      permissions: {},
    });

    const res = await request(await createApp(assignedAgentActor()))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "skill_config:update",
      resource: { type: "company", companyId: "company-1" },
    }));
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalled();
  });

  it("does not require unrelated agents:create grants for open-default skill mutations", async () => {
    mockAccessService.decide.mockResolvedValue(denySkillChangeDecision());
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      permissions: { canCreateSkills: false },
    });
    mockAccessService.hasPermission.mockImplementation(async (
      _companyId: string,
      _principalType: string,
      _principalId: string,
      key: string,
    ) => key === "agents:create");

    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/companies/company-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "skill_config:update",
      resource: { type: "company", companyId: "company-1" },
    }));
    expect(mockAccessService.hasPermission).not.toHaveBeenCalledWith("company-1", "agent", "agent-1", "agents:create");
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalled();
  });

  it("routes skill test input CRUD through skills mutation permissions", async () => {
    const app = await createApp(boardActor());

    const created = await request(app)
      .post("/api/companies/company-1/skills/skill-1/test-inputs")
      .send({ name: "smoke/input", content: "Try the skill" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(mockCompanySkillService.createTestInput).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      { name: "smoke/input", content: "Try the skill" },
      { type: "user", userId: "local-board" },
    );

    const updated = await request(app)
      .patch("/api/companies/company-1/skills/skill-1/test-inputs/11111111-1111-4111-8111-111111111111")
      .send({ name: "smoke/renamed", content: "Try the skill again" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(mockCompanySkillService.updateTestInput).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      "11111111-1111-4111-8111-111111111111",
      { name: "smoke/renamed", content: "Try the skill again" },
    );

    const removed = await request(app)
      .delete("/api/companies/company-1/skills/skill-1/test-inputs/11111111-1111-4111-8111-111111111111");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(mockCompanySkillService.deleteTestInput).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("routes skill test run template CRUD through skills mutation permissions", async () => {
    const app = await createApp(boardActor());

    const listed = await request(app).get("/api/companies/company-1/skill-test-run-templates");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(mockCompanySkillService.listTestRunTemplates).toHaveBeenCalledWith("company-1");

    const created = await request(app)
      .post("/api/companies/company-1/skill-test-run-templates")
      .send({ name: "Custom template", description: "Custom run guidance", body: "Run {{skillName}}." });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(mockCompanySkillService.createTestRunTemplate).toHaveBeenCalledWith(
      "company-1",
      { name: "Custom template", description: "Custom run guidance", body: "Run {{skillName}}." },
      { type: "user", userId: "local-board" },
    );

    const updated = await request(app)
      .patch("/api/companies/company-1/skill-test-run-templates/66666666-6666-4666-8666-666666666666")
      .send({ name: "Renamed template" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(mockCompanySkillService.updateTestRunTemplate).toHaveBeenCalledWith(
      "company-1",
      "66666666-6666-4666-8666-666666666666",
      { name: "Renamed template" },
      { type: "user", userId: "local-board" },
    );

    const removed = await request(app)
      .delete("/api/companies/company-1/skill-test-run-templates/66666666-6666-4666-8666-666666666666");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(mockCompanySkillService.deleteTestRunTemplate).toHaveBeenCalledWith(
      "company-1",
      "66666666-6666-4666-8666-666666666666",
    );
  });

  it("creates and cancels skill test runs through hidden issue orchestration", async () => {
    mockCompanySkillService.createTestRun.mockImplementationOnce(async (
      _companyId: string,
      _skillId: string,
      _body: unknown,
      _actor: unknown,
      deps: {
        createHarnessIssue: (input: Record<string, unknown>) => Promise<unknown>;
        wakeHarnessIssue: (issueId: string, agentId: string) => Promise<unknown>;
      },
    ) => {
      await deps.createHarnessIssue({
        id: "44444444-4444-4444-8444-444444444444",
        title: "Skill test: Review",
        description: "Try the skill",
        assigneeAgentId: "55555555-5555-4555-8555-555555555555",
        harnessKind: "skill_test",
        workMode: "skill_test",
        status: "todo",
        originKind: "skill_test",
        originId: "22222222-2222-4222-8222-222222222222",
        originFingerprint: "skill_test:22222222-2222-4222-8222-222222222222",
      });
      await deps.wakeHarnessIssue("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555");
      return {
        ...createSkillTestRunDetails(),
        createdAt: new Date("2026-05-26T00:00:00.000Z"),
        updatedAt: new Date("2026-05-26T00:00:00.000Z"),
        cost: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        taskExpired: false,
      };
    });
    mockCompanySkillService.cancelTestRun.mockImplementationOnce(async (
      _companyId: string,
      _skillId: string,
      _runId: string,
      deps: { cancelHarnessIssue: (issueId: string) => Promise<unknown> },
    ) => {
      await deps.cancelHarnessIssue("44444444-4444-4444-8444-444444444444");
      return {
        ...createSkillTestRunDetails({ status: "cancelled", error: "Cancelled by operator" }),
        createdAt: new Date("2026-05-26T00:00:00.000Z"),
        updatedAt: new Date("2026-05-26T00:01:00.000Z"),
        cost: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        taskExpired: false,
      };
    });

    const app = await createApp(boardActor());

    const created = await request(app)
      .post("/api/companies/company-1/skills/skill-1/test-runs")
      .send({ inputId: "11111111-1111-4111-8111-111111111111", agentId: "55555555-5555-4555-8555-555555555555" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      harnessKind: "skill_test",
      workMode: "skill_test",
      assigneeAgentId: "55555555-5555-4555-8555-555555555555",
      description: "Try the skill",
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555", expect.objectContaining({
      reason: "skill_test_run_created",
      payload: expect.objectContaining({ issueId: "44444444-4444-4444-8444-444444444444", skillId: "skill-1" }),
    }));

    const cancelled = await request(app)
      .post("/api/companies/company-1/skills/skill-1/test-runs/22222222-2222-4222-8222-222222222222/cancel")
      .send({});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1", "Cancelled by skill test run request");
    expect(mockIssueService.update).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444", expect.objectContaining({
      status: "cancelled",
      actorUserId: "local-board",
    }));
  });

  it.each([
    ["create", "post", "/api/companies/company-1/skills/skill-1/test-runs"],
    ["cancel", "post", "/api/companies/company-1/skills/skill-1/test-runs/22222222-2222-4222-8222-222222222222/cancel"],
    ["delete", "delete", "/api/companies/company-1/skills/skill-1/test-runs/22222222-2222-4222-8222-222222222222"],
  ] as const)("denies agents without tasks:assign permission from %s test runs", async (_operation, method, path) => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "tasks:assign") return denyTaskAssignDecision();
      return allowSkillChangeDecision();
    });
    mockCompanySkillService.getTestRunDetail.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      skillId: "skill-1",
      issueId: "44444444-4444-4444-8444-444444444444",
      agentId: "55555555-5555-4555-8555-555555555555",
      status: "queued",
    });

    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      keyScope: null,
      runId: "run-1",
    });
    const response = method === "post"
      ? await request(app)[method](path).send({
        inputId: "11111111-1111-4111-8111-111111111111",
        agentId: "55555555-5555-4555-8555-555555555555",
      })
      : await request(app)[method](path);

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toBe("Missing permission: tasks:assign");
    expect(mockCompanySkillPolicyService.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      action: "skills.test",
    }));
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "tasks:assign",
      resource: expect.objectContaining({
        type: "issue",
        companyId: "company-1",
      }),
    }));
    expect(mockCompanySkillService.createTestRun).not.toHaveBeenCalled();
    expect(mockCompanySkillService.cancelTestRun).not.toHaveBeenCalled();
    expect(mockCompanySkillService.deleteTestRun).not.toHaveBeenCalled();
  });

  it("does not prune expired harness issues from test run reads", async () => {
    mockCompanySkillService.listTestRuns.mockResolvedValueOnce([]);
    mockCompanySkillService.getTestRunDetail.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      skillId: "skill-1",
      status: "succeeded",
      harnessContent: { available: false, unavailableReason: "expired", documents: [], attachments: [], workProducts: [] },
    });

    const app = await createApp(boardActor());

    const listed = await request(app)
      .get("/api/companies/company-1/skills/skill-1/test-runs");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);

    const detail = await request(app)
      .get("/api/companies/company-1/skills/skill-1/test-runs/22222222-2222-4222-8222-222222222222");
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);

    expect(mockCompanySkillService.listTestRuns).toHaveBeenCalledWith("company-1", "skill-1", {});
    expect(mockCompanySkillService.getTestRunDetail).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(mockCompanySkillService.pruneExpiredTestHarnessIssues).not.toHaveBeenCalled();
  });

  it("deletes a terminal test run and hides its harness task", async () => {
    mockIssueService.getById.mockResolvedValueOnce({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-1",
      status: "done",
      executionRunId: null,
    });
    mockCompanySkillService.deleteTestRun.mockImplementationOnce(async (
      _companyId: string,
      _skillId: string,
      _runId: string,
      deps: { hideHarnessIssue: (issueId: string) => Promise<unknown> },
    ) => {
      await deps.hideHarnessIssue("44444444-4444-4444-8444-444444444444");
      return {
        ...createSkillTestRunDetails({ inputId: null, status: "succeeded", deletedAt: new Date("2026-05-26T00:02:00.000Z") }),
        createdAt: new Date("2026-05-26T00:00:00.000Z"),
        updatedAt: new Date("2026-05-26T00:02:00.000Z"),
        cost: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        taskExpired: false,
      };
    });

    const app = await createApp(boardActor());

    const deleted = await request(app)
      .delete("/api/companies/company-1/skills/skill-1/test-runs/22222222-2222-4222-8222-222222222222");
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(mockCompanySkillService.deleteTestRun).toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      expect.objectContaining({ hiddenAt: expect.any(Date) }),
    );
  });

  it("returns 404 when deleting a missing test run", async () => {
    mockCompanySkillService.deleteTestRun.mockResolvedValueOnce(null);
    const app = await createApp(boardActor());
    const res = await request(app)
      .delete("/api/companies/company-1/skills/skill-1/test-runs/22222222-2222-4222-8222-222222222222");
    expect(res.status).toBe(404);
  });

  it("returns a blocking error when attempting to delete a skill still used by agents", async () => {
    const { unprocessable } = await import("../errors.js");
    mockCompanySkillService.deleteSkill.mockImplementationOnce(async () => {
      throw unprocessable(
        'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
      );
    });

    const res = await request(await createApp(boardActor()))
      .delete("/api/companies/company-1/skills/skill-1");

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({
      error: 'Cannot delete skill "Find Skills" while it is still used by Builder, Reviewer. Detach it from those agents first.',
    });
    expect(mockCompanySkillService.deleteSkill).toHaveBeenCalledWith(
      "company-1",
      "skill-1",
      expect.anything(),
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  describe("low-risk company skill mutation permissions for agents (TECH-10594)", () => {
    const skillGatedMutatingRoutes = [
      { name: "create version", method: "post", path: "/api/companies/:cid/skills/skill-1/versions", body: { label: "v2" }, successStatus: 201 },
      { name: "install catalog", method: "post", path: "/api/companies/:cid/skills/install-catalog", body: { catalogSkillId: "paperclipai:bundled:software-development:review" }, successStatus: 201 },
      { name: "install update", method: "post", path: "/api/companies/:cid/skills/skill-1/install-update", body: {}, successStatus: 200 },
      { name: "reset skill", method: "post", path: "/api/companies/:cid/skills/skill-1/reset", body: {}, successStatus: 200 },
      { name: "create test input", method: "post", path: "/api/companies/:cid/skills/skill-1/test-inputs", body: { name: "smoke/input", content: "Try it" }, successStatus: 201 },
      { name: "update test input", method: "patch", path: "/api/companies/:cid/skills/skill-1/test-inputs/11111111-1111-4111-8111-111111111111", body: { name: "smoke/renamed" }, successStatus: 200 },
      { name: "delete test input", method: "delete", path: "/api/companies/:cid/skills/skill-1/test-inputs/11111111-1111-4111-8111-111111111111", body: undefined, successStatus: 200 },
      { name: "create test run template", method: "post", path: "/api/companies/:cid/skill-test-run-templates", body: { name: "Tmpl", body: "Run {{skillName}}" }, successStatus: 201 },
      { name: "update test run template", method: "patch", path: "/api/companies/:cid/skill-test-run-templates/66666666-6666-4666-8666-666666666666", body: { name: "Renamed" }, successStatus: 200 },
      { name: "delete test run template", method: "delete", path: "/api/companies/:cid/skill-test-run-templates/66666666-6666-4666-8666-666666666666", body: undefined, successStatus: 200 },
      { name: "cancel test run", method: "post", path: "/api/companies/:cid/skills/skill-1/test-runs/22222222-2222-4222-8222-222222222222/cancel", body: {}, successStatus: 200 },
      { name: "delete test run", method: "delete", path: "/api/companies/:cid/skills/skill-1/test-runs/22222222-2222-4222-8222-222222222222", body: undefined, successStatus: 200 },
    ] as const;

    const companyAccessMutatingRoutes = [
      { name: "star skill", method: "post", path: "/api/companies/:cid/skills/skill-1/star", body: undefined, successStatus: 200 },
      { name: "unstar skill", method: "delete", path: "/api/companies/:cid/skills/skill-1/star", body: undefined, successStatus: 200 },
      { name: "create comment", method: "post", path: "/api/companies/:cid/skills/skill-1/comments", body: { body: "Looks good" }, successStatus: 201 },
      { name: "update comment", method: "patch", path: "/api/companies/:cid/skills/skill-1/comments/comment-1", body: { body: "Updated" }, successStatus: 200 },
      { name: "delete comment", method: "delete", path: "/api/companies/:cid/skills/skill-1/comments/comment-1", body: undefined, successStatus: 200 },
    ] as const;

    beforeEach(() => {
      mockCompanySkillService.getTestRunDetail.mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "company-1",
        skillId: "skill-1",
        issueId: null,
      });
      mockCompanySkillService.cancelTestRun.mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
      });
      mockCompanySkillService.deleteTestRun.mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
      });
    });

    describe.each(skillGatedMutatingRoutes)("$name", ({ method, path, body, successStatus }) => {
      it("allows standard agents without skills grants", async () => {
        mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
          if (input.action === "tasks:assign") return { allowed: true, action: "tasks:assign", reason: "allow", explanation: "Allowed." };
          return denySkillChangeDecision();
        });

        const app = await createApp(assignedAgentActor());
        const targetPath = path.replace(":cid", "company-1");
        const req = body !== undefined
          ? (request(app)[method as "post" | "patch" | "delete"](targetPath) as any).send(body)
          : request(app)[method as "post" | "patch" | "delete"](targetPath);

        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(successStatus);
      });

      it("denies low-trust agents with 403 skill_actor_restricted", async () => {
        mockAccessService.decide.mockResolvedValue(denySkillChangeDecision(
          "deny_low_trust_boundary",
          "Low-trust agents cannot use company-wide skill APIs.",
        ));

        const app = await createApp(assignedAgentActor());
        const targetPath = path.replace(":cid", "company-1");
        const req = body !== undefined
          ? (request(app)[method as "post" | "patch" | "delete"](targetPath) as any).send(body)
          : request(app)[method as "post" | "patch" | "delete"](targetPath);

        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body).toMatchObject({
          code: "skill_actor_restricted",
          details: { reason: "platform_invariant" },
        });
      });

      it("denies cross-company agents with 403", async () => {
        const app = await createApp(assignedAgentActor());
        const targetPath = path.replace(":cid", "company-2");
        const req = body !== undefined
          ? (request(app)[method as "post" | "patch" | "delete"](targetPath) as any).send(body)
          : request(app)[method as "post" | "patch" | "delete"](targetPath);

        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      });
    });

    describe.each(companyAccessMutatingRoutes)("$name", ({ method, path, body, successStatus }) => {
      it("allows same-company agents", async () => {
        const app = await createApp(assignedAgentActor());
        const targetPath = path.replace(":cid", "company-1");
        const req = body !== undefined
          ? (request(app)[method as "post" | "patch" | "delete"](targetPath) as any).send(body)
          : request(app)[method as "post" | "patch" | "delete"](targetPath);

        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(successStatus);
      });

      it("denies cross-company agents with 403", async () => {
        const app = await createApp(assignedAgentActor());
        const targetPath = path.replace(":cid", "company-2");
        const req = body !== undefined
          ? (request(app)[method as "post" | "patch" | "delete"](targetPath) as any).send(body)
          : request(app)[method as "post" | "patch" | "delete"](targetPath);

        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      });
    });
  });

  describe("guarded company skill mutation permissions for agents (TECH-10594 PR-3)", () => {
    const guardedSkillMutatingRoutes = [
      { name: "patch skill", method: "patch", path: "/api/companies/:cid/skills/skill-1", body: { description: "Updated" }, successStatus: 200 },
      { name: "delete file", method: "delete", path: "/api/companies/:cid/skills/skill-1/files", body: { path: "references/guide.md", target: "file" }, successStatus: 200 },
      { name: "delete skill", method: "delete", path: "/api/companies/:cid/skills/skill-1", body: undefined, successStatus: 200 },
      { name: "fork skill", method: "post", path: "/api/companies/:cid/skills/skill-1/fork", body: { name: "Forked" }, successStatus: 201 },
      { name: "rename skill", method: "post", path: "/api/companies/:cid/skills/skill-1/rename", body: { name: "Renamed" }, successStatus: 200 },
      { name: "create test run", method: "post", path: "/api/companies/:cid/skills/skill-1/test-runs", body: { agentId: "55555555-5555-4555-8555-555555555555", content: "Test content" }, successStatus: 201 },
      { name: "browse project", method: "post", path: "/api/companies/:cid/skills/browse-project", body: { projectId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" }, successStatus: 200 },
      { name: "scan projects", method: "post", path: "/api/companies/:cid/skills/scan-projects", body: { projectIds: ["11111111-1111-4111-8111-111111111111"] }, successStatus: 200 },
    ] as const;

    describe.each(guardedSkillMutatingRoutes)("$name", ({ method, path, body, successStatus }) => {
      it("allows standard agents without skills grants", async () => {
        mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
          if (input.action === "project:read" || input.action === "agent_config:update" || input.action === "tasks:assign") {
            return { allowed: true, action: input.action, reason: "allow", explanation: "Allowed." };
          }
          return denySkillChangeDecision();
        });

        const app = await createApp(assignedAgentActor());
        const targetPath = path.replace(":cid", "company-1");
        const req = body !== undefined
          ? (request(app)[method as "post" | "patch" | "delete"](targetPath) as any).send(body)
          : request(app)[method as "post" | "patch" | "delete"](targetPath);

        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(successStatus);
      });

      it("denies low-trust agents with 403 skill_actor_restricted", async () => {
        mockAccessService.decide.mockResolvedValue(denySkillChangeDecision(
          "deny_low_trust_boundary",
          "Low-trust agents cannot use company-wide skill APIs.",
        ));

        const app = await createApp(assignedAgentActor());
        const targetPath = path.replace(":cid", "company-1");
        const req = body !== undefined
          ? (request(app)[method as "post" | "patch" | "delete"](targetPath) as any).send(body)
          : request(app)[method as "post" | "patch" | "delete"](targetPath);

        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body).toMatchObject({
          code: "skill_actor_restricted",
          details: { reason: "platform_invariant" },
        });
      });

      it("denies cross-company agents with 403 skill_company_boundary_denied", async () => {
        const app = await createApp(assignedAgentActor());
        const targetPath = path.replace(":cid", "company-2");
        const req = body !== undefined
          ? (request(app)[method as "post" | "patch" | "delete"](targetPath) as any).send(body)
          : request(app)[method as "post" | "patch" | "delete"](targetPath);

        const res = await req;
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body).toMatchObject({
          code: "skill_company_boundary_denied",
        });
      });
    });
  });
});
