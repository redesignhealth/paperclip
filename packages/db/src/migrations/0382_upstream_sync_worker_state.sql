ALTER TABLE "upstream_sync_log" DROP CONSTRAINT "upstream_sync_log_status_check";--> statement-breakpoint
-- HAND-WRITTEN (RED-583, plan RED-580 rev 9 section 1): the status vocabulary
-- changes, so legacy values are remapped BEFORE the new CHECK constraints are
-- added. Only values with an unambiguous successor are remapped; `merged` and
-- `reverted` claimed work that never happened through this worker (nothing
-- wrote them before this migration), so their presence is refused rather than
-- guessed at. In production every row is `pending`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "upstream_sync_log" WHERE "status" IN ('merged', 'reverted')) THEN
    RAISE EXCEPTION 'upstream_sync_log has rows in status merged/reverted; map them by hand before applying 0382';
  END IF;
END
$$;
--> statement-breakpoint
UPDATE "upstream_sync_log" SET "status" = 'pending' WHERE "status" = 'in_progress';
--> statement-breakpoint
UPDATE "upstream_sync_log" SET "status" = 'needs_human' WHERE "status" IN ('conflict', 'needs-human');
--> statement-breakpoint
UPDATE "upstream_sync_log" SET "skip_reason" = 'legacy_status' WHERE "status" = 'skipped' AND "skip_reason" IS NULL;
--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "integration_sha" text;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "resolution_delta_sha256" text;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "review_pr" integer;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "promote_pr" integer;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "master_sha" text;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD COLUMN "argus_rounds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_attempt_check" CHECK ("upstream_sync_log"."attempt" >= 0);--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_claim_check" CHECK (("upstream_sync_log"."status" = 'claimed' and "upstream_sync_log"."claimed_by" is not null and "upstream_sync_log"."claimed_at" is not null and "upstream_sync_log"."lease_expires_at" is not null) or ("upstream_sync_log"."status" <> 'claimed' and "upstream_sync_log"."lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_integration_sha_check" CHECK ("upstream_sync_log"."integration_sha" ~ '^[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_master_sha_check" CHECK ("upstream_sync_log"."master_sha" ~ '^[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_delta_sha256_check" CHECK ("upstream_sync_log"."resolution_delta_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_pr_numbers_check" CHECK (("upstream_sync_log"."review_pr" is null or "upstream_sync_log"."review_pr" > 0) and ("upstream_sync_log"."promote_pr" is null or "upstream_sync_log"."promote_pr" > 0));--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_argus_rounds_check" CHECK (jsonb_typeof("upstream_sync_log"."argus_rounds") = 'array');--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_state_path_check" CHECK ("upstream_sync_log"."status" not in ('assessed', 'in_review', 'integrated', 'promoted') or "upstream_sync_log"."path" is not null);--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_state_integrated_check" CHECK ("upstream_sync_log"."status" not in ('integrated', 'promoted') or ("upstream_sync_log"."integration_sha" is not null and ("upstream_sync_log"."path" = 'conflict') = ("upstream_sync_log"."resolution_delta_sha256" is not null)));--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_state_promoted_check" CHECK ("upstream_sync_log"."status" <> 'promoted' or ("upstream_sync_log"."promote_pr" is not null and "upstream_sync_log"."master_sha" is not null));--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_state_review_check" CHECK ("upstream_sync_log"."status" <> 'in_review' or "upstream_sync_log"."review_pr" is not null);--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_state_skipped_check" CHECK ("upstream_sync_log"."status" <> 'skipped' or "upstream_sync_log"."skip_reason" is not null);--> statement-breakpoint
ALTER TABLE "upstream_sync_log" ADD CONSTRAINT "upstream_sync_log_status_check" CHECK ("upstream_sync_log"."status" in ('pending', 'claimed', 'assessed', 'skipped', 'in_review', 'integrated', 'promoted', 'needs_human', 'failed'));
--> statement-breakpoint
-- HAND-WRITTEN, NOT drizzle-generated. Drizzle does not model roles, grants,
-- functions or triggers, so none of what follows has a snapshot entry.
--
-- Human override role. A session whose login is a member of this role may make
-- any status change on upstream_sync_log (reset a needs_human/failed row,
-- correct a promoted/skipped one); everyone else is held to the transition
-- graph below. NOLOGIN: it is granted to named people, never connected as. The
-- role is cluster-global and may already exist, and on managed Postgres the
-- migration login may lack CREATEROLE: that is not fatal (the guard simply has
-- no override until an operator creates the role), but it must not abort the
-- migration.
DO $$
BEGIN
  IF to_regrole('upstream_sync_human') IS NULL THEN
    CREATE ROLE "upstream_sync_human" NOLOGIN;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'could not create role upstream_sync_human (no CREATEROLE); create it to enable human overrides';
END
$$;
--> statement-breakpoint
-- State machine guard. Trigger functions are not SECURITY DEFINER: they only
-- read the two rows and the caller's role membership.
--
--   pending      -> claimed
--   claimed      -> claimed (lease reclaim/extension), pending (release),
--                   assessed, skipped, needs_human, failed
--   assessed     -> in_review (conflict path), integrated (clean path),
--                   needs_human, failed
--   in_review    -> integrated (conflict path), needs_human, failed
--   integrated   -> promoted, needs_human, failed
--   needs_human, failed, skipped, promoted: no worker transitions out.
--
-- Plus, for non-human sessions: id/upstream_sha never change; an inserted row
-- is `pending`; `attempt` only moves forward (by exactly one on every claim);
-- a lease is taken only on a pending row or one whose lease has expired,
-- claimed_by cannot change while a lease is live, and a lease can be extended
-- but not shortened (every run shares one login, so the trigger cannot tell
-- holders apart; run attribution is the audit trail's job); evidence columns (integration_sha,
-- resolution_delta_sha256, promote_pr, master_sha) are write-once; argus_rounds
-- is append-only; terminal rows (promoted, skipped) change only their alert
-- bookkeeping and prod_pinned_at; `integrated` for a conflict resolution needs
-- an approving Argus verdict bound to the exact integration_sha. Row-level
-- evidence requirements (path, review_pr, promote_pr, master_sha, skip_reason,
-- hash formats) are CHECK constraints, not trigger logic.
CREATE OR REPLACE FUNCTION "upstream_sync_log_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_human boolean := to_regrole('upstream_sync_human') IS NOT NULL
                     AND pg_has_role(session_user, 'upstream_sync_human', 'MEMBER');
  v_old_n int;
  v_last jsonb;
BEGIN
  IF v_human THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.attempt <> 0 OR NEW.claimed_by IS NOT NULL
       OR NEW.integration_sha IS NOT NULL OR NEW.promote_pr IS NOT NULL OR NEW.master_sha IS NOT NULL THEN
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

  -- Write-once evidence.
  IF (OLD.integration_sha IS NOT NULL AND NEW.integration_sha IS DISTINCT FROM OLD.integration_sha)
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
       OR (v_last ->> 'sha') IS DISTINCT FROM NEW.integration_sha THEN
      RAISE EXCEPTION 'upstream_sync_log: a resolved conflict needs an approving Argus verdict on integration_sha %', NEW.integration_sha
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "upstream_sync_log_no_truncate"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'upstream_sync_log cannot be truncated (history lives in upstream_sync_events)'
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "upstream_sync_log_guard_trg"
  BEFORE INSERT OR UPDATE ON "upstream_sync_log"
  FOR EACH ROW EXECUTE FUNCTION "upstream_sync_log_guard"();
--> statement-breakpoint
CREATE TRIGGER "upstream_sync_log_no_truncate_trg"
  BEFORE TRUNCATE ON "upstream_sync_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "upstream_sync_log_no_truncate"();
--> statement-breakpoint
-- Functions are callable by PUBLIC unless revoked; nothing needs to call these
-- directly (triggers do not need EXECUTE at fire time).
REVOKE ALL ON FUNCTION "upstream_sync_log_audit"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "upstream_sync_log_guard"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "upstream_sync_log_no_truncate"() FROM PUBLIC;
--> statement-breakpoint
-- Runner privileges, stated here as well as in the rh-paperclip bootstrap
-- script so that the migration, not a separate script run, is what makes the
-- ledger safe. A no-op where the login does not exist (dev, test, fresh DBs).
-- The runner may read and advance the log, and read the audit trail, and
-- nothing else on these two tables: no DELETE, TRUNCATE, TRIGGER, REFERENCES,
-- no INSERT/UPDATE/DELETE on events, and it must not OWN either table (owning
-- is what would let it disable or drop the guard and audit triggers).
DO $$
DECLARE
  v_owner text;
BEGIN
  IF to_regrole('upstream_sync_runner') IS NULL THEN
    RETURN;
  END IF;

  SELECT c.relname || ' (' || pg_get_userbyid(c.relowner) || ')' INTO v_owner
    FROM pg_class c
   WHERE c.oid IN (to_regclass('upstream_sync_log'), to_regclass('upstream_sync_events'))
     AND pg_get_userbyid(c.relowner) = 'upstream_sync_runner'
   LIMIT 1;
  IF v_owner IS NOT NULL THEN
    RAISE EXCEPTION 'upstream_sync_runner owns %; it must not own the ledger tables', v_owner;
  END IF;

  REVOKE ALL ON "upstream_sync_log" FROM "upstream_sync_runner";
  GRANT SELECT, INSERT, UPDATE ON "upstream_sync_log" TO "upstream_sync_runner";
  REVOKE ALL ON "upstream_sync_events" FROM "upstream_sync_runner";
  GRANT SELECT ON "upstream_sync_events" TO "upstream_sync_runner";
  GRANT USAGE, SELECT ON SEQUENCE "upstream_sync_log_id_seq" TO "upstream_sync_runner";
END
$$;
