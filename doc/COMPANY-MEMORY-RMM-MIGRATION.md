# Legacy Hermes memory → rh-memory-mcp runbook

Copy one Hermes agent's legacy Mem0 memories into external, per-agent
`rh-memory-mcp`. This is **not** the in-place Mem0 flip/drain/verify path:
those gates do not observe it. The legacy company collection stays untouched
as fallback; there is no prune.

See the operations appendix for importer status, rollback, and pilot details.

## Before starting

- Run the read-only census and review source, eligible, dropped, quarantined,
  and cost counts. Confirm `text-embedding-3-small` / 1536 dimensions.
- Run a company sweep in staging and record its cost estimate and totals. The
  converter emits at most 6 records per source. Quarantine halts when more
  than 50 are quarantined, or when quarantines exceed 2% after at least 200
  considered sources. Quarantined, dropped, and unroutable records are not
  exported.
- Confirm the pilot agents are **not enrolled**: no `agent-memory` default-MCP
  entry and no `adapterConfig.memoryProvider` (or `runtimeMemory`) memory
  settings. Enrollment is the cutover: it adds the entry, mints the
  `agent_memory.<agentId>` secret, and the setup hook writes the `MEM0_*` env,
  `memoryProvider=mem0`, and `runtimeMemory=false`. Decide whether to disable
  Hermes auto-sync (`MEM0_AUTO_SYNC=false` is projected); this does not stop
  Claude Code or Codex Stop hooks from capturing.

## Procedure (all pilot agents together)

Set `C`, `A`, `TENANT_DSN`, and `CP_DSN` from the operator's approved secret
store; do not put credentials or memory text in shell history or examples.
The importer writes `user_id` from the manifest's agent id directly and needs
neither that agent's token nor enrollment.

1. **Sweep once, staging only.** Run `pnpm memory:upgrade sweep --database-url "$TENANT_DSN" --control-plane-url "$CP_DSN" --company "$C" --confirm "$C"` with supported budget/model flags. Never run `publish` or `flip`; review totals against the census. One sweep upgrade covers every agent.
2. **Export each agent with records.** For every `A` reported by the sweep, run the export dry run and then confirmed export using the **same explicit `--upgrade-id "$U"`**. Export requires it when upgrades are ambiguous; the one-upgrade-per-agent rule still applies.
3. **Transfer.** These steps read memory text. Keep files in a protected directory, delete them after use, and transfer only through ECS execute-command, never a public bucket:
   `base64 -i export-<agent>.manifest.json | aws ecs execute-command ... "base64 -d > /tmp/export.manifest.json && chmod 0600 /tmp/export.manifest.json"`
   and repeat for JSONL. Use the deployed task/container and approved AWS context.
4. **Import and verify each agent.** In `/repo/services/rh-memory-mcp`, run the dry run, apply, and `--verify --verify-probes 5` for each transferred pair. Use `rh_memory_mcp_prod`/`memories` in production or `rh_memory_mcp`/`memories` in dev. Compare every agent's imported count and verify result with its export and sweep totals; delete `/tmp` files afterwards.
5. **Enrollment dry run.** POST `/api/companies/:companyId/default-mcp/missing-entry-enrollment` with `{"keys":["agent-memory"]}` and record exactly which agents it would enroll. It considers `hermes_local`, `claude_local`, and `codex_local` agents with a `defaultMcp` state; terminated agents are skipped, while paused agents are not specially skipped by this service. Review the report with the operator.
6. **Cut over together.** Only after every agent with legacy records is imported and verified, repeat the POST with `{"dryRun":false,"confirm":"add-missing-default-mcp-entries","keys":["agent-memory"]}`. There is no per-agent filter. Enrolled agents read the new store only; an enrolled agent without imported memories starts empty. Claude Code and Codex enrollment enables capture through the rh-memory-hook Stop hook. Watch errors, latency, rate limits, and recall.

See [migration limits, rollback, pilot, and troubleshooting](./COMPANY-MEMORY-RMM-MIGRATION-OPS.md) before applying or cutting over.
