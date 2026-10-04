SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE TABLE "agent_knowledge_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"agent_id_snapshot" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"desired_access" text DEFAULT 'active' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"principal_id" text,
	"brain_id" text,
	"fence_epoch" integer DEFAULT 1 NOT NULL,
	"last_error_code" text,
	"created_by_actor_type" text DEFAULT 'system' NOT NULL,
	"created_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_knowledge_bindings_agent_id_snapshot_check" CHECK ("agent_knowledge_bindings"."agent_id" IS NULL OR "agent_knowledge_bindings"."agent_id" = "agent_knowledge_bindings"."agent_id_snapshot"),
	CONSTRAINT "agent_knowledge_bindings_desired_access_check" CHECK ("agent_knowledge_bindings"."desired_access" in ('active', 'suspended', 'revoked')),
	CONSTRAINT "agent_knowledge_bindings_state_check" CHECK ("agent_knowledge_bindings"."state" in ('pending', 'suspended', 'revoking', 'revoked', 'failed')),
	CONSTRAINT "agent_knowledge_bindings_fence_epoch_check" CHECK ("agent_knowledge_bindings"."fence_epoch" >= 0),
	CONSTRAINT "agent_knowledge_bindings_last_error_code_check" CHECK ("agent_knowledge_bindings"."last_error_code" IS NULL OR "agent_knowledge_bindings"."last_error_code" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "agent_knowledge_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"agent_id_snapshot" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"principal_id_snapshot" text,
	"brain_id_snapshot" text,
	"fence_epoch" integer NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"stalled_at" timestamp with time zone,
	CONSTRAINT "agent_knowledge_revocations_agent_id_snapshot_check" CHECK ("agent_knowledge_revocations"."agent_id" IS NULL OR "agent_knowledge_revocations"."agent_id" = "agent_knowledge_revocations"."agent_id_snapshot"),
	CONSTRAINT "agent_knowledge_revocations_status_check" CHECK ("agent_knowledge_revocations"."status" in ('pending', 'confirmed', 'stalled')),
	CONSTRAINT "agent_knowledge_revocations_reason_check" CHECK ("agent_knowledge_revocations"."reason" in ('agent_terminated', 'agent_removed', 'company_removed', 'manual_revocation', 'policy_revoked')),
	CONSTRAINT "agent_knowledge_revocations_fence_epoch_check" CHECK ("agent_knowledge_revocations"."fence_epoch" >= 0),
	CONSTRAINT "agent_knowledge_revocations_last_error_code_check" CHECK ("agent_knowledge_revocations"."last_error_code" IS NULL OR "agent_knowledge_revocations"."last_error_code" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "agent_knowledge_bindings" ADD CONSTRAINT "agent_knowledge_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_bindings" ADD CONSTRAINT "agent_knowledge_bindings_company_id_id_uq" UNIQUE ("company_id","id");--> statement-breakpoint
ALTER TABLE "agent_knowledge_revocations" ADD CONSTRAINT "agent_knowledge_revocations_binding_id_agent_knowledge_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."agent_knowledge_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_revocations" ADD CONSTRAINT "agent_knowledge_revocations_company_id_binding_id_fk" FOREIGN KEY ("company_id","binding_id") REFERENCES "public"."agent_knowledge_bindings"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_revocations" ADD CONSTRAINT "agent_knowledge_revocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_knowledge_bindings_company_agent_snapshot_uq" ON "agent_knowledge_bindings" USING btree ("company_id","agent_id_snapshot");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_knowledge_bindings_idempotency_key_uq" ON "agent_knowledge_bindings" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_knowledge_bindings_company_id_idx" ON "agent_knowledge_bindings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_bindings_agent_id_idx" ON "agent_knowledge_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_bindings_state_idx" ON "agent_knowledge_bindings" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_knowledge_revocations_binding_id_uq" ON "agent_knowledge_revocations" USING btree ("binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_knowledge_revocations_idempotency_key_uq" ON "agent_knowledge_revocations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_knowledge_revocations_company_id_idx" ON "agent_knowledge_revocations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_revocations_agent_id_idx" ON "agent_knowledge_revocations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_revocations_status_idx" ON "agent_knowledge_revocations" USING btree ("status");--> statement-breakpoint
ALTER TABLE "agent_knowledge_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_knowledge_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_knowledge_bindings";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_knowledge_bindings" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "agent_knowledge_revocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_knowledge_revocations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "agent_knowledge_revocations";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_knowledge_revocations" FOR ALL USING (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid) WITH CHECK (nullif(current_setting('app.current_company_id', true), '') IS NULL OR "company_id" = nullif(current_setting('app.current_company_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_enforce_agent_knowledge_binding_invariants()
RETURNS trigger AS $$
DECLARE
	v_agent_company_id uuid;
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
			RAISE EXCEPTION 'agent_knowledge_bindings company_id is immutable';
		END IF;
		IF NEW.agent_id_snapshot IS DISTINCT FROM OLD.agent_id_snapshot THEN
			RAISE EXCEPTION 'agent_knowledge_bindings agent_id_snapshot is immutable';
		END IF;
		IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
			RAISE EXCEPTION 'agent_knowledge_bindings idempotency_key is immutable';
		END IF;
		IF OLD.agent_id IS NOT NULL AND NEW.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
			RAISE EXCEPTION 'agent_knowledge_bindings agent_id cannot be reassigned to another agent';
		END IF;
		IF OLD.agent_id IS NULL AND NEW.agent_id IS NOT NULL THEN
			RAISE EXCEPTION 'agent_knowledge_bindings agent_id cannot be rebound on tombstone';
		END IF;
		IF OLD.principal_id IS NOT NULL AND NEW.principal_id IS DISTINCT FROM OLD.principal_id THEN
			RAISE EXCEPTION 'agent_knowledge_bindings principal_id is immutable once set';
		END IF;
		IF OLD.brain_id IS NOT NULL AND NEW.brain_id IS DISTINCT FROM OLD.brain_id THEN
			RAISE EXCEPTION 'agent_knowledge_bindings brain_id is immutable once set';
		END IF;
		IF OLD.desired_access = 'revoked' AND NEW.desired_access IS DISTINCT FROM 'revoked' THEN
			RAISE EXCEPTION 'agent_knowledge_bindings desired_access cannot be changed once revoked';
		END IF;
		IF OLD.state = 'revoked' AND NEW.state IS DISTINCT FROM 'revoked' THEN
			RAISE EXCEPTION 'agent_knowledge_bindings state cannot be changed once revoked';
		END IF;
		IF NEW.fence_epoch < OLD.fence_epoch THEN
			RAISE EXCEPTION 'agent_knowledge_bindings fence_epoch cannot decrease';
		END IF;
	END IF;

	IF NEW.agent_id IS NOT NULL THEN
		SELECT company_id INTO v_agent_company_id FROM agents WHERE id = NEW.agent_id;
		IF v_agent_company_id IS NULL OR v_agent_company_id IS DISTINCT FROM NEW.company_id THEN
			RAISE EXCEPTION 'agent_knowledge_bindings agent company_id does not match binding company_id';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_knowledge_binding_invariants_trigger ON "agent_knowledge_bindings";--> statement-breakpoint
CREATE TRIGGER paperclip_agent_knowledge_binding_invariants_trigger
BEFORE INSERT OR UPDATE ON "agent_knowledge_bindings"
FOR EACH ROW EXECUTE FUNCTION paperclip_enforce_agent_knowledge_binding_invariants();--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_enforce_agent_knowledge_revocation_invariants()
RETURNS trigger AS $$
DECLARE
	v_binding_agent_snapshot uuid;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT agent_id_snapshot INTO v_binding_agent_snapshot
		FROM agent_knowledge_bindings WHERE id = NEW.binding_id;
		IF v_binding_agent_snapshot IS NOT NULL AND v_binding_agent_snapshot IS DISTINCT FROM NEW.agent_id_snapshot THEN
			RAISE EXCEPTION 'agent_knowledge_revocations agent_id_snapshot does not match binding agent_id_snapshot';
		END IF;
	END IF;

	IF TG_OP = 'UPDATE' THEN
		IF NEW.id IS DISTINCT FROM OLD.id THEN
			RAISE EXCEPTION 'agent_knowledge_revocations id is immutable';
		END IF;
		IF NEW.binding_id IS DISTINCT FROM OLD.binding_id THEN
			RAISE EXCEPTION 'agent_knowledge_revocations binding_id is immutable';
		END IF;
		IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
			RAISE EXCEPTION 'agent_knowledge_revocations company_id is immutable';
		END IF;
		IF NEW.agent_id_snapshot IS DISTINCT FROM OLD.agent_id_snapshot THEN
			RAISE EXCEPTION 'agent_knowledge_revocations agent_id_snapshot is immutable';
		END IF;
		IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
			RAISE EXCEPTION 'agent_knowledge_revocations idempotency_key is immutable';
		END IF;
		IF NEW.reason IS DISTINCT FROM OLD.reason THEN
			RAISE EXCEPTION 'agent_knowledge_revocations reason is immutable';
		END IF;
		IF NEW.fence_epoch IS DISTINCT FROM OLD.fence_epoch THEN
			RAISE EXCEPTION 'agent_knowledge_revocations fence_epoch is immutable';
		END IF;
		IF OLD.agent_id IS NOT NULL AND NEW.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
			RAISE EXCEPTION 'agent_knowledge_revocations agent_id cannot be reassigned to another agent';
		END IF;
		IF OLD.agent_id IS NULL AND NEW.agent_id IS NOT NULL THEN
			RAISE EXCEPTION 'agent_knowledge_revocations agent_id cannot be rebound on tombstone';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_knowledge_revocation_invariants_trigger ON "agent_knowledge_revocations";--> statement-breakpoint
CREATE TRIGGER paperclip_agent_knowledge_revocation_invariants_trigger
BEFORE INSERT OR UPDATE ON "agent_knowledge_revocations"
FOR EACH ROW EXECUTE FUNCTION paperclip_enforce_agent_knowledge_revocation_invariants();--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_enforce_agent_company_immutability_for_knowledge()
RETURNS trigger AS $$
BEGIN
	IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
		IF EXISTS (
			SELECT 1 FROM agent_knowledge_bindings
			WHERE agent_id_snapshot = OLD.id OR agent_id = OLD.id
		) THEN
			RAISE EXCEPTION 'agents company_id cannot be changed for agents with knowledge bindings';
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_company_immutability_for_knowledge_trigger ON "agents";--> statement-breakpoint
CREATE TRIGGER paperclip_agent_company_immutability_for_knowledge_trigger
BEFORE UPDATE OF "company_id" ON "agents"
FOR EACH ROW EXECUTE FUNCTION paperclip_enforce_agent_company_immutability_for_knowledge();--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_prevent_agent_knowledge_ledger_delete()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'deletion of % rows is forbidden (immutable audit ledger)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_knowledge_bindings_no_delete ON "agent_knowledge_bindings";--> statement-breakpoint
CREATE TRIGGER paperclip_agent_knowledge_bindings_no_delete
BEFORE DELETE ON "agent_knowledge_bindings"
FOR EACH ROW EXECUTE FUNCTION paperclip_prevent_agent_knowledge_ledger_delete();--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_knowledge_bindings_no_truncate ON "agent_knowledge_bindings";--> statement-breakpoint
CREATE TRIGGER paperclip_agent_knowledge_bindings_no_truncate
BEFORE TRUNCATE ON "agent_knowledge_bindings"
FOR EACH STATEMENT EXECUTE FUNCTION paperclip_prevent_agent_knowledge_ledger_delete();--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_knowledge_revocations_no_delete ON "agent_knowledge_revocations";--> statement-breakpoint
CREATE TRIGGER paperclip_agent_knowledge_revocations_no_delete
BEFORE DELETE ON "agent_knowledge_revocations"
FOR EACH ROW EXECUTE FUNCTION paperclip_prevent_agent_knowledge_ledger_delete();--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_agent_knowledge_revocations_no_truncate ON "agent_knowledge_revocations";--> statement-breakpoint
CREATE TRIGGER paperclip_agent_knowledge_revocations_no_truncate
BEFORE TRUNCATE ON "agent_knowledge_revocations"
FOR EACH STATEMENT EXECUTE FUNCTION paperclip_prevent_agent_knowledge_ledger_delete();
