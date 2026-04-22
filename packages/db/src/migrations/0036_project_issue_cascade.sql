-- Round 3 Phase 1 — project delete cascade
-- issues.project_id is currently a bare FK. Deleting a project that has ever
-- had an issue attached to it fails with a constraint violation. Switch to
-- ON DELETE SET NULL so the force-delete path in projects.remove() can null
-- the refs atomically. See docs/plans/round3/05-project-delete-ui.md.

DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'issues'::regclass
      AND confrelid = 'projects'::regclass
      AND contype = 'f'
    LIMIT 1;

    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE issues DROP CONSTRAINT %I', cname);
    END IF;

    ALTER TABLE issues
        ADD CONSTRAINT issues_project_id_fk
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
END $$;

-- Preserve historical project name when a force-delete nulls the reference.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "archived_project_name" text;
