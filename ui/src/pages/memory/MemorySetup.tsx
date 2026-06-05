import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompany } from "../../context/CompanyContext";
import { databaseApi } from "../../api/database";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";

const MODELS = ["text-embedding-3-small", "text-embedding-3-large"] as const;

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

/**
 * Setup tab (PR-15 §3.7 / decision #1). Instance-admin only (the parent hides it
 * for non-admins; the endpoint is instance-admin gated server-side). A masked
 * embedding API key input + provider/model selects, a PROMINENT privacy
 * disclosure panel carrying the reconciliation verbatim with a REQUIRED
 * acknowledge checkbox that blocks Save, and the embedding-status ops surface.
 */
export function MemorySetup() {
  const { selectedCompanyId } = useCompany();
  const [provider] = useState("openai");
  const [model, setModel] = useState<(typeof MODELS)[number]>("text-embedding-3-small");
  const [apiKey, setApiKey] = useState("");
  const [acked, setAcked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.memory.embeddingStatus(selectedCompanyId!),
    queryFn: () => memoryApi.getEmbeddingStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      databaseApi.saveEmbeddingConfig({ provider, model, apiKey: apiKey.trim(), disclosureAcked: true }),
    onSuccess: () => {
      setActionError(null);
      setSaved(true);
      setApiKey("");
    },
    onError: (err) => {
      setSaved(false);
      setActionError(err instanceof Error ? err.message : "Save failed");
    },
  });

  const status = statusQuery.data;
  // Save is BLOCKED until the disclosure is acknowledged AND a key is entered.
  const canSave = acked && apiKey.trim().length > 0 && !saveMutation.isPending;

  return (
    <div className="space-y-5" data-tab="setup">
      {/* Embedding key + provider/model */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Embedding configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Provider</label>
              <Input value={provider} disabled data-slot="provider" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Model</label>
              <Select value={model} onValueChange={(v) => setModel(v as (typeof MODELS)[number])}>
                <SelectTrigger size="sm" data-slot="model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="embed-key" className="text-xs font-medium text-muted-foreground">
              Team-shared embedding API key
            </label>
            <Input
              id="embed-key"
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setSaved(false);
              }}
              placeholder="sk-..."
              autoComplete="off"
              data-slot="embed-key"
            />
            <p className="text-xs text-muted-foreground">
              Set once at install. Rendered masked, stored write-only (0600), and never echoed back.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* PROMINENT privacy disclosure + required ack */}
      <Card className="border-yellow-500/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm text-yellow-700 dark:text-yellow-400">
            <ShieldAlert className="h-4 w-4" />
            Privacy disclosure — read before enabling
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 text-sm text-muted-foreground" data-slot="disclosure">
            <p>
              Memory bodies (subject + body), <strong>post-redaction</strong>, are egressed to the
              managed embedder for both newly-captured entries and the query text on retrieval. This
              is <strong>the single external dependency, by explicit choice</strong>. Storage stays
              100% self-hosted Postgres + pgvector.
            </p>
            <p>
              The redact-before-embed step <strong>bounds CREDENTIAL leakage</strong> (it removes
              known secret shapes and quarantines on detection) — it does{" "}
              <strong>NOT guarantee body confidentiality</strong>. It will miss novel secret shapes
              and does not redact non-secret business content. This is a stated residual.
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm" data-slot="ack">
            <Checkbox
              checked={acked}
              onCheckedChange={(v) => {
                setAcked(v === true);
                setSaved(false);
              }}
              data-slot="ack-checkbox"
              className="mt-0.5"
            />
            <span>
              I understand memory bodies egress to the managed embedder post-redaction, and that
              redaction bounds credential leakage but not business-content confidentiality.
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => saveMutation.mutate()} disabled={!canSave} data-action="save-config">
          Save embedding config
        </Button>
        {!acked && (
          <span className="text-xs text-muted-foreground" data-slot="ack-hint">
            Acknowledge the disclosure to enable Save.
          </span>
        )}
      </div>

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {saved && (
        <div
          className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400"
          data-slot="restart-required"
        >
          Saved. <strong>Restart required</strong> — the embedding config takes effect on the next
          boot. The key is stored write-only and never returned.
        </div>
      )}

      {/* Embedding-status ops surface */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Embedding status</CardTitle>
        </CardHeader>
        <CardContent>
          {statusQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading embedding status...</p>
          )}
          {statusQuery.error && (
            <p className="text-sm text-destructive">
              {statusQuery.error instanceof Error
                ? statusQuery.error.message
                : "Failed to load embedding status"}
            </p>
          )}
          {status && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-slot="embedding-status">
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Version coverage</div>
                <div className="mt-1 text-xl font-bold">{pct(status.versionCoveragePct)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  on {status.currentVersion}
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Hash fallback rate</div>
                <div className="mt-1 text-xl font-bold">{pct(status.hashFallbackPct)}</div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Needs review</div>
                <div className="mt-1 text-xl font-bold">{status.redactionBlocked}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">redaction-blocked</div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Re-embed backlog</div>
                <div className="mt-1 text-xl font-bold">{status.reembedBacklog}</div>
              </div>
              <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={status.embedderEnabled ? "default" : "outline"}>
                  embedder {status.embedderEnabled ? "enabled" : "disabled"}
                </Badge>
                <Badge variant="outline">{status.activeEntries} active entries</Badge>
                <Badge variant="outline">
                  pgvector {status.pgvectorPresent ? "present" : "absent"}
                </Badge>
                <Badge variant="outline">HNSW {status.hnswIndexPresent ? "present" : "absent"}</Badge>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
