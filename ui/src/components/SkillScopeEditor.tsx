// Round 3 Phase 10 — skill scoping editor.
//
// Rendered below the SkillPane on the Company Skills page. Lets an operator
// pin a skill to specific projects and/or agents. Empty selections mean the
// skill is globally scoped for everyone in the company (backward compat).

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { companySkillsApi } from "../api/companySkills";
import { queryKeys } from "../lib/queryKeys";
import { useToast } from "../context/ToastContext";

function arrayEquals(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

export function SkillScopeEditor({
  companyId,
  skillId,
}: {
  companyId: string;
  skillId: string;
}) {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const scopesQuery = useQuery({
    queryKey: queryKeys.companySkills.scopes(companyId, skillId),
    queryFn: () => companySkillsApi.getScopes(companyId, skillId),
  });
  const agentsQuery = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId),
  });
  const projectsQuery = useQuery({
    queryKey: ["projects", companyId],
    queryFn: () => projectsApi.list(companyId),
  });

  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);

  useEffect(() => {
    if (scopesQuery.data) {
      setSelectedProjects(scopesQuery.data.projectIds);
      setSelectedAgents(scopesQuery.data.agentIds);
    }
  }, [scopesQuery.data]);

  const dirty = useMemo(() => {
    if (!scopesQuery.data) return false;
    return (
      !arrayEquals(selectedProjects, scopesQuery.data.projectIds) ||
      !arrayEquals(selectedAgents, scopesQuery.data.agentIds)
    );
  }, [selectedProjects, selectedAgents, scopesQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      companySkillsApi.setScopes(companyId, skillId, {
        projectIds: selectedProjects,
        agentIds: selectedAgents,
      }),
    onSuccess: (result) => {
      qc.setQueryData(queryKeys.companySkills.scopes(companyId, skillId), result);
      pushToast({ tone: "success", title: "Scope saved" });
    },
    onError: (err: Error) => {
      pushToast({ tone: "error", title: "Could not save scope", body: err.message });
    },
  });

  const toggle = (
    value: string,
    current: string[],
    setter: (next: string[]) => void,
  ) => {
    if (current.includes(value)) setter(current.filter((v) => v !== value));
    else setter([...current, value]);
  };

  const isGlobal = selectedProjects.length === 0 && selectedAgents.length === 0;

  if (scopesQuery.isLoading || agentsQuery.isLoading || projectsQuery.isLoading) {
    return (
      <div className="border-t border-border px-5 py-4 text-sm text-muted-foreground">
        Loading scoping…
      </div>
    );
  }

  return (
    <div className="border-t border-border px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Scope</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {isGlobal
              ? "Available to every agent and project in this company."
              : `Available to ${selectedAgents.length} agent${selectedAgents.length === 1 ? "" : "s"} and ${selectedProjects.length} project${selectedProjects.length === 1 ? "" : "s"}.`}
          </p>
        </div>
        <Button
          size="sm"
          disabled={!dirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? "Saving…" : "Save scope"}
        </Button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <Boxes className="h-3.5 w-3.5" />
            Projects
          </div>
          {projectsQuery.data && projectsQuery.data.length > 0 ? (
            <ul className="space-y-1">
              {projectsQuery.data.map((project) => (
                <li key={project.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedProjects.includes(project.id)}
                      onChange={() => toggle(project.id, selectedProjects, setSelectedProjects)}
                    />
                    <span className="truncate">{project.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No projects yet.</p>
          )}
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            Agents
          </div>
          {agentsQuery.data && agentsQuery.data.length > 0 ? (
            <ul className="space-y-1">
              {agentsQuery.data.map((agent) => (
                <li key={agent.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedAgents.includes(agent.id)}
                      onChange={() => toggle(agent.id, selectedAgents, setSelectedAgents)}
                    />
                    <span className="truncate">{agent.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No agents yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
