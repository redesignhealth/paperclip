# Company Skills Workflow

Use this reference when a board user, CEO, or manager asks you to find a skill, install it into the company library, or assign it to an agent.

## What Exists

- App-shipped catalog: a curated set of company skills in `@paperclipai/skills-catalog`, browseable and installable without leaving Paperclip.
- Company skill library: install, inspect, update, audit, reset, and read company skills for the whole company.
- Agent skill assignment: add or remove company skills on an existing agent.
- Hire/create composition: pass `desiredSkills` when creating or hiring an agent so the same assignment model applies immediately.

The canonical model is:

1. add the skill to the company library — either from the app catalog (`skills install`), an external source (`skills import`), or a managed local skill (`skills create`/`skills scan-projects`)
2. attach the company skill to the agent (`skills agent sync`)
3. optionally do step 2 during hire/create with `desiredSkills`

Catalog install ≠ agent attach. Installing a catalog skill only adds the row to
`company_skills`. The agent will not use it until you sync the agent's desired
set.

## Permission Model

- Company skill reads: any same-company actor
- Company skill mutations: open to same-company actors by default. Missing `skills:create` grants and `canCreateSkills` settings do not deny ordinary skill work; only an explicit company skill policy restriction does. Core safety and company-boundary checks always remain enforced.
- Agent skill assignment: same permission model as updating that agent
- Team installs continue to require `agents:create` because they import or create agents in addition to attaching skills.

## Authoring Your Own Skill (Agents)

When authoring or modifying skills from a sandboxed agent (e.g. Hermes or Kubernetes), use the callback bridge to create and maintain managed local company skills. Agents can create, edit, audit, version, test, comment/star, rename, delete (managed-local only), fork (only reassigning agents they may configure), install from the catalog, update and reset skills; only import and skill-source changes remain unavailable from a sandbox. Sharing scope is always `company` for agents. Files written to Hermes or provider-home paths (`~/.hermes/skills` and `$HERMES_HOME`) are ephemeral and deleted when the run ends; task workspace files and managed local company skills are durable.

**Available Bridge Endpoints**:
- `POST /api/companies/{companyId}/skills` — create a managed local skill.
- `PATCH /api/companies/{companyId}/skills/{skillId}` — update skill details (sharing scope restricted to `company`).
- `PATCH /api/companies/{companyId}/skills/{skillId}/files` — update files (e.g. `SKILL.md` or supporting files).
- `DELETE /api/companies/{companyId}/skills/{skillId}/files` — delete skill files (managed-local skills only).
- `DELETE /api/companies/{companyId}/skills/{skillId}` — delete a skill (managed-local skills only, must be unused by agents).
- `POST /api/companies/{companyId}/skills/{skillId}/fork` — fork a skill (only reassigning agents the caller is authorized to configure).
- `POST /api/companies/{companyId}/skills/{skillId}/rename` — rename a managed-local skill (repointing only agents the caller is authorized to configure).
- `POST /api/companies/{companyId}/skills/{skillId}/test-runs` — create and orchestrate test runs against skills.
- `POST /api/companies/{companyId}/skills/browse-project` and `POST .../skills/scan-projects` — workspace enumeration (requires `project:read` on each project).
- `POST /api/companies/{companyId}/skills/{skillId}/audit` — run security scans on the skill.
- Reads and discovery (`GET .../skills`, `GET .../skills/{skillId}`, `GET .../files`, `fork-precheck`, `versions`, `update-status`, `skill-sources`, `skill-policy`).
- Catalog installation, update, reset, test inputs/templates, test run inspection/cancellation/deletion, stars, and comments.

**Endpoints Not Available in Sandboxes**:
The sandbox bridge deliberately blocks external source imports and skill policy administrative operations: `import` (`POST /api/companies/{companyId}/skills/import`), `skill-sources` mutations (POST/PATCH/DELETE under `/api/companies/{companyId}/skill-sources`), and skill-policy mutations (`PUT/DELETE/POST .../skill-policy*`). If any of these are needed, ask a board user.

