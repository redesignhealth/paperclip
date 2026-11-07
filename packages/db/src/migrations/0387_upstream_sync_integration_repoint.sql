CREATE TABLE "upstream_sync_integration_repoints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"log_id" bigint NOT NULL,
	"upstream_sha" text NOT NULL,
	"old_integration_sha" text NOT NULL,
	"new_integration_sha" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"run_ref" text,
	"txid" bigint DEFAULT txid_current() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upstream_sync_repoints_sha_check" CHECK ("upstream_sync_integration_repoints"."old_integration_sha" ~ '^[0-9a-f]{40}$' and "upstream_sync_integration_repoints"."new_integration_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "upstream_sync_repoints_changed_check" CHECK ("upstream_sync_integration_repoints"."old_integration_sha" <> "upstream_sync_integration_repoints"."new_integration_sha"),
	CONSTRAINT "upstream_sync_repoints_reason_check" CHECK (btrim("upstream_sync_integration_repoints"."reason") <> '')
);
--> statement-breakpoint
CREATE INDEX "upstream_sync_repoints_log_idx" ON "upstream_sync_integration_repoints" USING btree ("log_id","id");
--> statement-breakpoint
-- HAND-WRITTEN, NOT drizzle-generated (RED-874). Drizzle does not model
-- functions, triggers or grants, so none of what follows has a snapshot entry.
--
-- Audited re-point of upstream_sync_log.integration_sha. The column is
-- write-once (0382 guard) so that a worker cannot quietly rewrite merge
-- evidence, but a squash or a late ancestry PR legitimately changes the
-- integration commit that contains an upstream sha. This is the ONE door:
--   * upstream_sync_repoint_integration_sha() is SECURITY DEFINER; it writes an
--     audit row and then changes integration_sha, nothing else.
--   * The guard trigger lets an integration_sha change through only when
--     (a) it is the only column that changed and (b) an audit row for exactly
--     that old -> new change was inserted by THIS transaction. The audit table is
--     writable only through this function (the runner has SELECT, no INSERT), so
--     a plain UPDATE, or an UPDATE with a forged setting, is still refused.
-- The database cannot read git, so it cannot check ancestry. The tool
-- (tools/upstream-sync `repoint`) verifies, against the repository, that the new
-- sha descends from the old one and contains the upstream sha before it calls
-- this function. A caller that reaches SQL directly skips that check; it is still
-- audited (actor = session_user) and limited to a clean `integrated` row.
CREATE OR REPLACE FUNCTION "upstream_sync_repoint_integration_sha"(
  p_log_id bigint, p_expected_old text, p_new text, p_reason text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row upstream_sync_log%ROWTYPE;
  v_id bigint;
BEGIN
  SELECT * INTO v_row FROM upstream_sync_log WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upstream_sync_repoint: no ledger row %', p_log_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status <> 'integrated' THEN
    RAISE EXCEPTION 'upstream_sync_repoint: row % is % (only an integrated row can be re-pointed)', p_log_id, v_row.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.resolution_delta_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'upstream_sync_repoint: row % is a conflict resolution; its Argus verdict is bound to the old integration_sha, so a human must re-point it', p_log_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_row.integration_sha IS DISTINCT FROM p_expected_old THEN
    RAISE EXCEPTION 'upstream_sync_repoint: row % integration_sha is %, not the expected %', p_log_id, v_row.integration_sha, p_expected_old
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_new IS NULL OR p_new !~ '^[0-9a-f]{40}$' OR p_new = v_row.integration_sha THEN
    RAISE EXCEPTION 'upstream_sync_repoint: new sha must be a different 40-hex commit' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'upstream_sync_repoint: a reason is required' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO upstream_sync_integration_repoints
    (log_id, upstream_sha, old_integration_sha, new_integration_sha, actor, reason, run_ref)
  VALUES
    (v_row.id, v_row.upstream_sha, v_row.integration_sha, p_new, session_user::text, p_reason,
     nullif(current_setting('upstream_sync.run_ref', true), ''))
  RETURNING id INTO v_id;

  UPDATE upstream_sync_log SET integration_sha = p_new, updated_at = now() WHERE id = v_row.id;
  RETURN v_id;
END
$$;
--> statement-breakpoint
-- Resolve the ledger's own tables through the schema the migration ran in (public in
-- production, a scratch schema in tests), behind pg_catalog so no built-in can be shadowed.
DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION upstream_sync_repoint_integration_sha(bigint, text, text, text) SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "upstream_sync_repoints_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'upstream_sync_integration_repoints is append-only (% is not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "upstream_sync_repoints_immutable_trg"
  BEFORE UPDATE OR DELETE ON "upstream_sync_integration_repoints"
  FOR EACH ROW EXECUTE FUNCTION "upstream_sync_repoints_immutable"();
