import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryEntryCard } from "@/components/memory/MemoryEntryCard";
import { makeMemoryEntryFixture } from "@/components/memory/memoryFixtures";

/**
 * Renders MemoryEntryCard to static HTML (no @testing-library dependency — we
 * use react-dom/server, which is already a transitive dep) and asserts the
 * trust-spine surfaces are correct per provenance/verification state.
 */
function render(entry: Parameters<typeof MemoryEntryCard>[0]["entry"]) {
  return renderToStaticMarkup(<MemoryEntryCard entry={entry} />);
}

describe("MemoryEntryCard", () => {
  it("renders a verified human-answer entry with the correct badges + citation", () => {
    const entry = makeMemoryEntryFixture({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      sourceRefType: "comment",
      sourceRefId: "comment-9",
    });
    const html = render(entry);

    // Provenance + verification badges (data attributes carry the canonical value).
    expect(html).toContain('data-provenance="human-answer"');
    expect(html).toContain('data-verification="verified"');
    expect(html).toContain("human answer");
    expect(html).toContain("verified");

    // Verified reuses the green StatusBadge color map; not the amber/red ones.
    expect(html).toContain("bg-green-100");

    // Citation line in the [mem:<id> · <provenance> · conf=<n> · ref=<type>:<id>] format.
    expect(html).toContain("[mem:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(html).toContain("conf=0.95");
    expect(html).toContain("ref=comment:comment-9");

    // Confidence meter resolves to the high (green) bucket at 0.95.
    expect(html).toContain('data-confidence-level="high"');
  });

  it("renders an unverified agent-claim entry with the amber chip and low-confidence meter", () => {
    const entry = makeMemoryEntryFixture({
      provenance: "agent-claim",
      verificationState: "unverified",
      confidence: 0.3,
      sourceRefType: "run",
      sourceRefId: "run-7",
    });
    const html = render(entry);

    expect(html).toContain('data-provenance="agent-claim"');
    expect(html).toContain('data-verification="unverified"');
    expect(html).toContain("agent claim");
    // unverified reuses the amber StatusBadge color (awaiting_user key).
    expect(html).toContain("bg-amber-100");
    // 0.3 < 0.4 → low-confidence (red) bucket.
    expect(html).toContain('data-confidence-level="low"');
    expect(html).toContain("ref=run:run-7");
  });

  it("renders a needs_review entry with the red verification chip", () => {
    const entry = makeMemoryEntryFixture({
      provenance: "human-answer",
      verificationState: "needs_review",
      confidence: 0.5,
    });
    const html = render(entry);

    expect(html).toContain('data-verification="needs_review"');
    expect(html).toContain("needs review");
    // needs_review reuses the red StatusBadge color (failed key).
    expect(html).toContain("bg-red-100");
    // 0.5 is in the [0.4, 0.7) medium (yellow) bucket.
    expect(html).toContain('data-confidence-level="medium"');
  });

  it("marks a superseded entry with the struck/ superseded state", () => {
    const entry = makeMemoryEntryFixture({
      supersededById: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const html = render(entry);

    expect(html).toContain('data-superseded="true"');
    expect(html).toContain("line-through");
    expect(html).toContain("superseded");
  });
});
