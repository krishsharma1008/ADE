import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Integration tests verifying the Paperclip→Combyne merge is complete
 * and structurally sound.
 */
describe("Merge structural integrity", () => {
  describe("Schema files exist", () => {
    const expectedSchemaFiles = [
      "budget_policies.ts",
      "budget_incidents.ts",
      "board_api_keys.ts",
      "cli_auth_challenges.ts",
      "company_skills.ts",
      "company_logos.ts",
      "documents.ts",
      "document_revisions.ts",
      "execution_workspaces.ts",
      "workspace_operations.ts",
      "workspace_runtime_services.ts",
      "finance_events.ts",
      "instance_settings.ts",
      "issue_documents.ts",
      "issue_inbox_archives.ts",
      "issue_work_products.ts",
      "plugins.ts",
      "plugin_config.ts",
      "plugin_state.ts",
      "plugin_jobs.ts",
      "plugin_entities.ts",
      "plugin_webhooks.ts",
      "plugin_logs.ts",
      "plugin_company_settings.ts",
      "routines.ts",
    ];

    for (const file of expectedSchemaFiles) {
      it(`schema/${file} exists`, () => {
        const filePath = path.join(ROOT, "packages/db/src/schema", file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe("Service files exist", () => {
    const expectedServiceFiles = [
      "cron.ts",
      "routines.ts",
      "execution-workspaces.ts",
      "budgets.ts",
      "documents.ts",
      "work-products.ts",
      "company-skills.ts",
      "finance.ts",
      "instance-settings.ts",
      "plugin-loader.ts",
      "plugin-lifecycle.ts",
      "plugin-worker-manager.ts",
      "plugin-event-bus.ts",
      "plugin-registry.ts",
    ];

    for (const file of expectedServiceFiles) {
      it(`services/${file} exists`, () => {
        const filePath = path.join(ROOT, "server/src/services", file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe("Route files exist", () => {
    const expectedRouteFiles = [
      "routines.ts",
      "execution-workspaces.ts",
      "company-skills.ts",
      "plugins.ts",
      "instance-settings.ts",
      "org-chart-svg.ts",
    ];

    for (const file of expectedRouteFiles) {
      it(`routes/${file} exists`, () => {
        const filePath = path.join(ROOT, "server/src/routes", file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe("UI pages exist", () => {
    const expectedPages = [
      "Routines.tsx",
      "RoutineDetail.tsx",
      "CompanySkills.tsx",
      "PluginManager.tsx",
      "PluginPage.tsx",
      "PluginSettings.tsx",
      "InstanceSettings.tsx",
      "CompanyExport.tsx",
      "CompanyImport.tsx",
      "ExecutionWorkspaceDetail.tsx",
      "NotFound.tsx",
    ];

    for (const file of expectedPages) {
      it(`pages/${file} exists`, () => {
        const filePath = path.join(ROOT, "ui/src/pages", file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }
  });

  describe("UI components exist", () => {
    const expectedComponents = [
      "BudgetPolicyCard.tsx",
      "BudgetIncidentCard.tsx",
      "ScheduleEditor.tsx",
      "IssueDocumentsSection.tsx",
      "PluginManager.tsx",
      "SwipeToArchive.tsx",
      "JsonSchemaForm.tsx",
      "WorktreeBanner.tsx",
    ];

    for (const file of expectedComponents) {
      it(`components/${file} exists`, () => {
        const candidates = [
          path.join(ROOT, "ui/src/components", file),
          path.join(ROOT, "ui/src/pages", file), // Some may be pages
        ];
        const exists = candidates.some((p) => fs.existsSync(p));
        expect(exists).toBe(true);
      });
    }
  });

  describe("Gemini adapter exists", () => {
    it("gemini-local package.json exists", () => {
      const filePath = path.join(ROOT, "packages/adapters/gemini-local/package.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("gemini-local uses @combyne scope", () => {
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(ROOT, "packages/adapters/gemini-local/package.json"),
          "utf-8",
        ),
      );
      expect(pkg.name).toContain("@combyne");
    });
  });

  describe("Plugin SDK exists", () => {
    it("plugin-sdk package.json exists", () => {
      const filePath = path.join(ROOT, "packages/plugins/sdk/package.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("plugin-sdk uses @combyne scope", () => {
      const pkg = JSON.parse(
        fs.readFileSync(
          path.join(ROOT, "packages/plugins/sdk/package.json"),
          "utf-8",
        ),
      );
      expect(pkg.name).toContain("@combyne");
    });
  });

  describe("App.tsx has new routes", () => {
    it("imports new page components", () => {
      const appContent = fs.readFileSync(
        path.join(ROOT, "ui/src/App.tsx"),
        "utf-8",
      );
      expect(appContent).toContain("Routines");
      expect(appContent).toContain("PluginManager");
      expect(appContent).toContain("CompanySkills");
      expect(appContent).toContain("InstanceSettings");
      expect(appContent).toContain("CompanyExport");
      expect(appContent).toContain("CompanyImport");
      expect(appContent).toContain("ExecutionWorkspaceDetail");
      expect(appContent).toContain("NotFound");
    });

    it("has route paths for new features", () => {
      const appContent = fs.readFileSync(
        path.join(ROOT, "ui/src/App.tsx"),
        "utf-8",
      );
      expect(appContent).toContain('path="routines"');
      expect(appContent).toContain('path="plugins"');
      expect(appContent).toContain('path="skills"');
      expect(appContent).toContain('path="settings/instance"');
    });
  });

  describe("app.ts has new route registrations", () => {
    it("imports and mounts new routes", () => {
      const appContent = fs.readFileSync(
        path.join(ROOT, "server/src/app.ts"),
        "utf-8",
      );
      expect(appContent).toContain("routineRoutes");
      expect(appContent).toContain("executionWorkspaceRoutes");
      expect(appContent).toContain("companySkillRoutes");
      expect(appContent).toContain("pluginRoutes");
      expect(appContent).toContain("instanceSettingsRoutes");
      // orgChartSvgRoutes is a rendering utility, not an Express router — no route mount needed
      expect(appContent).toContain("fileOpsRoutes");
    });
  });

  describe("pnpm workspace includes plugins", () => {
    it("has plugins/* in workspace config", () => {
      const wsConfig = fs.readFileSync(
        path.join(ROOT, "pnpm-workspace.yaml"),
        "utf-8",
      );
      expect(wsConfig).toContain("packages/plugins/*");
    });
  });

  describe("Combyne-specific features preserved", () => {
    it("license service still exists", () => {
      expect(
        fs.existsSync(path.join(ROOT, "server/src/services/license.ts")),
      ).toBe(true);
    });

    it("license gate middleware still exists", () => {
      expect(
        fs.existsSync(path.join(ROOT, "server/src/middleware/license-gate.ts")),
      ).toBe(true);
    });

    it("Jira integration still exists", () => {
      expect(
        fs.existsSync(path.join(ROOT, "server/src/services/jira.ts")),
      ).toBe(true);
    });

    it("Confluent integration still exists", () => {
      expect(
        fs.existsSync(path.join(ROOT, "server/src/services/confluent.ts")),
      ).toBe(true);
    });

    it("GitHub integration still exists", () => {
      expect(
        fs.existsSync(path.join(ROOT, "server/src/services/github.ts")),
      ).toBe(true);
    });

    it("SonarQube integration still exists", () => {
      expect(
        fs.existsSync(path.join(ROOT, "server/src/services/sonarqube.ts")),
      ).toBe(true);
    });

    it("personas service still exists", () => {
      expect(
        fs.existsSync(path.join(ROOT, "server/src/services/personas.ts")),
      ).toBe(true);
    });

    it("macOS installer still exists", () => {
      expect(
        fs.existsSync(path.join(ROOT, "installers/macos/swift-app")),
      ).toBe(true);
    });

    it("company_integrations schema still exists", () => {
      expect(
        fs.existsSync(
          path.join(ROOT, "packages/db/src/schema/company_integrations.ts"),
        ),
      ).toBe(true);
    });
  });
});
