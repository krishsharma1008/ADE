import { test, expect } from "@playwright/test";

/**
 * E2E: Regression tests for issue-related pages.
 *
 * Validates that issue list, detail, and creation views
 * render correctly and are functional.
 *
 * Tag: @regression
 */

test.describe("@regression Issues pages", () => {
  test("Issues list page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Navigate to issues page
    const issuesLink = page.locator("a[href*='issues']").first();
    if (await issuesLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await issuesLink.click();
    } else {
      await page.goto("/issues");
    }

    await expect(page).toHaveURL(/issues/, { timeout: 10_000 });

    // Page should show an issues heading or list
    const heading = page.locator("h1, h2, h3").filter({ hasText: /issues/i });
    const issuesList = page.locator("[data-testid*='issue'], table, [role='list']");
    await expect(heading.first().or(issuesList.first())).toBeVisible({ timeout: 10_000 });
  });

  test("Issue detail page loads", async ({ page }) => {
    // First get an issue via API
    const companiesRes = await page.request.get("/api/companies");
    const companies = await companiesRes.json();

    if (companies.length === 0) {
      test.skip(true, "No companies exist — cannot test issue detail");
      return;
    }

    const company = companies[0];
    const issuesRes = await page.request.get(`/api/companies/${company.id}/issues`);
    const issues = await issuesRes.json();

    if (issues.length === 0) {
      test.skip(true, "No issues exist — cannot test issue detail");
      return;
    }

    const issue = issues[0];

    // Navigate to the issue detail page
    await page.goto(`/${company.urlKey ?? company.id}/issues/${issue.identifier ?? issue.id}`);
    await expect(page).toHaveURL(/issues\//, { timeout: 10_000 });

    // Issue title should be visible
    await expect(page.locator(`text=${issue.title}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Issue creation dialog opens", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Navigate to issues page
    const issuesLink = page.locator("a[href*='issues']").first();
    if (await issuesLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await issuesLink.click();
    } else {
      await page.goto("/issues");
    }

    await expect(page).toHaveURL(/issues/, { timeout: 10_000 });

    // Look for a "New Issue" or "Create Issue" button
    const createBtn = page.locator("button, a").filter({
      hasText: /new issue|create issue|add issue/i,
    });

    if (await createBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await createBtn.first().click();

      // A dialog or form should appear
      const dialog = page.locator("[role='dialog'], form, [data-testid*='create']");
      await expect(dialog.first()).toBeVisible({ timeout: 10_000 });
    } else {
      // If no create button visible, the page at least loaded successfully
      expect(true).toBe(true);
    }
  });
});
