# rh-memory-mcp migration operations appendix

**Import status (13 Nov 2026):** the importer is in this [unmerged PR](https://github.com/redesignhealth/rh-data-platform/pull/12155).
Do not run production imports until it is merged and deployed; update these
links and commands when its path or interface changes. Deploy an image with
the export command and Hermes patch
`docker/hermes/patches/0002-mem0-auto-sync.patch`; production runs
`sha-8e09ce0e53` at this writing, which predates both. Rehearse in dev, obtain
explicit operator approval before every production step, and record outcomes
in the migration tracking record.

## Rules and rollback

There is one upgrade per agent. `import_key` is the staging `output_id`, so
two upgrades duplicate records. Export refuses any published staging row,
requires `--upgrade-id` when ambiguous, and fails rather than truncating text
over 2,000 characters. The importer validates the manifest/digest, takes a
per-agent Postgres advisory lock, and applies its per-agent rate limits.

Import rollback is DB-driven. From `/repo/services/rh-memory-mcp`, run
`RH_MEMORY_IMPORT_ALLOWED=true uv run python -m scripts.import_memories
--rollback --agent "$A" --migration-id "$M" --expect-schema
<environment-schema> --expect-collection memories --apply`; use
`rh_memory_mcp_prod` in production or `rh_memory_mcp` in dev. It selects by
agent, `migration_id`, source marker, and `import_key`; an optional
`--ids-file` restricts deletion to IDs also present in the manifest. Memories
written by the agent after cutover live only in the new store and are lost if
this import rollback deletes them.

Cutover rollback is un-enrollment: restore the prior
`adapterConfig.memoryProvider`/`runtimeMemory` and remove the `MEM0_*` env
keys for every enrolled agent. There is no company-wide removal endpoint: use
`PATCH /api/agents/:id` for each agent, sending the complete saved
`adapterConfig` and metadata with the `defaultMcp.entries.agent-memory` entry
removed while preserving all unrelated entries and env keys. PATCH replaces
`adapterConfig.env` wholesale, so resend every other required key. The old
company collection was never changed. The single-agent enrollment option does
not exist today; adding an agent filter to the enrollment route would require
a small code change (not done here).

## Pilot and interpretation

Rehearse first in dev, then pilot `dan-costanza` company
`a70caa24-5b99-432e-b1da-9a9eb063cb29`. Import smallest first: Talent
`093f60c1-e242-4b50-892e-fe041cce578b` (181 rows), CTO
`df8dd07a-e5a6-45c5-bcf9-aea201cd360a` (541), Chief of Staff
`5e9b141f-af96-4792-a197-fe83d7f872e2` (6,912). Cut over all together in one
enrollment call. Other eligible agents may exist: the enrollment dry run is
the source of truth and must be reviewed with the operator. Each production
action needs operator go-ahead; record results in the migration tracking
record.

Importer verification proves file integrity, exact imported fields, ownership,
and sampled recall. It does not prove complete recall quality, hook coverage,
or the old drain/verify gates; those gates observe the legacy in-place path.

## Troubleshooting

| Code | Action |
|---|---|
| `EXPORT_UPGRADE_ALREADY_PUBLISHED` | Stop; use an unpublished staging upgrade. |
| `AMBIGUOUS_UPGRADE` | Re-run with the exact `--upgrade-id`. |
| `IMPORTER_CONTRACT_VIOLATION` | Stop; inspect sweep/export data; never bypass validation. |
| `UPGRADE_TABLES_MISSING` | Run sweep first; do not create tables manually. |
| `AGENT_NOT_FOUND` / `AGENT_INELIGIBLE` | Verify company, agent, and enrollment. |
| `OUTPUT_PATH_REJECTED` | Use an existing external directory, never the repository. |
| Import validation, schema, collection, lock, or rate-limit error | Do not apply twice; correct deployment/guards, then rerun the dry run. |

References: [TECH-8571](https://linear.app/redesign/issue/TECH-8571), [TECH-8572](https://linear.app/redesign/issue/TECH-8572), [TECH-8573](https://linear.app/redesign/issue/TECH-8573), [TECH-8574](https://linear.app/redesign/issue/TECH-8574), [TECH-8575](https://linear.app/redesign/issue/TECH-8575).
