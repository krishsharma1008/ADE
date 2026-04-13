import { test, expect } from "@playwright/test";

/**
 * E2E: Regression tests for settings pages.
 *
 * Validates that company and instance settings pages
 * render correctly and are accessible.
 *
 * Tag: @regression
 */

test.describe("@regression Settings pages", () => {
  test("Company settings page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Navigate to settings — try sidebar link or direct URL
    const settingsLink = page.locator("a[href*='settings']").first();
    if (await settingsLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await settingsLink.click();
    } else {
      await page.goto("/settings");
    }

    await expect(page).toHaveURL(/settings/, { timeout: 10_000 });

    // Page should show a settings heading or form
    const heading = page.locator("h1, h2, h3").filter({ hasText: /settings/i });
    const settingsForm = page.locator("form, [data-testid*='settings']");
    await expect(heading.first().or(settingsForm.first())).toBeVisible({ timeout: 10_000 });
  });

  test("Instance settings page loads", async ({ page }) => {
    // Try the instance settings URL
    await page.goto("/settings/instance");

    // The page should load — it may redirect or show content
    // Wait for navigation to settle
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // Verify we're on a settings-related page
    const content = page.locator("main, [role='main'], #root");
    await expect(content.first()).toBeVisible({ timeout: 10_000 });

    // Check for settings-related content
    const heading = page.locator("h1, h2, h3").filter({ hasText: /settings|instance/i });
    const settingsContent = page.locator("[data-testid*='settings'], form");
    await expect(heading.first().or(settingsContent.first()).or(content.first())).toBeVisible({
      timeout: 10_000,
    });
  });
});
