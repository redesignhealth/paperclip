ALTER TABLE "invites" ADD COLUMN "bound_email" text;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "owner_handoff_issued_by_user_id" text;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_owner_handoff_requires_bound_email_check" CHECK ("invites"."owner_handoff_issued_by_user_id" is null or "invites"."bound_email" is not null);