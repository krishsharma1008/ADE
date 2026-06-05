import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeMemoryEntryFixture } from "@/components/memory/memoryFixtures";

// Mock the api + company so the Questions tab renders the ask-don't-hallucinate
// loop (question → answer → reusable entry) without a network call.
const listQuestions = vi.fn();

vi.mock("@/api/memory", () => ({
  memoryApi: {
    listQuestions: (...args: unknown[]) => listQuestions(...args),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

import { MemoryQuestions } from "@/pages/memory/MemoryQuestions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  listQuestions.mockReset();
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

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("MemoryQuestions", () => {
  it("renders the loop: the question asked, the answer captured, the citation, and acknowledge state", async () => {
    const entry = makeMemoryEntryFixture({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      provenance: "human-answer",
    });
    listQuestions.mockResolvedValue([
      {
        entry,
        question: "How should we name Kafka topics?",
        answer: "Use <service>.<entity>.<event>, lowercase.",
        citation: "comment #9",
        answeredAt: "2026-06-01T12:00:00.000Z",
        acknowledged: true,
      },
    ]);

    const el = mount(<MemoryQuestions />);
    await flush();

    const row = el.querySelector(`[data-question-entry="${entry.id}"]`);
    expect(row).not.toBeNull();
    // The question that was asked.
    expect(el.querySelector("[data-question]")?.textContent ?? "").toContain(
      "How should we name Kafka topics?",
    );
    // The answer that was captured.
    expect(el.querySelector("[data-answer]")?.textContent ?? "").toContain(
      "Use <service>.<entity>.<event>",
    );
    // The source citation tracing back to where the answer was given.
    expect(el.querySelector("[data-citation]")?.textContent ?? "").toContain("comment #9");
    // Acknowledged loop entries are flagged (vs. awaiting review).
    expect(el.querySelector("[data-acknowledged]")).not.toBeNull();
  });

  it("renders an empty state when no human answers have been captured", async () => {
    listQuestions.mockResolvedValue([]);
    const el = mount(<MemoryQuestions />);
    await flush();
    expect((el.textContent ?? "").toLowerCase()).toContain("no captured human answers");
  });
});
