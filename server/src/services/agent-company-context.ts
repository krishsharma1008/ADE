import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { projects, projectWorkspaces, goals, projectGoals } from "@combyne/db";

export interface CompanyProjectOverviewWorkspace {
  id: string;
  name: string;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  isPrimary: boolean;
}

export interface CompanyProjectOverviewProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  color: string | null;
  archivedAt: string | null;
  goalTitles: string[];
  workspaces: CompanyProjectOverviewWorkspace[];
}

export interface CompanyProjectOverviewResult {
  items: CompanyProjectOverviewProject[];
  body: string;
}

/**
 * Compact view of the Combyne-managed projects + primary workspaces for a
 * company, formatted for injection into agent context preambles. Fixes the
 * "CEO says project not found" bug where the agent only saw its on-disk
 * workspace and had no visibility into user-created projects.
 *
 * Intentionally read-only + narrow — we do NOT emit full issue lists here
 * (that would blow the preamble budget). Agents use the delegation /
 * sub-issue tooling to drill into a project once they know it exists.
 */
export async function loadCompanyProjectOverview(
  db: Db,
  companyId: string,
  opts: { limit?: number } = {},
): Promise<CompanyProjectOverviewResult> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      color: projects.color,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(
      and(
        eq(projects.companyId, companyId),
        // Non-archived first; archived ones still appear but ranked lower.
        or(isNull(projects.archivedAt), eq(projects.status, "active")),
      ),
    )
    .orderBy(asc(projects.name))
    .limit(limit + 1);

  if (rows.length === 0) {
    return {
      items: [],
      body: "_This company has no projects yet. Create one via the Projects tab or delegate_project skill._",
    };
  }

  const projectIds = rows.map((r) => r.id);

  // Workspaces per project.
  const workspaceRows = await db
    .select({
      id: projectWorkspaces.id,
      projectId: projectWorkspaces.projectId,
      name: projectWorkspaces.name,
      cwd: projectWorkspaces.cwd,
      repoUrl: projectWorkspaces.repoUrl,
      repoRef: projectWorkspaces.repoRef,
      isPrimary: projectWorkspaces.isPrimary,
    })
    .from(projectWorkspaces)
    .where(eq(projectWorkspaces.companyId, companyId));

  const workspacesByProject = new Map<string, CompanyProjectOverviewWorkspace[]>();
  for (const ws of workspaceRows) {
    const list = workspacesByProject.get(ws.projectId) ?? [];
    list.push({
      id: ws.id,
      name: ws.name,
      cwd: ws.cwd,
      repoUrl: ws.repoUrl,
      repoRef: ws.repoRef,
      isPrimary: ws.isPrimary,
    });
    workspacesByProject.set(ws.projectId, list);
  }

  // Goals per project.
  const goalLinkRows = projectIds.length > 0
    ? await db
        .select({
          projectId: projectGoals.projectId,
          goalId: projectGoals.goalId,
          goalTitle: goals.title,
        })
        .from(projectGoals)
        .leftJoin(goals, eq(goals.id, projectGoals.goalId))
        .where(eq(projectGoals.companyId, companyId))
    : [];
  const goalTitlesByProject = new Map<string, string[]>();
  for (const row of goalLinkRows) {
    if (!row.goalTitle) continue;
    const list = goalTitlesByProject.get(row.projectId) ?? [];
    list.push(row.goalTitle);
    goalTitlesByProject.set(row.projectId, list);
  }

  const items: CompanyProjectOverviewProject[] = rows.slice(0, limit).map((row) => {
    const workspaces = (workspacesByProject.get(row.id) ?? []).sort(
      (a, b) => Number(b.isPrimary) - Number(a.isPrimary),
    );
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      color: row.color,
      archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
      goalTitles: goalTitlesByProject.get(row.id) ?? [],
      workspaces,
    };
  });

  const lines: string[] = [];
  for (const project of items) {
    const descSuffix = project.description ? ` — ${project.description.split("\n")[0]?.slice(0, 160) ?? ""}` : "";
    lines.push(`- **${project.name}** [${project.status}]${descSuffix}`);
    if (project.goalTitles.length > 0) {
      lines.push(`    - Goals: ${project.goalTitles.slice(0, 3).join("; ")}`);
    }
    const primary = project.workspaces.find((w) => w.isPrimary) ?? project.workspaces[0];
    if (primary) {
      const repoPart = primary.repoUrl ? ` @ \`${primary.repoUrl}${primary.repoRef ? `#${primary.repoRef}` : ""}\`` : "";
      const cwdPart = primary.cwd ? ` — **local path** \`${primary.cwd}\`` : "";
      lines.push(`    - Primary workspace: **${primary.name}**${repoPart}${cwdPart}`);
      if (primary.cwd) {
        lines.push(`    - _Accessible from this session via \`--add-dir\` — you can \`ls ${primary.cwd}\`, read/write files there directly._`);
      }
    }
    if (project.workspaces.length > 1) {
      lines.push(`    - +${project.workspaces.length - 1} other workspace(s)`);
    }
  }
  if (rows.length > limit) {
    lines.push(`- …and ${rows.length - limit} more project(s) not shown.`);
  }

  const MAX_BODY_BYTES = 8_000;
  let body = lines.join("\n");
  if (body.length > MAX_BODY_BYTES) {
    body = `${body.slice(0, MAX_BODY_BYTES)}\n…(truncated)`;
  }

  return { items, body };
}
