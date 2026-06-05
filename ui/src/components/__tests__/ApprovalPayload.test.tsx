import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval } from "@combyne/shared";

// Stub the router so <Link> renders a plain anchor we can assert against the
// merge_pr deep link. Must be hoisted ABOVE the ApprovalCard import below.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

import { ApprovalCard } from "@/components/ApprovalCard";
import { typeLabel } from "@/components/ApprovalPayload";

/**
 * Renders ApprovalCard for a pending merge_pr approval to static HTML (no
 * @testing-library — react-dom/server is already a transitive dep) and asserts
 * the merge-PR copy reads as "sign-off only, not a merge" across the card +
 * payload note, and that the GitHub deep link is preserved.
 */
function renderMergePr(): string {
  const approval = {
    id: "approval-1",
    type: "merge_pr",
    status: "pending",
    payload: {
      issueId: "I-1",
      pullUrl: "https://github.com/x/y/pull/7",
      pullNumber: 7,
      repo: "x/y",
    },
    createdAt: new Date("2026-06-03T00:00:00Z"),
  } as unknown as Approval;

  return renderToStaticMarkup(
    <ApprovalCard
      approval={approval}
      requesterAgent={null}
      onApprove={() => {}}
      onReject={() => {}}
      isPending={false}
    />,
  );
}

describe("ApprovalCard merge_pr copy", () => {
  it("reads as sign-off-only and never as a one-click merge", () => {
    const html = renderMergePr();

    // New verb-consistent type label drives both the inbox card title + detail header.
    // The raw label value carries a bare "&"; React escapes it to "&amp;" in the DOM.
    expect(typeLabel.merge_pr).toBe("PR ready — open & merge in PR panel");
    expect(html).toContain("PR ready — open &amp; merge in PR panel");

    // merge_pr action button now sends the human to the PR panel to merge…
    expect(html).toContain("Open PR panel to merge");
    // …and the old escaped phrase is gone.
    expect(html).not.toContain("Review &amp; merge in PR panel");

    // The payload note spells out that approving is sign-off only and does not merge.
    expect(html).toContain("records your sign-off only");
    expect(html).toContain("does <strong>not</strong> merge");

    // A merge_pr never wires the generic Approve button.
    expect(html).not.toContain(">Approve<");

    // The GitHub "Open pull request" deep link is preserved.
    expect(html).toContain("Open pull request");
    expect(html).toContain('href="https://github.com/x/y/pull/7"');
  });
});
