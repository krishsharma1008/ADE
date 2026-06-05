import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRedactionCard } from "@/components/memory/MemoryRedactionCard";
import { makeMemoryEntryFixture } from "@/components/memory/memoryFixtures";

// React 19 act() with a real concurrent root in jsdom (mirrors the existing
// MemoryConflictResolver test — no @testing-library dependency).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

// The body carries a (fake) credential — the exact thing the redaction queue
// quarantines and the UI must NOT leak before an explicit Reveal.
const SECRET_BODY = "the prod database password is sk-live-SUPERSECRET-do-not-leak";

function makeEntry() {
  return makeMemoryEntryFixture({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    subject: "Quarantined credential-bearing answer",
    body: SECRET_BODY,
    provenance: "human-answer",
    verificationState: "needs_review",
    verifiedBy: null,
    verifiedAt: null,
  });
}

describe("MemoryRedactionCard", () => {
  it("masks the body by default — the secret is NOT in the DOM before Reveal", () => {
    const el = mount(<MemoryRedactionCard entry={makeEntry()} onResolve={vi.fn()} />);

    // The masked placeholder is shown; the raw body element is absent.
    expect(el.querySelector("[data-masked-body]")).not.toBeNull();
    expect(el.querySelector("[data-revealed-body]")).toBeNull();
    // The hard leak guard: the secret string is nowhere in the rendered DOM.
    expect(el.textContent ?? "").not.toContain("SUPERSECRET");
    expect(el.innerHTML).not.toContain("SUPERSECRET");
  });

  it("renders the raw body only after an explicit Reveal click", () => {
    const el = mount(<MemoryRedactionCard entry={makeEntry()} onResolve={vi.fn()} />);

    click(el.querySelector('[data-action="reveal-toggle"]'));

    expect(el.querySelector("[data-revealed-body]")).not.toBeNull();
    expect(el.querySelector("[data-masked-body]")).toBeNull();
    expect(el.textContent ?? "").toContain("SUPERSECRET");

    // Toggling back re-masks and removes the secret from the DOM again.
    click(el.querySelector('[data-action="reveal-toggle"]'));
    expect(el.querySelector("[data-revealed-body]")).toBeNull();
    expect(el.textContent ?? "").not.toContain("SUPERSECRET");
  });

  it("fires onResolve with the right action for Approve and Keep-redacted", () => {
    const onResolve = vi.fn();
    const entry = makeEntry();
    const el = mount(<MemoryRedactionCard entry={entry} onResolve={onResolve} />);

    click(el.querySelector('[data-action="approve"]'));
    expect(onResolve).toHaveBeenLastCalledWith(entry.id, "approve");

    click(el.querySelector('[data-action="reject"]'));
    expect(onResolve).toHaveBeenLastCalledWith(entry.id, "reject");
  });
});
