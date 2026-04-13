import { test, expect } from "@playwright/test";

/**
 * E2E: Regression tests for approval-related pages.
 *
 * Validates that approvals list and detail views render
 * correctly and are functional.
 *
 * Tag: @regression
 */

test.describe("@regression Approvals pages", () => {
  test("Approvals page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Navigate to approvals page
    const approvalsLink = page.locator("a[href*='approvals']").first();
    if (await approvalsLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await approvalsLink.click();
    } else {
      await page.goto("/approvals");
    }

    await expect(page).toHaveURL(/approvals/, { timeout: 10_000 });

    // Page should show an approvals heading or list
    const heading = page.locator("h1, h2, h3").filter({ hasText: /approvals/i });
    const approvalsList = page.locator("[data-testid*='approval'], table, [role='list']");
    await expect(heading.first().or(approvalsList.first())).toBeVisible({ timeout: 10_000 });
  });

  test("Approval detail accessible", async ({ page }) => {
    // First get an approval via API
    const companiesRes = await page.request.get("/api/companies");
    const companies = await companiesRes.json();

    if (companies.length === 0) {
      test.skip(true, "No companies exist — cannot test approval detail");
      return;
    }

    const company = companies[0];
    const approvalsRes = await page.request.get(`/api/companies/${company.id}/approvals`);

    if (!approvalsRes.ok()) {
      test.skip(true, "Approvals API not available");
      return;
    }

    const approvals = await approvalsRes.json();

    if (!Array.isArray(approvals) || approvals.length === 0) {
      test.skip(true, "No approvals exist — cannot test approval detail");
      return;
    }

    const approval = approvals[0];

    // Navigate to the approval detail page
    await page.goto(`/${company.urlKey ?? company.id}/approvals/${approval.id}`);
    await expect(page).toHaveURL(/approvals\//, { timeout: 10_000 });

    // Page should load without error — check for approval content
    const content = page.locator("main, [role='main'], #root");
    await expect(content.first()).toBeVisible({ timeout: 10_000 });
  });
});
