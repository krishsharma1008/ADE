import { useState } from "react";
import type {
  MemoryEntry,
  MemoryKind,
  MemoryStatus,
  UpdateMemoryEntry,
} from "@combyne/shared";
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

const KINDS: MemoryKind[] = ["fact", "runbook", "convention", "pointer", "note"];
const STATUSES: MemoryStatus[] = ["active", "archived", "deprecated"];

interface MemoryDraft {
  subject: string;
  body: string;
  kind: MemoryKind;
  status: MemoryStatus;
  serviceScope: string;
  source: string;
  ttlDays: string;
  tags: string;
}

function draftFromEntry(entry: MemoryEntry): MemoryDraft {
  return {
    subject: entry.subject,
    body: entry.body,
    kind: entry.kind,
    status: entry.status,
    serviceScope: entry.serviceScope ?? "",
    source: entry.source ?? "",
    ttlDays: entry.ttlDays == null ? "" : String(entry.ttlDays),
    tags: entry.tags.join(", "),
  };
}

function payloadFromDraft(draft: MemoryDraft): UpdateMemoryEntry {
  const ttl = draft.ttlDays.trim();
  return {
    subject: draft.subject.trim(),
    body: draft.body.trim(),
    kind: draft.kind,
    status: draft.status,
    serviceScope: draft.serviceScope.trim() || null,
    source: draft.source.trim() || null,
    ttlDays: ttl ? Number(ttl) : null,
    tags: draft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
}

/**
 * Edit dialog for a single memory entry. Workspace + personal layers only —
 * shared entries are promotion-gated (the shared validator rejects direct
 * shared writes), so the card never opens this dialog for them.
 */
export function MemoryEntryEditDialog({
  entry,
  open,
  onOpenChange,
  onSave,
  isSaving,
  error,
}: {
  entry: MemoryEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: UpdateMemoryEntry) => void;
  isSaving?: boolean;
  error?: string | null;
}) {
  const [draft, setDraft] = useState<MemoryDraft>(() => draftFromEntry(entry));

  // Reset the draft whenever the dialog re-opens for a (possibly different) entry.
  const [seedId, setSeedId] = useState(entry.id);
  if (open && seedId !== entry.id) {
    setSeedId(entry.id);
    setDraft(draftFromEntry(entry));
  }

  const canSave = draft.subject.trim().length > 0 && draft.body.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit memory entry</DialogTitle>
          <DialogDescription>
            {entry.layer === "personal"
              ? "Personal entry — only visible to its owner."
              : "Workspace entry — shared across this company's agents."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="memory-subject">Subject</Label>
            <Input
              id="memory-subject"
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="Memory subject"
            />
          </div>

          <div className="flex gap-2">
            <div className="flex-1 space-y-1.5">
              <Label>Kind</Label>
              <Select
                value={draft.kind}
                onValueChange={(value) => setDraft({ ...draft, kind: value as MemoryKind })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 space-y-1.5">
              <Label>Status</Label>
              <Select
                value={draft.status}
                onValueChange={(value) => setDraft({ ...draft, status: value as MemoryStatus })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="memory-body">Body</Label>
            <Textarea
              id="memory-body"
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="Memory body"
              rows={6}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="memory-tags">Tags</Label>
              <Input
                id="memory-tags"
                value={draft.tags}
                onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                placeholder="Tags, comma-separated"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="memory-scope">Service scope</Label>
              <Input
                id="memory-scope"
                value={draft.serviceScope}
                onChange={(e) => setDraft({ ...draft, serviceScope: e.target.value })}
                placeholder="Service scope"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="memory-source">Source</Label>
              <Input
                id="memory-source"
                value={draft.source}
                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                placeholder="Source"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="memory-ttl">TTL days</Label>
              <Input
                id="memory-ttl"
                value={draft.ttlDays}
                onChange={(e) =>
                  setDraft({ ...draft, ttlDays: e.target.value.replace(/[^\d]/g, "") })
                }
                placeholder="TTL days"
                inputMode="numeric"
              />
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => onSave(payloadFromDraft(draft))} disabled={isSaving || !canSave}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
