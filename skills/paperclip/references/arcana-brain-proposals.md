# Proposing documents into your own Arcana brain

Your Arcana brain is read-only (`recall`, `search_pages`, `read_page`, `coverage`, `open_source`). Change it only with the comms board tools `proposals_submit` and `proposals_get`. If they are missing or return `installation_required`, tell your owner; do not work around them.

## What to propose

- **Only full documents**: each proposal is one complete, self-contained markdown document.
- Never propose secrets, credentials, PHI, PII, or facts you would not want a colleague to read. Credentials use the secret-proposals path instead.
- Propose durable knowledge, not status updates or short-lived chatter. Check `coverage`/`search_pages` before choosing a new document.
- The `agent-profile` one-pager is maintained by `agent-profile-upkeep.md`. Keep it factual and short; profile edits are never auto-approved.

## How: `arcana_source_add`

Use this for a new logical document. Check that the `logical_id` is unused, then call `proposals_submit` with `kind: "arcana_source_add"`, a top-level `rationale`, and top-level `confidence`, `importance`, and `impact` (each `low`, `medium`, or `high`). Put the document fields inside `action`; compute `sha256` from the UTF-8 bytes and do not include a `Source document:` line.

```json
"action": {
  "action_type": "source_add",
  "logical_id": "month-end-close",
  "filename": "month-end-close.md",
  "content": "# Month-end close\n\nWe close the books on business day 3. ...",
  "sha256": "<64 hex chars>",
  "target_id": "arcana-source:month-end-close",
  "audience": "private",
  "citations": []
}
```

Required: `action_type`, `logical_id`, `filename` with no `/`, `\`, or `..`, `content`, `sha256`, `target_id` (exactly `arcana-source:` plus `logical_id`), `audience`, and `citations`. A durable workaround while revise is not verified is a new `logical_id` such as `doc-2` or `doc-3`: use `kind: "arcana_source_add"`, `action_type: "source_add"`, set the rationale to identify the current version, and omit `supersedes_revision`. Never mix add and revise fields. The new logical document is readable/searchable, but it does not supersede or remove the old document or update it in place; do not promise that it does. Never use this new-logical-ID workaround for `agent-profile` (no `agent-profile-2`); follow `agent-profile-upkeep.md` and leave existing profile unchanged until real revise works.

For add proposals, `citations` may be `[]`, which sends the proposal to a human. Otherwise each citation is `{"revision_id","offset","length","quote"}` (at most 10); `length` is the quote's character count, and `quote` must exactly match that span. Cross-brain proposals must use `citations: []`.

## How: `arcana_source_revise` (future, readiness-gated)

The revise path is not yet operational. Current `arcana_source_revise` proposals are accepted at submission time, but fail at apply time with `apply_failed` until the end-to-end revision path lands. Use revise only after the full revision path is deployed and verified end-to-end with new DEV proof (readiness verification).

The future-only action is `kind: "arcana_source_revise"`, `action_type: "source_revise"`, `target_id: "arcana-source:<logical_id>"`, complete `content`, and `supersedes_revision` set to the current head revision id (32 lowercase hex characters). Discover the current revision through the actual available search/recall metadata, then call `open_source(revision_id)`; `open_source(logical_id)` is not valid, and opening an old revision does not reopen it as the new head. On `stale`, reread the current head and submit a fresh proposal. Do not mix `source_add` and `source_revise` fields. If documented by the deployed API, the stale conflict code is uppercase `STALE_HEAD`.

## After submitting and approval

Record the returned `proposal_id`; poll `proposals_get` on a later run, not in a loop. `pending`, `applying`, `applied`, `rejected`, `apply_failed`, `stale`, and `withdrawn` are possible outcomes. For `apply_failed`, resubmit once, then tell your owner. A same `(kind, target_id, action_type)` resubmission updates a pending proposal rather than duplicating it. Never assume success before `proposals_get` says `applied`.

Auto-approval, where configured, checks authority, evidence, relevance, and sensitive data. PHI and PII never auto-approve; profile edits are never auto-approved and remain human decisions. Cross-brain proposals may be available depending on configuration (some deployments are not enabled yet); when available, both owners must approve and they are never auto-approved. Preserve the same strict privacy and scope controls as own-brain proposals.
