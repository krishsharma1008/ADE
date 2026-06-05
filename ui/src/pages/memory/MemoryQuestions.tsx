import { useQuery } from "@tanstack/react-query";
import type { MemoryQuestionItem } from "@combyne/shared";
import { HelpCircle, ArrowRight, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "../../context/CompanyContext";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { MemoryCitationLine } from "../../components/memory/MemoryTrustBadges";

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

/**
 * Questions tab (PR-16 §3.1) — the ask-don't-hallucinate loop, made visible.
 * Each row is the full loop: the question an agent asked a human → the answer
 * the human gave (captured via HOOK 1 as a verified workspace memory entry) →
 * the reusable entry it became. Read-only audit. Unlike the Capture inbox (which
 * only shows the not-yet-acknowledged ones), this lists ALL human-answer entries.
 */
export function MemoryQuestions() {
  const { selectedCompanyId } = useCompany();

  const questionsQuery = useQuery({
    queryKey: queryKeys.memory.questions(selectedCompanyId!),
    queryFn: () => memoryApi.listQuestions(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const items = questionsQuery.data ?? [];

  return (
    <div className="space-y-4" data-tab="questions">
      <p className="text-sm text-muted-foreground">
        The ask-don&apos;t-hallucinate loop, made visible: a question an agent asked a human, the
        answer that was captured, and the reusable memory entry it became. Every captured
        human answer is reusable context for future work.
      </p>

      {questionsQuery.error && (
        <p className="text-sm text-destructive">
          {questionsQuery.error instanceof Error
            ? questionsQuery.error.message
            : "Failed to load questions"}
        </p>
      )}

      {items.length === 0 ? (
        <div className="rounded-md border border-border p-8">
          <EmptyState icon={HelpCircle} message="No captured human answers yet." />
        </div>
      ) : (
        <div className="grid gap-3">
          {items.map((item: MemoryQuestionItem) => (
            <article
              key={item.entry.id}
              className="overflow-hidden rounded-md border border-border"
              data-question-entry={item.entry.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Source:</span>
                  {item.citation ? (
                    <Badge variant="outline" data-citation>
                      {item.citation}
                    </Badge>
                  ) : (
                    <span className="italic">no citation</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {item.acknowledged ? (
                    <Badge
                      variant="outline"
                      className="border-green-500 text-green-500"
                      data-acknowledged
                    >
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      acknowledged
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-yellow-500 text-yellow-500">
                      awaiting review
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Answered {formatDate(item.answeredAt)}
                  </span>
                </div>
              </div>

              <div className="space-y-3 p-3">
                <div className="flex items-start gap-2" data-question>
                  <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-muted-foreground">Question asked</div>
                    <p className="text-sm">{item.question ?? item.entry.subject}</p>
                  </div>
                </div>

                <div className="flex items-start gap-2" data-answer>
                  <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-muted-foreground">Answer captured</div>
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                      {item.answer ?? item.entry.body}
                    </p>
                  </div>
                </div>

                <MemoryCitationLine
                  id={item.entry.id}
                  provenance={item.entry.provenance}
                  confidence={item.entry.confidence}
                  sourceRefType={item.entry.sourceRefType}
                  sourceRefId={item.entry.sourceRefId}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
