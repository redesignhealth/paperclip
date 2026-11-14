# rh-memory-mcp migration operations appendix

**Status (13 Nov 2026):** importer PR 12155 is unmerged. The order is code and
review/merge of the GET-by-id service change, importer PR 12155, and PRs 400/401
(401 is merged); then, with Dan's explicit go, dsc-agent2 performs the one
production `rh-memory-mcp` service apply. After that service deployment,
smoke-test `GET /memories/{id}` before any import. Separately, pin one
Paperclip image through dev first, then apply that image in production; the
planned ~5-minute Paperclip downtime requires its own go and is not approved
now. PR 400's final SHA is not known here. No pin, deploy, or production
operation is performed by this runbook owner.

## Guards and exact command source

The exact flags were checked in `cli.py`'s `build_parser` and `target_guards`:
`--expect-schema`, `--expect-collection`, `--expect-db-role`,
`--expect-embed-model`, `--expect-embed-dims`, and production's
`--expect-host-fingerprint`. In an approved operator shell, set only protected
paths/configuration (never secrets in this document):

```bash
GUARDS=(--expect-schema "$SCHEMA" --expect-collection "$COLLECTION" \
  --expect-db-role "$DB_ROLE" --expect-embed-model "$EMBED_MODEL" \
  --expect-embed-dims "$EMBED_DIMS")
COMMON=(--manifest "$MANIFEST" --jsonl "$JSONL" --agent "$AGENT" \
  --output-dir "$OUT")
uv run python -m scripts.import_memories "${COMMON[@]}" "${GUARDS[@]}"
# dry-run: resolved target is logged; expectation guards are not checked.
RH_MEMORY_IMPORT_ALLOWED=true uv run python -m scripts.import_memories \
  "${COMMON[@]}" "${GUARDS[@]}" --expect-host-fingerprint "$HOST_FINGERPRINT" --apply
uv run python -m scripts.import_memories "${COMMON[@]}" --verify
uv run python -m scripts.import_memories "${COMMON[@]}" "${GUARDS[@]}" \
  --expect-host-fingerprint "$HOST_FINGERPRINT" --rollback \
  --migration-id "$MIGRATION_ID" --apply
```

The apply guard checks are the authoritative gate; `--verify` without
`--apply` does not check them. Rollback may add `--ids-file "$IDS_FILE"`.
Resolve every placeholder from approved target configuration. A dry-run host
fingerprint comparison is separate and must use pinned trusted configuration,
not blind copy/paste.

The importer must verify manifest digest, metadata/text counts, ownership, and
errors before apply. Record all results. A zero exit code is not recall proof:
an own-ID probe that misses is WARN ONLY. Operators must inspect and record
hits, then run a fresh-session behavioral recall and isolation check before
claiming recall.

## Transfer gate

Do not document or rely on a piped-stdin `aws ecs execute-command` example; that
method is not rehearsed. Run the importer on an approved
operator host with restricted target access and locally protected,
sha-256-verified files. Alternatively use a separately rehearsed and approved
transport, then verify byte count and sha-256 at the destination **before**
apply. If no proven transport exists, status is **BLOCKED**. Do not fabricate
S3, credential, upload, or test-production commands.

## Pilot, capture, and rollback

The current `dan-costanza` pilot is additive into the already-enrolled five:
Chief of Staff (6,912), CTO (541), and Talent (181) had rows at last census;
ArcQA and LeadDeveloper did not. Recheck before action. The pilot has no
enrollment or unenrollment and no global change. The old tenant is retained;
there is no publish/flip/drain/prune. A production sweep/import requires
separate explicit approval; this document alone authorizes none.

Imported rollback removes only rows identified by provenance (`source`,
`migration_id`, agent, and import key). Ordinary post-cutover memory remains.
It does not switch the backend or alter captures. The pilot needs no
enrollment rollback. Backend restoration is a separate approved change and
requires a complete prior configuration/environment snapshot, secret reference
and version identifiers, and a credential revocation/rotation plan owned by
the service owner. Do not put raw secrets in this runbook. There is no
automatic unenrollment or rollback endpoint.

New Claude/Codex enrollment defaults to capture-off per PR 401; already
enrolled agents retain their existing setting. LeadDeveloper `RH_MEMORY_CAPTURE`
off is a separate, explicit approved config patch after the new image.
Recall-only has no manual-save tool. The Hermes `mem0-auto-sync-off` flag makes
the adapter set `MEM0_AUTO_SYNC=false` to disable end-of-turn auto-sync after
the patched image; explicit Mem0 tools remain available. Preserve existing env
keys.
Enrollment does not enable capture universally.
