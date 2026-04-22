// Round 3 Phase 11 — delete-project modal.
//
// Two-step flow:
//   1. Click "Delete" → open dialog. Attempt a non-force delete.
//      - If server returns 409 (project_has_issues) with counts, render
//        "N issues (M open)" copy and a force button.
//   2. Click "Delete & unlink issues" → force=true. Server unlinks issues
//      (archives project name) and deletes the project row.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@combyne/shared";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToast } from "../context/ToastContext";

type ConflictInfo = { issueCount: number; openCount: number };

export function DeleteProjectDialog({
  project,
  companyId,
  open,
  onOpenChange,
  onDeleted,
}: {
  project: Project;
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (force: boolean) =>
      projectsApi.remove(project.id, companyId, { force }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
      pushToast({ tone: "success", title: "Project deleted" });
      setConflict(null);
      onOpenChange(false);
      onDeleted?.();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { issueCount?: number; openCount?: number };
        setConflict({
          issueCount: Number(body?.issueCount ?? 0),
          openCount: Number(body?.openCount ?? 0),
        });
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      pushToast({ tone: "error", title: "Could not delete project", body: message });
    },
  });

  const handleFirstClick = () => deleteMutation.mutate(false);
  const handleForce = () => deleteMutation.mutate(true);
  const handleCancel = () => {
    setConflict(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) setConflict(null);
      onOpenChange(next);
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete project {project.name}?</DialogTitle>
          <DialogDescription>
            {conflict
              ? `This project has ${conflict.issueCount} issue${conflict.issueCount === 1 ? "" : "s"} (${conflict.openCount} open). Unlink them and delete the project?`
              : "This removes the project row. Issues linked to it will be unlinked."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={deleteMutation.isPending}>
            Cancel
          </Button>
          {conflict ? (
            <Button
              variant="destructive"
              onClick={handleForce}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete & unlink issues"}
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={handleFirstClick}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
