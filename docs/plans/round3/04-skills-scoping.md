# Item #4 — Skills Scoping by Project / Agent

Phase 10 of Round 3.

## Problem

`server/src/services/company-skills.ts:1527-1535` queries by `companyId` only. `listFull` feeds `listRuntimeSkillEntries` which feeds adapter preamble composition. Result: every agent sees every company skill, regardless of relevance.

## Fix

### Schema (Phase 1 migration)

```sql
CREATE TABLE skill_projects (
  skill_id UUID REFERENCES company_skills(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, project_id)
);

CREATE TABLE skill_agents (
  skill_id UUID REFERENCES company_skills(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, agent_id)
);
```

Empty rows = globally scoped (preserves existing behavior).

### Service

- `listFull(companyId, scope?: { projectIds?: string[], agentIds?: string[] })`. Scope filter: no rows in join tables → include; at least one matching row → include.
- New `listRuntimeSkillEntries(companyId, agentId, projectIds[])` — canonical call site for adapter preamble.
- Audit all six `listFull(companyId)` callers (lines 1516, 1556, 1829, 2044, 2094, 2304). Only the runtime-injection path switches to scoped.

### UI

- Skill edit page: two-section selector (projects checkbox list + agents checkbox list). Empty = all.
- Skill list: indicator chip `All projects · All agents` or `3 projects · 2 agents`.

### Telemetry

`skill.runtime_injected { skillId, agentId, projectId, matchReason: "global"|"project"|"agent" }`.

## Files

- Schema: `packages/db/src/schema/company-skills.ts`.
- Service: `server/src/services/company-skills.ts:1527-1600`.
- UI: `ui/src/pages/Skills.tsx`, `ui/src/pages/SkillEdit.tsx`, `ui/src/api/skills.ts`.
- Migration: `packages/db/src/migrations/0035_skill_scoping.sql`.

## Tests

- Backward compat: no-rows company → every agent sees every skill (zero change).
- Scoped skill hidden from non-matching agent.
- End-to-end wake: agent-in-project-A preamble contains A-scoped + global skills, not B-scoped.
