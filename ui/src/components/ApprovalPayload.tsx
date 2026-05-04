import { UserPlus, Lightbulb, ShieldCheck, ClipboardList, GitMerge } from "lucide-react";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  plan_review: "Plan Review",
  merge_pr: "Merge PR",
};

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  plan_review: ClipboardList,
  merge_pr: GitMerge,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function PlanReviewPayload({ payload }: { payload: Record<string, unknown> }) {
  const content = payload.content ?? payload.plan ?? payload.description;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Issue" value={payload.issueId ? String(payload.issueId).slice(0, 8) : null} />
      <PayloadField label="Version" value={payload.version} />
      {!!content && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(content)}
        </div>
      )}
    </div>
  );
}

export function MergePrPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Repo" value={payload.repo} />
      <PayloadField label="PR" value={payload.pullNumber ? `#${payload.pullNumber}` : payload.pullUrl} />
      <PayloadField label="Base" value={payload.baseBranch} />
      <PayloadField label="Head" value={payload.headSha ? String(payload.headSha).slice(0, 8) : payload.headBranch} />
      <PayloadField label="CI" value={payload.ciStatus} />
      <PayloadField label="Review" value={payload.reviewStatus} />
      <PayloadField label="Quality" value={payload.qualityStatus} />
      {!!payload.pullUrl && (
        <a href={String(payload.pullUrl)} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
          Open pull request
        </a>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "plan_review") return <PlanReviewPayload payload={payload} />;
  if (type === "merge_pr") return <MergePrPayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
