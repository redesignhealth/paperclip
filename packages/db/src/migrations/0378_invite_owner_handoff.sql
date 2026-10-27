ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "bound_email" text;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "owner_handoff_issued_by_user_id" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invites_owner_handoff_requires_bound_email_check'
      AND conrelid = '"invites"'::regclass
  ) THEN
    ALTER TABLE "invites" ADD CONSTRAINT "invites_owner_handoff_requires_bound_email_check" CHECK ("invites"."owner_handoff_issued_by_user_id" is null or "invites"."bound_email" is not null);
  END IF;
END $$;
