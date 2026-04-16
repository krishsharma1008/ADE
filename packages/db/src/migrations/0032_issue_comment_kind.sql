ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'comment';
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "choices" jsonb;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "answered_at" timestamptz;
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "answered_comment_id" uuid;
CREATE INDEX IF NOT EXISTS "issue_comments_issue_kind_idx" ON "issue_comments" ("issue_id", "kind");
