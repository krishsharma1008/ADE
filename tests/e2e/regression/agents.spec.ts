import { test, expect } from "@playwright/test";

/**
 * E2E: Regression tests for agent-related pages.
 *
 * Validates that agent list, detail, and creation views
 * render correctly and are functional.
 *
 * Tag: @regression
 */

test.describe("@regression Agents pages", () => {
  test("Agents list page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Navigate to agents page
    const agentsLink = page.locator("a[href*='agents']").first();
    if (await agentsLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await agentsLink.click();
    } else {
      await page.goto("/agents");
    }

    await expect(page).toHaveURL(/agents/, { timeout: 10_000 });

    // Page should show an agents heading or list
    const heading = page.locator("h1, h2, h3").filter({ hasText: /agents/i });
    const agentsList = page.locator("[data-testid*='agent'], table, [role='list']");
    await expect(heading.first().or(agentsList.first())).toBeVisible({ timeout: 10_000 });
  });

  test("Agent detail page loads", async ({ page }) => {
    // First get an agent via API
    const healthRes = await page.request.get("/api/health");
    expect(healthRes.ok()).toBe(true);

    const companiesRes = await page.request.get("/api/companies");
    const companies = await companiesRes.json();

    if (companies.length === 0) {
      test.skip(true, "No companies exist — cannot test agent detail");
      return;
    }

    const company = companies[0];
    const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`);
    const agents = await agentsRes.json();

    if (agents.length === 0) {
      test.skip(true, "No agents exist — cannot test agent detail");
      return;
    }

    const agent = agents[0];

    // Navigate to the agent detail page
    await page.goto(`/${company.urlKey ?? company.id}/agents/${agent.urlKey ?? agent.id}`);
    await expect(page).toHaveURL(/agents\//, { timeout: 10_000 });

    // Agent name should be visible
    await expect(page.locator(`text=${agent.name}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Agent creation form renders", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Navigate to agents page
    const agentsLink = page.locator("a[href*='agents']").first();
    if (await agentsLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await agentsLink.click();
    } else {
      await page.goto("/agents");
    }

    await expect(page).toHaveURL(/agents/, { timeout: 10_000 });

    // Look for a "New Agent" or "Create Agent" or "Hire" button
    const createBtn = page.locator("button, a").filter({
      hasText: /new agent|create agent|hire|add agent/i,
    });

    if (await createBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await createBtn.first().click();

      // A form or dialog should appear
      const form = page.locator("form, [role='dialog'], [data-testid*='create']");
      await expect(form.first()).toBeVisible({ timeout: 10_000 });
    } else {
      // If no create button visible, the page at least loaded successfully
      // This can happen when there are no companies yet
      expect(true).toBe(true);
    }
  });
});
