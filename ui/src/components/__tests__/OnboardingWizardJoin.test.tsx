// Onboarding "Join an existing team" branch (Step 1 mode toggle).
//
// Covers the UI contract that matters for the join path:
//   1. The Step-1 mode toggle renders BOTH "Create a new company" and "Join an
//      existing team" buttons; create mode is the unchanged default.
//   2. Entering join mode when getStatus() reports an already-configured rail
//      (usingSeparateContextDb:true) HIDES the URL field and lists teams from the
//      active rail (POST /teams with no url).
//   3. A successful join selects the team (setSelectedCompanyId), invalidates
//      companies.all, and advances to Step 2.
//
// The heavy wizard deps (contexts, router, sibling APIs) are mocked so the test
// mounts without a real network or provider tree.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

const { setSelectedCompanyId, closeOnboarding, navigate, getStatus, listTeams, join, test } =
  vi.hoisted(() => ({
    setSelectedCompanyId: vi.fn(),
    closeOnboarding: vi.fn(),
    navigate: vi.fn(),
    getStatus: vi.fn(),
    listTeams: vi.fn(),
    join: vi.fn(),
    test: vi.fn(),
  }));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

// The decorative right-half ASCII animation pulls window.matchMedia (absent in
// jsdom) on mount — stub it out; it's irrelevant to the join flow.
vi.mock("../AsciiArtAnimation", () => ({ AsciiArtAnimation: () => null }));

vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({
    onboardingOpen: true,
    onboardingOptions: {},
    closeOnboarding,
  }),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: null,
    companies: [],
    setSelectedCompanyId,
  }),
}));

vi.mock("../../api/database", () => ({
  databaseApi: { getStatus, listTeams, join, test, save: vi.fn() },
}));

vi.mock("../../api/companies", () => ({ companiesApi: { create: vi.fn() } }));
vi.mock("../../api/goals", () => ({ goalsApi: { create: vi.fn() } }));
vi.mock("../../api/agents", () => ({
  agentsApi: { create: vi.fn(), adapterModels: vi.fn().mockResolvedValue([]), testEnvironment: vi.fn() },
}));
vi.mock("../../api/issues", () => ({ issuesApi: { create: vi.fn() } }));
vi.mock("../../api/health", () => ({
  healthApi: { get: vi.fn().mockResolvedValue({ database: null, adapters: null }) },
}));

import { OnboardingWizard } from "../OnboardingWizard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;

const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  setSelectedCompanyId.mockReset();
  closeOnboarding.mockReset();
  navigate.mockReset();
  getStatus.mockReset();
  listTeams.mockReset();
  join.mockReset();
  test.mockReset();
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <OnboardingWizard />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
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

function q<T extends Element = HTMLElement>(selector: string): T | null {
  // The wizard renders into a Radix portal on document.body, not `container`.
  return document.body.querySelector<T>(selector);
}

describe("OnboardingWizard — Join an existing team", () => {
  it("renders the Step-1 mode toggle with both create and join buttons", () => {
    getStatus.mockResolvedValue({
      mode: "embedded",
      usingSeparateContextDb: false,
      redactedEndpoint: "",
      serverVersion: null,
      memorySchemaPresent: false,
      memoryEntryCount: null,
      configuredVia: "default",
    });
    mount();
    expect(q('[data-mode="create"]')).toBeTruthy();
    expect(q('[data-mode="join"]')).toBeTruthy();
    // Create mode is the default: the company-name input is visible, no join panel.
    expect(q('input[placeholder="Acme Corp"]')).toBeTruthy();
    expect(q('[data-panel="join"]')).toBeNull();
  });

  it("join mode hides the URL field and lists teams when a rail is already configured", async () => {
    getStatus.mockResolvedValue({
      mode: "external",
      usingSeparateContextDb: true,
      redactedEndpoint: "postgres://admin:****@shared.internal:5432/combyne",
      serverVersion: "PostgreSQL 16.2",
      memorySchemaPresent: true,
      memoryEntryCount: 3,
      configuredVia: "config-file",
    });
    listTeams.mockResolvedValue({
      ok: true,
      companies: [{ id: "b405dc3d-3dbe-4d37-b1ad-3a3a8895192c", name: "Lending" }],
    });
    mount();

    await act(async () => {
      q<HTMLButtonElement>('[data-mode="join"]')!.click();
    });
    await flush();
    await flush();

    // URL field is hidden (already-configured rail), and /teams was called with NO url.
    expect(q('[data-slot="join-url"]')).toBeNull();
    expect(listTeams).toHaveBeenCalledWith(undefined);
    // The team from the active rail is listed.
    expect(q('[data-team-id="b405dc3d-3dbe-4d37-b1ad-3a3a8895192c"]')).toBeTruthy();
  });

  it("a successful join selects the team, invalidates companies, and advances to step 2", async () => {
    getStatus.mockResolvedValue({
      mode: "external",
      usingSeparateContextDb: true,
      redactedEndpoint: "postgres://admin:****@shared.internal:5432/combyne",
      serverVersion: "PostgreSQL 16.2",
      memorySchemaPresent: true,
      memoryEntryCount: 3,
      configuredVia: "config-file",
    });
    const teamId = "b405dc3d-3dbe-4d37-b1ad-3a3a8895192c";
    listTeams.mockResolvedValue({ ok: true, companies: [{ id: teamId, name: "Lending" }] });
    join.mockResolvedValue({
      joined: true,
      restartRequired: false,
      company: { id: teamId, name: "Lending", issuePrefix: "PINB405" },
      redactedEndpoint: "postgres://admin:****@shared.internal:5432/combyne",
      action: "kept",
    });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    mount();

    await act(async () => {
      q<HTMLButtonElement>('[data-mode="join"]')!.click();
    });
    await flush();
    await flush();

    // Pick the team.
    await act(async () => {
      q<HTMLButtonElement>(`[data-team-id="${teamId}"]`)!.click();
    });

    // Click "Join team" in the footer.
    await act(async () => {
      q<HTMLButtonElement>('[data-action="join-team"]')!.click();
    });
    await flush();
    await flush();

    expect(join).toHaveBeenCalledWith({ url: undefined, teamId, teamName: "Lending" });
    expect(setSelectedCompanyId).toHaveBeenCalledWith(teamId);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["companies"] });
    // Advanced to step 2: the agent step header is now rendered.
    expect(document.body.textContent).toContain("Create your first agent");
  });
});
