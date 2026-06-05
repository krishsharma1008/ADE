import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeMemoryEntryFixture } from "@/components/memory/memoryFixtures";

// The picker queries verified candidate entries (requireVerified + serviceScope)
// and lets the EM toggle which to pin. We mock the API so it resolves without a
// network call, and pin useCompany to a fixed company so the query is enabled.
const listEntries = vi.fn();

vi.mock("@/api/memory", () => ({
  memoryApi: {
    listEntries: (...args: unknown[]) => listEntries(...args),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

import { MemoryPassdownPicker } from "@/components/memory/MemoryPassdownPicker";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  listEntries.mockReset();
});

function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
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
  client.clear();
});

// Let the mocked query resolve and the component re-render. react-query resolves
// the queryFn promise then schedules a state update, so we pump a few macrotasks.
async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

const VERIFIED_A = makeMemoryEntryFixture({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  subject: "Billing topics use snake_case",
  verificationState: "verified",
});
const VERIFIED_B = makeMemoryEntryFixture({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  subject: "Retries back off exponentially",
  verificationState: "verified",
});

describe("MemoryPassdownPicker", () => {
  it("requests verified candidates scoped to the child issue serviceScope", async () => {
    listEntries.mockResolvedValue([VERIFIED_A]);
    mount(
      <MemoryPassdownPicker
        serviceScope="billing"
        title="topics"
        selectedIds={[]}
        onChange={vi.fn()}
      />,
    );
    await flush();
    expect(listEntries).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ verificationState: "verified", serviceScope: "billing" }),
    );
  });

  it("toggling a candidate fires onChange to pin / unpin the entry id", async () => {
    listEntries.mockResolvedValue([VERIFIED_A, VERIFIED_B]);
    const onChange = vi.fn();
    const el = mount(
      <MemoryPassdownPicker serviceScope={null} title="" selectedIds={[]} onChange={onChange} />,
    );
    await flush();

    // Both verified candidates render as checkbox rows.
    expect(el.querySelector(`[data-candidate="${VERIFIED_A.id}"]`)).not.toBeNull();
    expect(el.querySelector(`[data-candidate="${VERIFIED_B.id}"]`)).not.toBeNull();

    // Clicking a row's checkbox pins it (adds its id via onChange).
    const checkboxA = el
      .querySelector(`[data-candidate="${VERIFIED_A.id}"]`)
      ?.querySelector('[data-slot="checkbox"]');
    click(checkboxA ?? null);
    expect(onChange).toHaveBeenLastCalledWith([VERIFIED_A.id]);
  });

  it("un-pins an already-selected entry", async () => {
    listEntries.mockResolvedValue([VERIFIED_A]);
    const onChange = vi.fn();
    const el = mount(
      <MemoryPassdownPicker
        serviceScope={null}
        title=""
        selectedIds={[VERIFIED_A.id]}
        onChange={onChange}
      />,
    );
    await flush();

    // Already pinned → the selected-count surfaces and clicking removes it.
    expect((el.querySelector("[data-selected-count]")?.textContent ?? "")).toContain("1 pinned");
    const checkboxA = el
      .querySelector(`[data-candidate="${VERIFIED_A.id}"]`)
      ?.querySelector('[data-slot="checkbox"]');
    click(checkboxA ?? null);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("shows an empty state when there are no verified candidates", async () => {
    listEntries.mockResolvedValue([]);
    const el = mount(
      <MemoryPassdownPicker
        serviceScope="payments"
        title=""
        selectedIds={[]}
        onChange={vi.fn()}
      />,
    );
    await flush();
    expect((el.textContent ?? "").toLowerCase()).toContain("no verified entries");
  });
});
