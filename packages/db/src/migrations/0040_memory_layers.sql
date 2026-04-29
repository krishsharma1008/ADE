-- 4-layer memory store: workspace / personal / shared layers + promotion queue + usage log.
-- Layer A (Core execution) is ephemeral and not persisted.
-- Embeddings stored as jsonb (array of floats); cosine similarity computed in service.

CREATE TABLE IF NOT EXISTS "memory_entries" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "company_id" uuid NOT NULL,
    "layer" text NOT NULL,
    "owner_type" text,
    "owner_id" uuid,
    "subject" text NOT NULL,
    "body" text NOT NULL,
    "kind" text DEFAULT 'fact' NOT NULL,
    "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "service_scope" text,
    "source" text,
    "embedding" jsonb,
    "status" text DEFAULT 'active' NOT NULL,
    "usage_count" integer DEFAULT 0 NOT NULL,
    "last_used_at" timestamp with time zone,
    "ttl_days" integer,
    "created_by" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_company_layer_idx" ON "memory_entries" ("company_id","layer");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_owner_idx" ON "memory_entries" ("company_id","owner_type","owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_status_idx" ON "memory_entries" ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_entries_service_idx" ON "memory_entries" ("company_id","service_scope");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_promotions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "company_id" uuid NOT NULL,
    "source_entry_id" uuid NOT NULL,
    "proposed_subject" text NOT NULL,
    "proposed_body" text NOT NULL,
    "proposed_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "proposed_kind" text DEFAULT 'fact' NOT NULL,
    "proposer_type" text NOT NULL,
    "proposer_id" text,
    "state" text DEFAULT 'pending' NOT NULL,
    "reviewer_id" text,
    "review_notes" text,
    "promoted_entry_id" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_source_entry_id_memory_entries_id_fk"
    FOREIGN KEY ("source_entry_id") REFERENCES "memory_entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_promotions_company_state_idx" ON "memory_promotions" ("company_id","state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_promotions_source_idx" ON "memory_promotions" ("source_entry_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_usage" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "entry_id" uuid NOT NULL,
    "company_id" uuid NOT NULL,
    "issue_id" uuid,
    "actor_type" text NOT NULL,
    "actor_id" text,
    "score" real,
    "used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_usage" ADD CONSTRAINT "memory_usage_entry_id_memory_entries_id_fk"
    FOREIGN KEY ("entry_id") REFERENCES "memory_entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_usage_entry_idx" ON "memory_usage" ("entry_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_usage_company_issue_idx" ON "memory_usage" ("company_id","issue_id");
