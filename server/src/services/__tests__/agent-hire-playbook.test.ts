import { describe, expect, it } from "vitest";
import {
  agentCanHire,
  buildHirePlaybook,
  detectHireIntent,
} from "../agent-hire-playbook.js";

describe("agent-hire-playbook", () => {
  describe("detectHireIntent", () => {
    it("matches the canonical 'Create a new agent' phrasing", () => {
      expect(
        detectHireIntent({ title: "Create a new agent", description: "lending engineer" }),
      ).toBe(true);
    });

    it("matches variations across title and description", () => {
      const cases: Array<{ title: string; description: string | null }> = [
        { title: "Hire a new engineer for the lending team", description: null },
        { title: "Onboard a QA agent", description: null },
        { title: "Spin up an agent to handle the BNPL flow", description: null },
        { title: "Recruit a designer", description: null },
        { title: "new hire request", description: null },
        { title: "Create agent", description: null },
        { title: "Add new agent", description: null },
      ];
      for (const c of cases) {
        expect(detectHireIntent(c)).toBe(true);
      }
    });

    it("matches when intent is in the description only", () => {
      expect(
        detectHireIntent({
          title: "TES-10",
          description: "please hire an engineer who can own the lending api",
        }),
      ).toBe(true);
    });

    it("does not match unrelated issues", () => {
      const cases: Array<{ title: string; description: string | null }> = [
        { title: "Fix the bug in the lending api", description: "users see 500s" },
        { title: "Plan the next quarter roadmap", description: null },
        { title: "Review the new PR", description: "PR #123 needs eyes" },
        { title: "", description: "" },
      ];
      for (const c of cases) {
        expect(detectHireIntent(c)).toBe(false);
      }
    });

    it("tolerates null / missing fields", () => {
      expect(detectHireIntent(null as unknown as { title: string; description: string | null })).toBe(
        false,
      );
      expect(detectHireIntent({ title: "", description: null })).toBe(false);
    });
  });

  describe("agentCanHire", () => {
    it("treats the ceo role as implicitly allowed", () => {
      expect(agentCanHire({ id: "a", role: "ceo", permissions: null })).toBe(true);
      expect(agentCanHire({ id: "a", role: "ceo", permissions: { canCreateAgents: false } })).toBe(
        true,
      );
    });

    it("allows any role with canCreateAgents=true", () => {
      expect(
        agentCanHire({ id: "a", role: "engineer", permissions: { canCreateAgents: true } }),
      ).toBe(true);
    });

    it("rejects non-ceo agents without the permission", () => {
      expect(
        agentCanHire({ id: "a", role: "engineer", permissions: { canCreateAgents: false } }),
      ).toBe(false);
      expect(agentCanHire({ id: "a", role: "engineer", permissions: null })).toBe(false);
    });
  });

  describe("buildHirePlaybook", () => {
    it("includes the company id, approval endpoint, and the issue summary", () => {
      const body = buildHirePlaybook({
        companyId: "company-123",
        issue: {
          title: "Create a new agent",
          description: "lending engineer. owns /services/lending-api.",
        },
      });
      expect(body).toMatch(/Hire-agent playbook/);
      expect(body).toMatch(/Create a new agent/);
      expect(body).toMatch(/lending engineer/);
      expect(body).toMatch(/company-123\/approvals/);
      expect(body).toMatch(/"type": "hire_agent"/);
      expect(body).toMatch(/\/ask-user/);
      expect(body).toMatch(/Do not.*stand by/i);
    });
  });
});
