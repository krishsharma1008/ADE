import { and, eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agents } from "@combyne/db";

export type AgentContextProfile = "focused" | "coordinator" | "legacy";

const COORDINATOR_ROLES = new Set(["ceo", "cto", "cmo", "cfo", "pm", "em", "manager"]);
const CONTEXT_PROFILE_OVERRIDES = new Set(["auto", "focused", "coordinator", "legacy"]);

function readContextProfileOverride(adapterConfig: Record<string, unknown> | null | undefined) {
  const raw = adapterConfig?.contextProfile;
  if (typeof raw !== "string") return "auto";
  const normalized = raw.trim().toLowerCase();
  return CONTEXT_PROFILE_OVERRIDES.has(normalized) ? normalized : "auto";
}

function canCreateAgents(permissions: Record<string, unknown> | null | undefined) {
  return permissions?.canCreateAgents === true;
}

export async function resolveAgentContextProfile(
  db: Db,
  agent: {
    id: string;
    companyId: string;
    role: string;
    permissions?: Record<string, unknown> | null;
    adapterConfig?: Record<string, unknown> | null;
  },
): Promise<AgentContextProfile> {
  const override = readContextProfileOverride(agent.adapterConfig);
  if (override === "focused" || override === "coordinator" || override === "legacy") {
    return override;
  }

  const role = agent.role.trim().toLowerCase();
  if (COORDINATOR_ROLES.has(role) || canCreateAgents(agent.permissions)) {
    return "coordinator";
  }

  const directReport = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, agent.companyId), eq(agents.reportsTo, agent.id)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return directReport ? "coordinator" : "focused";
}

export const __internals = {
  COORDINATOR_ROLES,
  readContextProfileOverride,
};
