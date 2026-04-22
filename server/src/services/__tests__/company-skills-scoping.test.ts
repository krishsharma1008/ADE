// Round 3 Phase 10 — skills scoping.
//
// Verifies listFull(companyId, scope) filter semantics:
//   1. No rows in skill_projects/skill_agents = globally scoped (backward compat).
//   2. Skill scoped via skill_projects only surfaces when scope.projectIds
//      includes one of its project ids.
//   3. Skill scoped via skill_agents only surfaces when scope.agentId matches.
//   4. Unscoped call (no scope arg, or empty scope) returns all skills —
//      matches existing callers' expectations.
//
// Does NOT depend on the filesystem — each `listFull` call hits
// `ensureSkillInventoryCurrent` which scans bundled-skills paths, but with no
// bundled skills present the pass is a no-op.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySkills,
  projects,
  skillAgents,
  skillProjects,
} from "@combyne/db";
import { companySkillService } from "../company-skills.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("companySkillService.listFull scope filter", () => {
  let handle: TestDbHandle;
  let svc: ReturnType<typeof companySkillService>;
  let companyId: string;
  let projectAId: string;
  let projectBId: string;
  let agentXId: string;
  let agentYId: string;
  let globalSkillId: string;
  let projectAOnlySkillId: string;
  let agentXOnlySkillId: string;
  let mixedSkillId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    svc = companySkillService(handle.db);

    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Skill Scope Co", issuePrefix: "SSC" })
      .returning();
    companyId = company.id;

    const [projA, projB] = await handle.db
      .insert(projects)
      .values([
        { companyId, name: "Project A" },
        { companyId, name: "Project B" },
      ])
      .returning();
    projectAId = projA.id;
    projectBId = projB.id;

    const [agentX, agentY] = await handle.db
      .insert(agents)
      .values([
        { companyId, name: "Agent X", adapterType: "process" },
        { companyId, name: "Agent Y", adapterType: "process" },
      ])
      .returning();
    agentXId = agentX.id;
    agentYId = agentY.id;

    // Trigger ensureSkillInventoryCurrent once up-front so bundled-skill
    // materialization happens BEFORE we insert fixtures. That way
    // pruneMissingLocalPathSkills (which runs inside ensureSkillInventoryCurrent)
    // cannot delete our fixture rows.
    await svc.listFull(companyId);

    // Use sourceType="github" so pruneMissingLocalPathSkills leaves fixtures alone.
    const baseSkill = {
      companyId,
      markdown: "# stub",
      sourceType: "github",
      sourceLocator: "https://github.com/combyne/fixture",
      trustLevel: "markdown_only",
      compatibility: "compatible",
    } as const;

    const [globalSkill, projectAOnly, agentXOnly, mixed] = await handle.db
      .insert(companySkills)
      .values([
        { ...baseSkill, key: "scope-test-global", slug: "scope-test-global", name: "Global skill" },
        { ...baseSkill, key: "scope-test-proj-a", slug: "scope-test-proj-a", name: "Project A only" },
        { ...baseSkill, key: "scope-test-agent-x", slug: "scope-test-agent-x", name: "Agent X only" },
        { ...baseSkill, key: "scope-test-mixed", slug: "scope-test-mixed", name: "Mixed scope" },
      ])
      .returning();
    globalSkillId = globalSkill.id;
    projectAOnlySkillId = projectAOnly.id;
    agentXOnlySkillId = agentXOnly.id;
    mixedSkillId = mixed.id;

    await handle.db.insert(skillProjects).values({
      skillId: projectAOnlySkillId,
      projectId: projectAId,
    });
    await handle.db.insert(skillAgents).values({
      skillId: agentXOnlySkillId,
      agentId: agentXId,
    });
    // Mixed skill: scoped to both project B + agent Y.
    await handle.db.insert(skillProjects).values({
      skillId: mixedSkillId,
      projectId: projectBId,
    });
    await handle.db.insert(skillAgents).values({
      skillId: mixedSkillId,
      agentId: agentYId,
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("unscoped call returns every skill (backward compat)", async () => {
    const all = await svc.listFull(companyId);
    const keys = all.map((s) => s.key).filter((k) => k.startsWith("scope-test-")).sort();
    expect(keys).toEqual([
      "scope-test-agent-x",
      "scope-test-global",
      "scope-test-mixed",
      "scope-test-proj-a",
    ]);
  });

  it("scoped to project A returns global + proj-a only", async () => {
    const filtered = await svc.listFull(companyId, { projectIds: [projectAId] });
    const keys = filtered.map((s) => s.key).filter((k) => k.startsWith("scope-test-")).sort();
    expect(keys).toEqual(["scope-test-global", "scope-test-proj-a"]);
  });

  it("scoped to agent X returns global + agent-x only", async () => {
    const filtered = await svc.listFull(companyId, { agentId: agentXId });
    const keys = filtered.map((s) => s.key).filter((k) => k.startsWith("scope-test-")).sort();
    expect(keys).toEqual(["scope-test-agent-x", "scope-test-global"]);
  });

  it("scoped to agent Y + project B surfaces the mixed skill", async () => {
    const filtered = await svc.listFull(companyId, {
      agentId: agentYId,
      projectIds: [projectBId],
    });
    const keys = filtered.map((s) => s.key).filter((k) => k.startsWith("scope-test-")).sort();
    // mixed is reachable via EITHER agent Y OR project B.
    expect(keys).toEqual(["scope-test-global", "scope-test-mixed"]);
  });

  it("scoped to an unrelated agent returns only globally scoped skills", async () => {
    // Create a fresh agent that appears in no join table.
    const [unrelated] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Unrelated agent", adapterType: "process" })
      .returning();
    const filtered = await svc.listFull(companyId, { agentId: unrelated.id });
    const keys = filtered.map((s) => s.key).filter((k) => k.startsWith("scope-test-")).sort();
    expect(keys).toEqual(["scope-test-global"]);
  });

  it("listScopes returns the join-table rows for the skill", async () => {
    const mixedScopes = await svc.listScopes(mixedSkillId);
    expect(mixedScopes.projectIds).toEqual([projectBId]);
    expect(mixedScopes.agentIds).toEqual([agentYId]);
    const globalScopes = await svc.listScopes(globalSkillId);
    expect(globalScopes.projectIds).toEqual([]);
    expect(globalScopes.agentIds).toEqual([]);
  });

  it("setScopes replaces rows transactionally", async () => {
    // Start from empty, set both sides, then reset one side only.
    const before = await svc.listScopes(globalSkillId);
    expect(before.projectIds).toEqual([]);

    const afterSet = await svc.setScopes(globalSkillId, {
      projectIds: [projectAId, projectBId],
      agentIds: [agentXId],
    });
    expect(afterSet.projectIds.sort()).toEqual([projectAId, projectBId].sort());
    expect(afterSet.agentIds).toEqual([agentXId]);

    // Only update projects; agents should remain.
    const afterProjectsOnly = await svc.setScopes(globalSkillId, {
      projectIds: [projectAId],
    });
    expect(afterProjectsOnly.projectIds).toEqual([projectAId]);
    expect(afterProjectsOnly.agentIds).toEqual([agentXId]);

    // Reset to empty lists (explicit global state).
    const afterReset = await svc.setScopes(globalSkillId, {
      projectIds: [],
      agentIds: [],
    });
    expect(afterReset.projectIds).toEqual([]);
    expect(afterReset.agentIds).toEqual([]);

    // Confirm via DB that rows are gone.
    const projRows = await handle.db
      .select()
      .from(skillProjects)
      .where(eq(skillProjects.skillId, globalSkillId));
    const agentRows = await handle.db
      .select()
      .from(skillAgents)
      .where(eq(skillAgents.skillId, globalSkillId));
    expect(projRows).toHaveLength(0);
    expect(agentRows).toHaveLength(0);
  });
});
