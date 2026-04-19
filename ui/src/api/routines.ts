import type {
  ActivityEvent,
  Routine,
  RoutineDetail,
  RoutineRun,
  RoutineTrigger,
} from "@combyne/shared";
import { api } from "./client";

export type RoutineTriggerResponse = {
  trigger: RoutineTrigger;
  webhookUrl?: string;
  webhookSecret?: string;
  /**
   * Present only on the create-trigger and rotate responses — the
   * plaintext material the user needs to copy once. Never returned on
   * subsequent reads.
   */
  secretMaterial?: {
    webhookUrl: string;
    webhookSecret: string;
  } | null;
};

export type RotateRoutineTriggerResponse = {
  trigger: RoutineTrigger;
  webhookUrl?: string;
  webhookSecret?: string;
  secretMaterial?: {
    webhookUrl: string;
    webhookSecret: string;
  } | null;
};

export const routinesApi = {
  list: (companyId: string) =>
    api.get<Routine[]>(`/companies/${companyId}/routines`),

  create: (companyId: string, body: Record<string, unknown>) =>
    api.post<Routine>(`/companies/${companyId}/routines`, body),

  get: (id: string) =>
    api.get<RoutineDetail>(`/routines/${id}`),

  update: (id: string, patch: Record<string, unknown>) =>
    api.patch<RoutineDetail>(`/routines/${id}`, patch),

  listRuns: (id: string, limit?: number) => {
    const params = limit != null ? `?limit=${limit}` : "";
    return api.get<RoutineRun[]>(`/routines/${id}/runs${params}`);
  },

  run: (id: string) =>
    api.post<RoutineRun>(`/routines/${id}/run`, {}),

  createTrigger: (routineId: string, body: Record<string, unknown>) =>
    api.post<RoutineTriggerResponse>(`/routines/${routineId}/triggers`, body),

  updateTrigger: (triggerId: string, patch: Record<string, unknown>) =>
    api.patch<RoutineTrigger>(`/routine-triggers/${triggerId}`, patch),

  deleteTrigger: (triggerId: string) =>
    api.delete<void>(`/routine-triggers/${triggerId}`),

  rotateTriggerSecret: (triggerId: string) =>
    api.post<RotateRoutineTriggerResponse>(
      `/routine-triggers/${triggerId}/rotate-secret`,
      {},
    ),

  activity: (
    companyId: string,
    routineId: string,
    relatedIds: { triggerIds: string[]; runIds: string[] },
  ) => {
    const params = new URLSearchParams();
    params.set("routineId", routineId);
    if (relatedIds.triggerIds.length > 0)
      params.set("triggerIds", relatedIds.triggerIds.join(","));
    if (relatedIds.runIds.length > 0)
      params.set("runIds", relatedIds.runIds.join(","));
    return api.get<ActivityEvent[]>(
      `/companies/${companyId}/activity?${params.toString()}`,
    );
  },
};