**Rules and Workflow**:
- **Task-bound runs and company scope**: Create, file edits, file deletion, skill deletion, audit, and test runs require an active, task-bound run in standard or skill_test mode. Agent-created skills and updates are always company-scoped (`sharingScope: "company"`, rejecting others with 403 `skill_agent_field_restricted`).
- **Managed-local editing and deletion bounds**: Agents can only edit or delete files in managed-local skills (`company/<companyId>/<slug>`). Shared skills return 422 `shared_skill_read_only` (assertSkillNotShared runs before agent guards). Other non-managed skills return 403 `skill_agent_edit_restricted` on file edits and 403 `skill_agent_delete_restricted` on deletion. Deleting a skill while attached to any agent returns 422.
- **Peer agent reassignment guard**: Forking with reassignment or renaming a skill repoints affected agents. For agent actors, each affected agent must be configurable by the caller (`agents:configure` grant for peers, `allow_self` for own agent) else 403 `skill_agent_reassign_restricted` before any mutations occur.
- **Workspace enumeration access**: Project browsing and scanning verify `project:read` authorization on each target project, failing closed with 403 `skill_agent_project_read_restricted` if unreadable.
- **Low-trust denial**: Low-trust agents are denied outright from mutating skill APIs (`403 skill_actor_restricted`).
- **Verbatim execution**: Agent-written executable files and skill content are loaded verbatim by agents the skill is attached to. Only attach skills to other agents deliberately.
- **Metadata from frontmatter**: In managed local skills, `SKILL.md` frontmatter drives name and description. No separate metadata call is needed.
- **Audit before attaching**: After authoring or editing files, call `POST /api/companies/{companyId}/skills/{skillId}/audit` and fix any hard-stop findings before attaching the skill to any agent.
- **Assignment**: Self-attach works via `POST /api/agents/{agentId}/skills/sync` with `mode: "add"`. Attaching the skill to another agent requires the `agents:configure` grant.
- **Per-company opt-out**: Enabled by default; companies can restrict or disallow agent skill creation via an explicit company skill policy rule.
- **Handling 403 Forbidden**: If create, edit, or sync is denied (`403 Forbidden` — for example, low-trust agents, field/reassignment restrictions, or company skill policy restrictions):
  - Do not retry or fall back to saving the skill to local disk or provider home.
  - Report the restriction in your task comment and name the skill content you wanted to save (attach it as a task document).
  - Escalate to a manager agent via `chainOfCommand` first; involve a board user only if no agent in the chain has the permission.

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Custom Skill",
    "description": "What this skill does",
    "markdown": "---\nname: Custom Skill\ndescription: What this skill does\n---\n\n# Custom Skill\n..."
  }'

curl -sS -X POST "$PAPERCLIP_API_URL/api/agents/$PAPERCLIP_AGENT_ID/skills/sync" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "add",
    "desiredSkills": [
      "company/'"$PAPERCLIP_COMPANY_ID"'/custom-skill"
    ]
  }'
```

## Core Endpoints

App-shipped catalog (read-only browse + company install):

- `GET /api/skills/catalog`
- `GET /api/skills/catalog/:catalogId`
- `GET /api/skills/catalog/ref?ref=<id|key|slug>`
- `GET /api/skills/catalog/:catalogId/files?path=SKILL.md`
- `POST /api/companies/:companyId/skills/install-catalog`

Company library:

- `GET /api/companies/:companyId/skills`
- `GET /api/companies/:companyId/skills/:skillId`
- `GET /api/companies/:companyId/skills/:skillId/files?path=SKILL.md`
- `POST /api/companies/:companyId/skills` (managed local create)
- `POST /api/companies/:companyId/skills/import`
- `POST /api/companies/:companyId/skills/scan-projects`
- `GET /api/companies/:companyId/skills/:skillId/update-status`
- `POST /api/companies/:companyId/skills/:skillId/install-update`
- `POST /api/companies/:companyId/skills/:skillId/audit`
- `POST /api/companies/:companyId/skills/:skillId/reset`
- `DELETE /api/companies/:companyId/skills/:skillId`

Agent attach and hire/create composition:

- `GET /api/agents/:agentId/skills`
- `POST /api/agents/:agentId/skills/sync`
- `POST /api/companies/:companyId/agent-hires`
- `POST /api/companies/:companyId/agents`

If a board user, CEO, or manager is driving locally, prefer the
`paperclipai skills` CLI documented in `doc/CLI.md` — it wraps every endpoint
above, accepts company skill or catalog refs by `id`/`key`/`slug`, and prints
the same JSON these endpoints return when called with `--json`.

## Install A Skill Into The Company

Two paths cover the common cases:

1. **App-shipped catalog** (preferred when the right skill exists in the
   bundled/optional catalog) — browse it first, then install with the catalog
   install endpoint. No external network fetch happens.
2. **External source** (skills.sh, GitHub, local path, or URL) — use the
   import endpoint below.

### App-shipped catalog

Browse, inspect, and install catalog skills before reaching for an external
source. Bundled skills are the curated defaults for any company; optional
skills are role- or domain-specific.

```sh
curl -sS "$PAPERCLIP_API_URL/api/skills/catalog?kind=bundled" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/skills/catalog/ref?ref=github-pr-workflow" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/install-catalog" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "catalogSkillId": "paperclipai:bundled:software-development:github-pr-workflow"
  }'
