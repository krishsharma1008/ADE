import { describe, it, expect } from "vitest";

/**
 * Tests that all new schema tables from the Paperclip merge are properly
 * exported from the db schema barrel and have the expected structure.
 */
describe("New schema table exports", () => {
  it("exports all new tables from the schema index", async () => {
    const schema = await import("@combyne/db/schema");

    // Budget system
    expect(schema.budgetPolicies).toBeDefined();
    expect(schema.budgetIncidents).toBeDefined();

    // Board API keys
    expect(schema.boardApiKeys).toBeDefined();

    // CLI auth
    expect(schema.cliAuthChallenges).toBeDefined();

    // Company skills
    expect(schema.companySkills).toBeDefined();

    // Company logos
    expect(schema.companyLogos).toBeDefined();

    // Documents
    expect(schema.documents).toBeDefined();
    expect(schema.documentRevisions).toBeDefined();

    // Execution workspaces
    expect(schema.executionWorkspaces).toBeDefined();
    expect(schema.workspaceOperations).toBeDefined();
    expect(schema.workspaceRuntimeServices).toBeDefined();

    // Finance
    expect(schema.financeEvents).toBeDefined();

    // Instance settings
    expect(schema.instanceSettings).toBeDefined();

    // Issue extensions
    expect(schema.issueDocuments).toBeDefined();
    expect(schema.issueInboxArchives).toBeDefined();
    expect(schema.issueWorkProducts).toBeDefined();

    // Plugins
    expect(schema.plugins).toBeDefined();
    expect(schema.pluginConfig).toBeDefined();
    expect(schema.pluginState).toBeDefined();
    expect(schema.pluginJobs).toBeDefined();
    expect(schema.pluginJobRuns).toBeDefined();
    expect(schema.pluginEntities).toBeDefined();
    expect(schema.pluginWebhookDeliveries).toBeDefined();
    expect(schema.pluginLogs).toBeDefined();
    expect(schema.pluginCompanySettings).toBeDefined();

    // Routines
    expect(schema.routines).toBeDefined();
    expect(schema.routineTriggers).toBeDefined();
    expect(schema.routineRuns).toBeDefined();
  });

  it("all new tables have an 'id' column", async () => {
    const schema = await import("@combyne/db/schema");

    const newTables = [
      schema.budgetPolicies,
      schema.budgetIncidents,
      schema.boardApiKeys,
      schema.cliAuthChallenges,
      schema.companySkills,
      schema.companyLogos,
      schema.documents,
      schema.documentRevisions,
      schema.executionWorkspaces,
      schema.workspaceOperations,
      schema.workspaceRuntimeServices,
      schema.financeEvents,
      schema.instanceSettings,
      schema.issueDocuments,
      schema.issueInboxArchives,
      schema.issueWorkProducts,
      schema.plugins,
      schema.pluginConfig,
      schema.pluginState,
      schema.pluginJobs,
      schema.pluginJobRuns,
      schema.pluginEntities,
      schema.pluginWebhookDeliveries,
      schema.pluginLogs,
      schema.pluginCompanySettings,
      schema.routines,
      schema.routineTriggers,
      schema.routineRuns,
    ];

    for (const table of newTables) {
      // Drizzle table objects have a column accessor
      expect((table as any).id).toBeDefined();
    }
  });
});
