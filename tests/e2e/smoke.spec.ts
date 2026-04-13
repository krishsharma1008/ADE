import { test, expect } from "@playwright/test";

/**
 * E2E: Smoke tests — quick health checks to verify the app is alive.
 *
 * These tests are lightweight and should pass in seconds. Run them
 * before deeper regression or full E2E suites to catch catastrophic
 * failures early.
 *
 * Tag: @smoke
 */

test.describe("@smoke Core health checks", () => {
  test("API health endpoint returns 200", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    expect(response.status()).toBe(200);
  });

  test("Dashboard page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });
  });

  test("Navigation sidebar renders", async ({ page }) => {
    await page.goto("/");
    // Wait for the page to fully load
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Sidebar should contain key navigation links
    const sidebar = page.locator("nav, [role='navigation'], aside");
    await expect(sidebar.first()).toBeVisible({ timeout: 10_000 });
  });

  test("Agents page is accessible", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Navigate to agents — try clicking sidebar link or going directly
    const agentsLink = page.locator("a[href*='agents']").first();
    if (await agentsLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await agentsLink.click();
    } else {
      await page.goto("/agents");
    }

    await expect(page).toHaveURL(/agents/, { timeout: 10_000 });
  });

  test("Issues page is accessible", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    const issuesLink = page.locator("a[href*='issues']").first();
    if (await issuesLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await issuesLink.click();
    } else {
      await page.goto("/issues");
    }

    await expect(page).toHaveURL(/issues/, { timeout: 10_000 });
  });

  test("Projects page is accessible", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    const projectsLink = page.locator("a[href*='projects']").first();
    if (await projectsLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await projectsLink.click();
    } else {
      await page.goto("/projects");
    }

    await expect(page).toHaveURL(/projects/, { timeout: 10_000 });
  });
});
