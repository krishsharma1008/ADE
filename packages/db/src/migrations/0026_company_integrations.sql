CREATE TABLE "company_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"enabled" text DEFAULT 'true' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_integrations" ADD CONSTRAINT "company_integrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_integrations_company_idx" ON "company_integrations" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_integrations_company_provider_uq" ON "company_integrations" USING btree ("company_id","provider");
