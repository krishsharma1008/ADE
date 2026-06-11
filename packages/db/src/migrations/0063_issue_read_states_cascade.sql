-- 0063 — issue_read_states blocked company/issue deletion (found live 2026-06-11:
-- DELETE /api/companies/:id 500 "violates foreign key constraint
-- issue_read_states_issue_id_issues_id_fk" — the deletion path covers every other
-- dependent table, but read states are created lazily on first read and carry no
-- cascade). Read states are pure per-user UI bookkeeping; cascade both edges.
ALTER TABLE "issue_read_states" DROP CONSTRAINT IF EXISTS "issue_read_states_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "issue_read_states" DROP CONSTRAINT IF EXISTS "issue_read_states_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE CASCADE;