--> statement-breakpoint
CREATE TRIGGER "upstream_sync_repoints_no_truncate_trg"
  BEFORE TRUNCATE ON "upstream_sync_integration_repoints"
  FOR EACH STATEMENT EXECUTE FUNCTION "upstream_sync_repoints_immutable"();
--> statement-breakpoint
-- The guard, as in 0382, with one change: the write-once check on integration_sha
-- is waived for a change that is covered by an audit row from this transaction and
-- touches no other column. resolution_delta_sha256, promote_pr and master_sha stay
-- strictly write-once.
CREATE OR REPLACE FUNCTION "upstream_sync_log_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_human boolean := to_regrole('upstream_sync_human') IS NOT NULL
                     AND pg_has_role(session_user, 'upstream_sync_human', 'MEMBER');
  v_old_n int;
  v_last jsonb;
  v_repoint boolean := false;
BEGIN
  IF v_human THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.attempt <> 0 OR NEW.claimed_by IS NOT NULL
       OR NEW.integration_sha IS NOT NULL OR NEW.resolution_delta_sha256 IS NOT NULL
       OR NEW.review_pr IS NOT NULL OR NEW.promote_pr IS NOT NULL OR NEW.master_sha IS NOT NULL
       OR jsonb_array_length(NEW.argus_rounds) > 0 THEN
      RAISE EXCEPTION 'upstream_sync_log: a new row must be pending and carry no worker state'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.upstream_sha IS DISTINCT FROM OLD.upstream_sha THEN
    RAISE EXCEPTION 'upstream_sync_log: id and upstream_sha are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'upstream_sync_log: attempt cannot decrease' USING ERRCODE = 'check_violation';
  END IF;

  -- Audited re-point of integration_sha (RED-874): exactly this column, exactly the
  -- old -> new change an audit row of this transaction records, on an integrated row.
  IF OLD.integration_sha IS NOT NULL AND NEW.integration_sha IS DISTINCT FROM OLD.integration_sha
     AND NEW.status = 'integrated' AND OLD.status = 'integrated'
     AND (to_jsonb(NEW) - 'updated_at' - 'integration_sha')
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - 'updated_at' - 'integration_sha') THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.upstream_sync_integration_repoints '
      ' WHERE log_id = $1 AND old_integration_sha = $2 AND new_integration_sha = $3 AND txid = txid_current())',
      TG_TABLE_SCHEMA
    ) INTO v_repoint USING OLD.id, OLD.integration_sha, NEW.integration_sha;
  END IF;

  -- Write-once evidence.
  IF (OLD.integration_sha IS NOT NULL AND NEW.integration_sha IS DISTINCT FROM OLD.integration_sha AND NOT v_repoint)
     OR (OLD.resolution_delta_sha256 IS NOT NULL AND NEW.resolution_delta_sha256 IS DISTINCT FROM OLD.resolution_delta_sha256)
     OR (OLD.promote_pr IS NOT NULL AND NEW.promote_pr IS DISTINCT FROM OLD.promote_pr)
     OR (OLD.master_sha IS NOT NULL AND NEW.master_sha IS DISTINCT FROM OLD.master_sha) THEN
    RAISE EXCEPTION 'upstream_sync_log: integration_sha, resolution_delta_sha256, promote_pr and master_sha are write-once'
      USING ERRCODE = 'check_violation';
  END IF;

  -- argus_rounds is append-only: the old array must be an exact prefix of the new one.
  v_old_n := jsonb_array_length(OLD.argus_rounds);
  IF jsonb_array_length(NEW.argus_rounds) < v_old_n
     OR (v_old_n > 0 AND (
           SELECT jsonb_agg(t.v ORDER BY t.o)
             FROM jsonb_array_elements(NEW.argus_rounds) WITH ORDINALITY AS t(v, o)
            WHERE t.o <= v_old_n
         ) IS DISTINCT FROM OLD.argus_rounds) THEN
    RAISE EXCEPTION 'upstream_sync_log: argus_rounds is append-only' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = OLD.status THEN
    -- Terminal rows keep only their alert bookkeeping and the prod pin time.
    IF OLD.status IN ('promoted', 'skipped')
       AND (to_jsonb(NEW) - 'updated_at' - 'alert_state' - 'alerted_at' - 'prod_pinned_at')
           IS DISTINCT FROM
           (to_jsonb(OLD) - 'updated_at' - 'alert_state' - 'alerted_at' - 'prod_pinned_at') THEN
      RAISE EXCEPTION 'upstream_sync_log: a % row is final', OLD.status USING ERRCODE = 'check_violation';
    END IF;
    -- A live lease keeps its holder and can only be extended; an expired one is a new attempt.
    IF OLD.status = 'claimed'
       AND (NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
            OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
            OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
            OR NEW.attempt IS DISTINCT FROM OLD.attempt) THEN
      IF OLD.lease_expires_at >= now() THEN
        -- Live lease: only an extension is legal.
        IF NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
           OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
           OR NEW.attempt IS DISTINCT FROM OLD.attempt
           OR NEW.lease_expires_at <= OLD.lease_expires_at THEN
          RAISE EXCEPTION 'upstream_sync_log: row % is leased to % until %', OLD.id, OLD.claimed_by, OLD.lease_expires_at
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        -- Expired lease: reclaim, which is a new attempt.
        IF NEW.attempt <> OLD.attempt + 1 OR NEW.lease_expires_at <= now() THEN
          RAISE EXCEPTION 'upstream_sync_log: reclaiming row % must be attempt % with a future lease', OLD.id, OLD.attempt + 1
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    ELSIF NEW.attempt IS DISTINCT FROM OLD.attempt THEN
      RAISE EXCEPTION 'upstream_sync_log: attempt only changes when a row is claimed'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Status change: must be an edge of the graph.
  IF NOT (
       (OLD.status = 'pending'    AND NEW.status = 'claimed')
    OR (OLD.status = 'claimed'    AND NEW.status IN ('pending', 'assessed', 'skipped', 'needs_human', 'failed'))
    OR (OLD.status = 'assessed'   AND NEW.status IN ('in_review', 'integrated', 'needs_human', 'failed'))
    OR (OLD.status = 'in_review'  AND NEW.status IN ('integrated', 'needs_human', 'failed'))
    OR (OLD.status = 'integrated' AND NEW.status IN ('promoted', 'needs_human', 'failed'))
  ) THEN
    RAISE EXCEPTION 'upstream_sync_log: illegal transition % -> % for row %', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'claimed' THEN
    IF NEW.attempt <> OLD.attempt + 1 OR NEW.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'upstream_sync_log: a claim must be attempt % with a future lease', OLD.attempt + 1
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.attempt IS DISTINCT FROM OLD.attempt THEN
    RAISE EXCEPTION 'upstream_sync_log: attempt only changes when a row is claimed'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Path discipline: a conflict resolution is reviewed before it lands, a clean merge is not.
  IF NEW.status = 'in_review' AND NEW.path IS DISTINCT FROM 'conflict' THEN
    RAISE EXCEPTION 'upstream_sync_log: only a conflict path goes to in_review' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'integrated' AND OLD.status = 'assessed' AND NEW.path IS DISTINCT FROM 'clean' THEN
    RAISE EXCEPTION 'upstream_sync_log: a conflict path must pass in_review before integrated' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'integrated' AND OLD.status = 'in_review' AND NEW.path IS DISTINCT FROM 'conflict' THEN
    RAISE EXCEPTION 'upstream_sync_log: only a conflict path passes through in_review' USING ERRCODE = 'check_violation';
  END IF;

  -- An integrated resolution needs an approving Argus verdict on the exact merge commit.
  IF NEW.status = 'integrated' AND NEW.resolution_delta_sha256 IS NOT NULL THEN
    v_last := CASE WHEN jsonb_array_length(NEW.argus_rounds) > 0
                   THEN NEW.argus_rounds -> (jsonb_array_length(NEW.argus_rounds) - 1) END;
    IF lower(coalesce(NEW.argus_verdict, '')) <> 'approve'
       OR v_last IS NULL
       OR lower(coalesce(v_last ->> 'verdict', '')) <> 'approve'
       OR lower(coalesce(v_last ->> 'sha', '')) IS DISTINCT FROM NEW.integration_sha THEN
      RAISE EXCEPTION 'upstream_sync_log: a resolved conflict needs an approving Argus verdict on integration_sha %', NEW.integration_sha
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "upstream_sync_repoint_integration_sha"(bigint, text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "upstream_sync_repoints_immutable"() FROM PUBLIC;
--> statement-breakpoint
-- Runner: may call the re-point function and read the audit rows (the guard reads
-- them as the invoker); no INSERT/UPDATE/DELETE on them. No-op where the login does not exist.
DO $$
BEGIN
  IF to_regrole('upstream_sync_runner') IS NULL THEN
    RETURN;
  END IF;
  REVOKE ALL ON "upstream_sync_integration_repoints" FROM "upstream_sync_runner";
  GRANT SELECT ON "upstream_sync_integration_repoints" TO "upstream_sync_runner";
  GRANT EXECUTE ON FUNCTION "upstream_sync_repoint_integration_sha"(bigint, text, text, text) TO "upstream_sync_runner";
END
$$;
