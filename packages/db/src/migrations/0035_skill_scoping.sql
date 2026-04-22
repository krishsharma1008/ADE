-- Round 3 Phase 1 — skills scoping join tables
-- Empty rows intentionally mean "skill visible to every agent/project"
-- (backward-compat). See docs/plans/round3/04-skills-scoping.md.

CREATE TABLE IF NOT EXISTS "skill_projects" (
    "skill_id" uuid NOT NULL,
    "project_id" uuid NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("skill_id", "project_id")
);

CREATE TABLE IF NOT EXISTS "skill_agents" (
    "skill_id" uuid NOT NULL,
    "agent_id" uuid NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("skill_id", "agent_id")
);

DO $$ BEGIN
    ALTER TABLE "skill_projects"
        ADD CONSTRAINT "skill_projects_skill_id_fk"
        FOREIGN KEY ("skill_id") REFERENCES "company_skills"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "skill_projects"
        ADD CONSTRAINT "skill_projects_project_id_fk"
        FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "skill_agents"
        ADD CONSTRAINT "skill_agents_skill_id_fk"
        FOREIGN KEY ("skill_id") REFERENCES "company_skills"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "skill_agents"
        ADD CONSTRAINT "skill_agents_agent_id_fk"
        FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "skill_projects_project_idx" ON "skill_projects"("project_id");
CREATE INDEX IF NOT EXISTS "skill_agents_agent_idx" ON "skill_agents"("agent_id");
