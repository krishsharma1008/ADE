import type { Agent } from "@combyne/shared";

export const AGENT_ORDER_UPDATED_EVENT = "combyne:agent-order-updated";
const AGENT_ORDER_STORAGE_PREFIX = "combyne.agentOrder";
const ANONYMOUS_USER_ID = "anonymous";

type AgentOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function resolveUserId(userId: string | null | undefined): string {
  if (!userId) return ANONYMOUS_USER_ID;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : ANONYMOUS_USER_ID;
}

export function getAgentOrderStorageKey(companyId: string, userId: string | null | undefined): string {
  return `${AGENT_ORDER_STORAGE_PREFIX}:${companyId}:${resolveUserId(userId)}`;
}

export function readAgentOrder(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeIdList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeAgentOrder(storageKey: string, orderedIds: string[]) {
  const normalized = normalizeIdList(orderedIds);
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AgentOrderUpdatedDetail>(AGENT_ORDER_UPDATED_EVENT, {
        detail: { storageKey, orderedIds: normalized },
      }),
    );
  }
}

export function sortAgentsByStoredOrder(agents: Agent[], orderedIds: string[]): Agent[] {
  if (agents.length === 0) return [];
  if (orderedIds.length === 0) return agents;

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const sorted: Agent[] = [];

  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (!agent) continue;
    sorted.push(agent);
    byId.delete(id);
  }
  for (const agent of byId.values()) {
    sorted.push(agent);
  }
  return sorted;
}