```

The install response records provenance (`catalogId`, `catalogKey`,
`packageVersion`, `originHash`) on the company skill so update/audit/reset
flows know the pinned origin. `force: true` may replace a same-key
catalog-managed skill but never bypasses hard-stop audit findings.

### External source import

Import using a **skills.sh URL**, a key-style source string, a GitHub URL, or a local path.

### Source types (in order of preference)

| Source format | Example | When to use |
|---|---|---|
| **skills.sh URL** | `https://skills.sh/google-labs-code/stitch-skills/design-md` | When a user gives you a `skills.sh` link. This is the managed skill registry — **always prefer it when available**. |
| **Key-style string** | `google-labs-code/stitch-skills/design-md` | Shorthand for the same skill — `org/repo/skill-name` format. Equivalent to the skills.sh URL. |
| **GitHub URL** | `https://github.com/vercel-labs/agent-browser` | When the skill is in a GitHub repo but not on skills.sh. |
| **Local path** | `/abs/path/to/skill-dir` | When the skill is on disk (dev/testing only). |

**Critical:** If a user gives you a `https://skills.sh/...` URL, use that URL or its key-style equivalent (`org/repo/skill-name`) as the `source`. Do **not** convert it to a GitHub URL — skills.sh is the managed registry and the source of truth for versioning, discovery, and updates.

### Example: skills.sh import (preferred)

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://skills.sh/google-labs-code/stitch-skills/design-md"
  }'
```

Or equivalently using the key-style string:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google-labs-code/stitch-skills/design-md"
  }'
```

### Example: GitHub import

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://github.com/vercel-labs/agent-browser"
  }'
```

You can also use source strings such as:

- `google-labs-code/stitch-skills/design-md`
- `vercel-labs/agent-browser/agent-browser`
- `npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser`

If the task is to discover skills from the company project workspaces first:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/scan-projects" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Inspect What Was Installed

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Read the skill entry and its `SKILL.md`:

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/<skill-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/<skill-id>/files?path=SKILL.md" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Assign Skills To An Existing Agent

`desiredSkills` accepts:

- exact company skill key
- exact company skill id
- exact slug when it is unique in the company

The server persists canonical company skill keys.

The request must include a merge mode:

- `add` adds the named skills and keeps every other assignment.
- `remove` removes only the named skills.
- `replace` overwrites the complete desired skill set. Use it only after explicit confirmation.

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/agents/<agent-id>/skills/sync" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "add",
    "desiredSkills": [
      "vercel-labs/agent-browser/agent-browser"
    ]
  }'
```

If you need the current state first:

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/<agent-id>/skills" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Include Skills During Hire Or Create

Use the same company skill keys or references in `desiredSkills` when hiring or creating an agent:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "QA Browser Agent",
    "role": "qa",
    "adapterType": "codex_local",
    "adapterConfig": {
      "cwd": "/abs/path/to/repo"
    },
    "desiredSkills": [
      "agent-browser"
    ]
  }'
```

For direct create without approval:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "QA Browser Agent",
    "role": "qa",
    "adapterType": "codex_local",
    "adapterConfig": {
      "cwd": "/abs/path/to/repo"
    },
    "desiredSkills": [
      "agent-browser"
    ]
  }'
```

## Notes

- Built-in Paperclip runtime skills are still added automatically when required by the adapter.
- If a reference is missing or ambiguous, the API returns `422`.
- Prefer linking back to the relevant issue, approval, and agent when you comment about skill changes.
- Use company portability routes when you need whole-package import/export, not just a skill:
  - `POST /api/companies/:companyId/imports/preview`
  - `POST /api/companies/:companyId/imports/apply`
  - `POST /api/companies/:companyId/exports/preview`
  - `POST /api/companies/:companyId/exports`
- Use skill-only import when the task is specifically to add a skill to the company library without importing the surrounding company/team/package structure.
