import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Issue } from "@combyne/shared";
import { ISSUE_COMPLEXITIES, type IssueComplexity } from "@combyne/shared";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { MemoryPassdownPicker } from "./MemoryPassdownPicker";

/**
 * Delegate dialog (PR-16) — creates a sub-issue assigned to a teammate agent and
 * embeds the MemoryPassdownPicker so the manager can pin verified memory entries
 * (`curatedMemoryEntryIds`) into the vetted passdown packet assembled server-side.
 * The picker is scoped by the (optional) serviceScope + the new title so the EM
 * sees the likely-relevant facts. Threading `curatedMemoryEntryIds` + serviceScope
 * through the delegate call is purely additive — the route already accepts both.
 */
export function DelegateIssueDialog({
  parent,
  agents,
  open,
  onOpenChange,
}: {
  parent: Issue;
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [toAgentId, setToAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [complexity, setComplexity] = useState<IssueComplexity>("small");
  const [serviceScope, setServiceScope] = useState(parent.serviceScope ?? "");
  const [curatedIds, setCuratedIds] = useState<string[]>([]);

  const delegate = useMutation({
    mutationFn: () =>
      issuesApi.delegate(parent.id, {
        toAgentId,
        title: title.trim(),
        description: description.trim() || undefined,
        complexity,
        serviceScope: serviceScope.trim() || null,
        curatedMemoryEntryIds: curatedIds.length > 0 ? curatedIds : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(parent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(parent.companyId) });
      reset();
      onOpenChange(false);
    },
  });

  function reset() {
    setToAgentId("");
    setTitle("");
    setDescription("");
    setComplexity("small");
    setServiceScope(parent.serviceScope ?? "");
    setCuratedIds([]);
  }

  const canDelegate = !!toAgentId && title.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Delegate a sub-issue</DialogTitle>
          <DialogDescription>
            Create a sub-issue for a teammate. Pin verified memory below to carry it as vetted
            context into the delegation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="delegate-title">Title</Label>
            <Input
              id="delegate-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Sub-issue title"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="delegate-description">Description</Label>
            <Textarea
              id="delegate-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What needs doing"
              rows={4}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Assignee</Label>
              <Select value={toAgentId} onValueChange={setToAgentId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Complexity</Label>
              <Select
                value={complexity}
                onValueChange={(v) => setComplexity(v as IssueComplexity)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_COMPLEXITIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="delegate-scope">Service scope</Label>
              <Input
                id="delegate-scope"
                value={serviceScope}
                onChange={(e) => setServiceScope(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>

          <div className="rounded-md border border-border p-3">
            <MemoryPassdownPicker
              serviceScope={serviceScope}
              title={title}
              selectedIds={curatedIds}
              onChange={setCuratedIds}
              disabled={delegate.isPending}
            />
          </div>

          {delegate.error && (
            <p className="text-xs text-destructive">
              {delegate.error instanceof Error ? delegate.error.message : "Failed to delegate"}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={delegate.isPending}>
            Cancel
          </Button>
          <Button onClick={() => delegate.mutate()} disabled={!canDelegate || delegate.isPending}>
            {delegate.isPending ? "Delegating..." : "Delegate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
