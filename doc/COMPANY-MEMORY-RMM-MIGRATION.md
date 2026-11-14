# Legacy Hermes memory → rh-memory-mcp runbook

This runbook covers an additive import into external, per-agent
`rh-memory-mcp`. It is **not** the in-place Mem0 flip/drain/verify path. The
old tenant remains the fallback: do not publish, flip, drain, prune, or run an
external production sweep/import from this runbook without separate explicit
approval. A staging sweep writes only staging data and spends its approved LLM
budget; the source collection remains unchanged.

See the [operations appendix](./COMPANY-MEMORY-RMM-MIGRATION-OPS.md) for the
import contract, guards, rollback, and verification requirements.

## Current pilot: already-enrolled five

Production `dan-costanza` already has Chief of Staff, CTO, Talent, ArcQA, and
LeadDeveloper enrolled by dsc-agent2. **Do not enroll or unenroll anyone.**
Do not use the company-wide missing-entry endpoint: it can enroll other
agents. This pilot makes no global configuration change and does not enable
capture universally. There has been no production sweep or import by us.

At the last census only these three had legacy rows: Chief of Staff (6,912),
CTO (541), and Talent (181). ArcQA and LeadDeveloper had no legacy rows;
recheck the census immediately before any action and import only confirmed
rows. A later census may change that result.

The pilot is additive: import into the already-enrolled five's target, then
verify. It does not change enrollment, capture settings, the old tenant, or
the external backend selection. The coordinated plan is code/review and merge
of the GET-by-id service change, importer PR 12155, and PRs 400/401 (401 is
merged); then, with Dan's explicit go, dsc-agent2 performs the one production
`rh-memory-mcp` service apply. After that service deployment, smoke-test
`GET /memories/{id}` before any import. Separately, pin one Paperclip image
through dev first, then apply that image in production; the planned ~5-minute
Paperclip downtime requires its own go and is not approved now. PR 400's final
SHA is not known here. No pin or deployment is performed by this runbook owner.

## Future generic path (not the current pilot)

For a future **new** agent, import-before-enroll is a separate, explicitly
approved path: census → staging sweep → unpublished export → protected
transfer → guarded import/verify → separately reviewed enrollment. Never
generalize that path to a company-wide enrollment call. Enrollment and
unenrollment require their own change and approval.

## Safe sequence

1. Recheck census counts, target enrollment, schema/collection/role/model
   configuration, and the service deployment smoke check.
2. Run a staging sweep and export only its unpublished upgrade, using the
   exact `--upgrade-id`. Never publish, flip, drain, or prune. `source upgrade`
   must remain `new sweep → export`, never a published upgrade.
3. Keep manifest/JSONL in a protected, local directory. Use an approved
   operator host with restricted target access, or a separately rehearsed and
   approved transport. Otherwise the operation is BLOCKED. See the appendix's
   transfer gate.
4. From the importer source, use `uv run python -m scripts.import_memories`
   for dry-run, apply, and verification, with every target guard explicitly
   supplied. Do not invent flags; inspect the checked-out CLI help/source.
5. Record counts, errors, metadata/text verification, and operator-approved
   recall probes. A zero exit code is not recall proof. Delete protected
   working files after retention requirements are met.

No production apply, enrollment change, backend flip, or rollback is implied
by this document.
