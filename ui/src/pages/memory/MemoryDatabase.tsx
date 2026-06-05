import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Database, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { databaseApi, type ContextDatabaseProbe } from "../../api/database";
import { queryKeys } from "../../lib/queryKeys";

function StatusRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{value}</span>
    </div>
  );
}

/**
 * Database tab (PR-15 §3.7 / §1.6). Instance-admin only (the parent hides it for
 * non-admins; the endpoints are instance-admin gated server-side too). Shows the
 * current context-DB connection status, a connect/switch form whose DATABASE URL
 * input is rendered type=password (masked), a Test-connection probe, a
 * Save-for-next-boot action with a restart-required notice, and the safe switch
 * order panel.
 */
export function MemoryDatabase() {
  const [url, setUrl] = useState("");
  const [probe, setProbe] = useState<ContextDatabaseProbe | null>(null);
  const [saved, setSaved] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.contextDatabase.status,
    queryFn: () => databaseApi.getStatus(),
  });

  const testMutation = useMutation({
    mutationFn: (u: string) => databaseApi.test(u),
    onSuccess: (result) => {
      setActionError(null);
      setProbe(result);
    },
    onError: (err) => {
      setProbe(null);
      setActionError(err instanceof Error ? err.message : "Test failed");
    },
  });

  const saveMutation = useMutation({
    mutationFn: (u: string) => databaseApi.save(u),
    onSuccess: () => {
      setActionError(null);
      setSaved(true);
    },
    onError: (err) => {
      setSaved(false);
      setActionError(err instanceof Error ? err.message : "Save failed");
    },
  });

  const status = statusQuery.data;
  const isBusy = testMutation.isPending || saveMutation.isPending;

  return (
    <div className="space-y-5" data-tab="database">
      {/* Current connection status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Server className="h-4 w-4 text-muted-foreground" />
            Current context database
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statusQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading connection status...</p>
          )}
          {statusQuery.error && (
            <p className="text-sm text-destructive">
              {statusQuery.error instanceof Error
                ? statusQuery.error.message
                : "Failed to load connection status"}
            </p>
          )}
          {status && (
            <div className="space-y-0.5">
              <StatusRow label="Mode" value={<Badge variant="outline">{status.mode}</Badge>} />
              <StatusRow label="Endpoint" value={status.redactedEndpoint || "—"} />
              <StatusRow label="Server version" value={status.serverVersion ?? "unknown"} />
              <StatusRow
                label="Memory schema present"
                value={status.memorySchemaPresent ? "yes" : "no"}
              />
              <StatusRow label="Memory entries" value={status.memoryEntryCount ?? "—"} />
              <StatusRow label="Configured via" value={status.configuredVia} />
              <StatusRow
                label="Separate context DB"
                value={status.usingSeparateContextDb ? "yes" : "no (shared with app DB)"}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Connect / switch form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="h-4 w-4 text-muted-foreground" />
            Connect / switch context DB
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="ctx-db-url" className="text-xs font-medium text-muted-foreground">
              Database URL
            </label>
            <Input
              id="ctx-db-url"
              type="password"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setProbe(null);
                setSaved(false);
              }}
              placeholder="postgres://user:password@host:5432/db"
              autoComplete="off"
              data-slot="ctx-db-url"
            />
            <p className="text-xs text-muted-foreground">
              Rendered masked. The credential is never echoed back; the status above always shows a
              password-redacted endpoint.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={isBusy || url.trim().length === 0}
              onClick={() => testMutation.mutate(url.trim())}
              data-action="test"
            >
              Test connection
            </Button>
            <Button
              size="sm"
              disabled={isBusy || url.trim().length === 0}
              onClick={() => saveMutation.mutate(url.trim())}
              data-action="save"
            >
              Save for next boot
            </Button>
          </div>

          {actionError && <p className="text-sm text-destructive">{actionError}</p>}

          {probe && (
            <div
              className="rounded-md border border-border bg-muted/30 p-3 text-sm"
              data-slot="probe-result"
            >
              <div className="mb-1 flex items-center gap-2">
                <Badge variant={probe.ok ? "default" : "outline"}>
                  {probe.ok ? "reachable" : "unreachable"}
                </Badge>
              </div>
              {probe.ok ? (
                <div className="space-y-0.5">
                  <StatusRow label="Server version" value={probe.serverVersion ?? "unknown"} />
                  <StatusRow
                    label="Memory schema present"
                    value={probe.memorySchemaPresent ? "yes" : "no"}
                  />
                  <StatusRow label="Memory entries" value={probe.memoryEntryCount ?? "—"} />
                </div>
              ) : (
                <p className="text-destructive">{probe.error ?? "Connection failed"}</p>
              )}
            </div>
          )}

          {saved && (
            <div
              className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm text-yellow-700 dark:text-yellow-400"
              data-slot="restart-required"
            >
              Saved. <strong>Restart required</strong> — the new connection takes effect on the next
              boot. The live pool is untouched until then.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Safe switch order */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Safe switch order</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              <strong>Test</strong> — probe reachability + memory schema before committing.
            </li>
            <li>
              <strong>Migrate</strong> — run <code className="text-xs">db:migrate</code> against the
              target so the memory schema exists.
            </li>
            <li>
              <strong>db:memory-import</strong> — import the existing corpus into the new DB.
            </li>
            <li>
              <strong>Save</strong> — persist the URL for the next boot.
            </li>
            <li>
              <strong>Restart</strong> — the new connection takes effect.
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
