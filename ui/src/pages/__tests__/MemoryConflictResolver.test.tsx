import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MemoryConflictGroup } from "@combyne/shared";
import { MemoryConflictResolver } from "@/components/memory/MemoryConflictResolver";
import { makeMemoryEntryFixture } from "@/components/memory/memoryFixtures";

// React 19 act() with a real concurrent root in jsdom. No @testing-library
// dependency — we drive real DOM click events through act().
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

// Two conflicting human-answers on the same subjectKey. The SECOND (newer
// updatedAt) is `older`'s rival and is the newest-by-that-user the resolver must
// pre-highlight.
const olderId = "11111111-1111-4111-8111-111111111111";
const newerId = "22222222-2222-4222-8222-222222222222";

function makeGroup(): MemoryConflictGroup {
  const older = makeMemoryEntryFixture({
    id: olderId,
    body: "Use snake_case for Kafka topics.",
    authorId: "user-old",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  const newer = makeMemoryEntryFixture({
    id: newerId,
    body: "Use dot.delimited lowercase for Kafka topics.",
    authorId: "user-new",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  return {
    subjectKey: "kafka topics naming convention",
    subject: "Kafka topic naming",
    entries: [newer, older],
    newestByThatUserId: newerId,
  };
}

describe("MemoryConflictResolver", () => {
  it("pre-highlights the newest-by-that-user entry", () => {
    const el = mount(<MemoryConflictResolver group={makeGroup()} onResolve={vi.fn()} />);

    const newest = el.querySelector(`[data-conflict-entry="${newerId}"]`);
    const older = el.querySelector(`[data-conflict-entry="${olderId}"]`);
    expect(newest?.getAttribute("data-selected")).toBe("true");
    expect(newest?.getAttribute("data-newest-by-user")).toBe("true");
    expect(older?.getAttribute("data-selected")).toBeNull();
    // The "newest by user" badge is rendered on the newest card only.
    expect(newest?.querySelector("[data-newest-badge]")).not.toBeNull();
    expect(older?.querySelector("[data-newest-badge]")).toBeNull();
  });

  it("OVERRIDE fires resolveConflict with the pre-selected canonical id", () => {
    const onResolve = vi.fn();
    const el = mount(<MemoryConflictResolver group={makeGroup()} onResolve={onResolve} />);

    click(el.querySelector('[data-action="override"]'));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({ action: "override", canonicalEntryId: newerId });
  });

  it("MERGE seeds the editor from BOTH bodies and writes a new canonical", () => {
    const onResolve = vi.fn();
    const el = mount(<MemoryConflictResolver group={makeGroup()} onResolve={onResolve} />);

    click(el.querySelector('[data-action="merge-open"]'));
    const textarea = el.querySelector("[data-merge-editor] textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    // Seed contains BOTH bodies.
    expect(textarea.value).toContain("snake_case");
    expect(textarea.value).toContain("dot.delimited");

    click(el.querySelector('[data-action="merge"]'));
    expect(onResolve).toHaveBeenCalledTimes(1);
    const call = onResolve.mock.calls[0][0];
    expect(call.action).toBe("merge");
    expect(call.canonicalEntryId).toBeUndefined();
    expect(call.body).toContain("snake_case");
    expect(call.body).toContain("dot.delimited");
  });

  it("EDIT fires resolveConflict with the canonical id and edited body", () => {
    const onResolve = vi.fn();
    const el = mount(<MemoryConflictResolver group={makeGroup()} onResolve={onResolve} />);

    // Select the OLDER card, then open Edit — the editor seeds from the selected card.
    click(el.querySelector(`[data-conflict-entry="${olderId}"]`));
    click(el.querySelector('[data-action="edit-open"]'));
    const textarea = el.querySelector("[data-edit-editor] textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("snake_case");

    click(el.querySelector('[data-action="edit"]'));
    expect(onResolve).toHaveBeenCalledTimes(1);
    const call = onResolve.mock.calls[0][0];
    expect(call.action).toBe("edit");
    expect(call.canonicalEntryId).toBe(olderId);
    expect(call.body).toContain("snake_case");
  });
});
