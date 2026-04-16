import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agentHandoffs, agents, issues } from "@combyne/db";

export interface BootstrapAnalysisContext {
  isBootstrapAnalysis: true;
  reason: "first_top_level_ceo_issue";
  issueId: string;
  agentId: string;
  companyId: string;
  preamble?: string;
}

const SKILL_FILENAME = "SKILL.md";
let cachedBootstrapSkill: string | null = null;

function resolveSkillPath(): string {
  // server/src/services → repo-root/skills/ceo-bootstrap/SKILL.md
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "skills", "ceo-bootstrap", SKILL_FILENAME);
}

async function loadBootstrapSkill(): Promise<string | null> {
  if (cachedBootstrapSkill !== null) return cachedBootstrapSkill;
  try {
    const content = await fs.readFile(resolveSkillPath(), "utf8");
    cachedBootstrapSkill = content;
    return content;
  } catch {
    cachedBootstrapSkill = "";
    return null;
  }
}

export async function buildBootstrapPreamble(ctx: {
  companyId: string;
  agentId: string;
  issueId: string;
}): Promise<string> {
  const skill = await loadBootstrapSkill();
  const heading =
    `# Bootstrap analysis triggered\n\n` +
    `This is the first top-level issue assigned to you as CEO for this company (\`${ctx.companyId}\`). ` +
    `Run the CEO Bootstrap Playbook before doing any direct or delegated work.\n\n`;
  if (!skill) return heading;
  return `${heading}---\n\n${skill}`;
}

/**
 * Returns a BootstrapAnalysisContext if this is the first time a top-level
 * (parentId IS NULL) issue has landed on a CEO-role agent that has never
 * delegated before. Used to trigger the CEO bootstrap playbook (E2).
 */
export async function detectBootstrapAnalysis(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string },
): Promise<BootstrapAnalysisContext | null> {
  const [agent] = await db
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  if (!agent || agent.role !== "ceo") return null;

  const [issue] = await db
    .select({ id: issues.id, parentId: issues.parentId })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  if (!issue || issue.parentId !== null) return null;

  const [priorHandoffs] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentHandoffs)
    .where(and(eq(agentHandoffs.companyId, input.companyId), eq(agentHandoffs.fromAgentId, input.agentId)));
  if ((priorHandoffs?.count ?? 0) > 0) return null;

  // If the CEO already has issues other than this one that they've closed or
  // are actively working on, they've already been through bootstrap — treat
  // this wake as routine.
  const [otherIssues] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.assigneeAgentId, input.agentId),
        isNull(issues.parentId),
        sql`${issues.id} <> ${input.issueId}`,
      ),
    );
  if ((otherIssues?.count ?? 0) > 0) return null;

  return {
    isBootstrapAnalysis: true,
    reason: "first_top_level_ceo_issue",
    issueId: input.issueId,
    agentId: input.agentId,
    companyId: input.companyId,
  };
}
