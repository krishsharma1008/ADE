import type { QuotaWindow } from "@combyne/shared";

// Minimal placeholder for the Claude subscription-quota breakdown panel.
// ProviderQuotaCard imports this as an optional inline section for
// `anthropic`; the real rendering is unshipped today but the import needs
// to resolve so typecheck is clean.
export function ClaudeSubscriptionPanel(_props: {
  quotaWindows: QuotaWindow[];
  quotaError?: string | null;
  quotaSource?: string | null;
  quotaLoading?: boolean;
}) {
  return null;
}
