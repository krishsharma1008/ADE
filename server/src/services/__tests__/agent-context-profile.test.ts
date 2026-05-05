import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies } from "@combyne/db";
import { resolveAgentContextProfile } from "../agent-context-profile.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("agent context profile resolver", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Context Profile Co" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("classifies IC roles including code review, backend engineering, QA, and DevOps as focused", async () => {
    const [codeReviewer] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Code Reviewer", role: "engineer", adapterType: "process" })
      .returning();
    const [backend] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Lending Backend Engineer", role: "engineer", adapterType: "process" })
      .returning();
    const [qa] = await handle.db
      .insert(agents)
      .values({ companyId, name: "QA Automation", role: "qa", adapterType: "process" })
      .returning();
    const [devops] = await handle.db
      .insert(agents)
      .values({ companyId, name: "DevOps Engineer", role: "devops", adapterType: "process" })
      .returning();

    await expect(resolveAgentContextProfile(handle.db, codeReviewer)).resolves.toBe("focused");
    await expect(resolveAgentContextProfile(handle.db, backend)).resolves.toBe("focused");
    await expect(resolveAgentContextProfile(handle.db, qa)).resolves.toBe("focused");
    await expect(resolveAgentContextProfile(handle.db, devops)).resolves.toBe("focused");
  });

  it("classifies CEO, EM, direct-report managers, and hiring-capable agents as coordinators", async () => {
    const [ceo] = await handle.db
      .insert(agents)
      .values({ companyId, name: "CEO", role: "ceo", adapterType: "process" })
      .returning();
    const [em] = await handle.db
      .insert(agents)
      .values({ companyId, name: "EM", role: "em", adapterType: "process" })
      .returning();
    const [lead] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Senior Engineer", role: "engineer", adapterType: "process" })
      .returning();
    await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "Direct Report",
        role: "engineer",
        reportsTo: lead.id,
        adapterType: "process",
      });
    const [hiringCapable] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "Hiring Operator",
        role: "general",
        permissions: { canCreateAgents: true },
        adapterType: "process",
      })
      .returning();

    await expect(resolveAgentContextProfile(handle.db, ceo)).resolves.toBe("coordinator");
    await expect(resolveAgentContextProfile(handle.db, em)).resolves.toBe("coordinator");
    await expect(resolveAgentContextProfile(handle.db, lead)).resolves.toBe("coordinator");
    await expect(resolveAgentContextProfile(handle.db, hiringCapable)).resolves.toBe("coordinator");
  });

  it("honors explicit adapterConfig contextProfile overrides", async () => {
    const [focused] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "Forced Focus CEO",
        role: "ceo",
        adapterType: "process",
        adapterConfig: { contextProfile: "focused" },
      })
      .returning();
    const [coordinator] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "Forced Coordinator IC",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { contextProfile: "coordinator" },
      })
      .returning();
    const [legacy] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: "Legacy IC",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { contextProfile: "legacy" },
      })
      .returning();

    await expect(resolveAgentContextProfile(handle.db, focused)).resolves.toBe("focused");
    await expect(resolveAgentContextProfile(handle.db, coordinator)).resolves.toBe("coordinator");
    await expect(resolveAgentContextProfile(handle.db, legacy)).resolves.toBe("legacy");
  });
});
