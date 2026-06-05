import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock the database API so the page renders without any real network call. The
// status query resolves to a redacted-endpoint shape (the credential is already
// masked server-side; the UI never receives the raw password).
vi.mock("@/api/database", () => ({
  databaseApi: {
    getStatus: vi.fn().mockResolvedValue({
      mode: "embedded",
      usingSeparateContextDb: false,
      redactedEndpoint: "postgres://admin:****@db.internal:5432/combyne",
      serverVersion: "PostgreSQL 16.2",
      memorySchemaPresent: true,
      memoryEntryCount: 7,
      configuredVia: "default",
    }),
    test: vi.fn(),
    save: vi.fn(),
    saveEmbeddingConfig: vi.fn(),
  },
}));

import { MemoryDatabase } from "@/pages/memory/MemoryDatabase";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe("MemoryDatabase", () => {
  it("renders the DATABASE URL input as a masked (type=password) field", () => {
    const el = mount(<MemoryDatabase />);
    const input = el.querySelector('[data-slot="ctx-db-url"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    // The credential field must be masked — never a plain visible text input.
    expect(input!.getAttribute("type")).toBe("password");
  });

  it("exposes Test and Save actions and the safe-switch-order guidance", () => {
    const el = mount(<MemoryDatabase />);
    expect(el.querySelector('[data-action="test"]')).not.toBeNull();
    expect(el.querySelector('[data-action="save"]')).not.toBeNull();
    // The safe switch order panel walks test → migrate → import → save → restart.
    expect(el.textContent ?? "").toContain("Safe switch order");
    expect((el.textContent ?? "").toLowerCase()).toContain("restart");
  });
});
