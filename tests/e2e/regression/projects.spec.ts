import { test, expect } from "@playwright/test";

/**
 * E2E: Regression tests for project-related pages.
 *
 * Validates that project list and detail views render
 * correctly and are functional.
 *
 * Tag: @regression
 */

test.describe("@regression Projects pages", () => {
  test("Projects list page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Combyne/i, { timeout: 15_000 });

    // Navigate to projects page
    const projectsLink = page.locator("a[href*='projects']").first();
    if (await projectsLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await projectsLink.click();
    } else {
      await page.goto("/projects");
    }

    await expect(page).toHaveURL(/projects/, { timeout: 10_000 });

    // Page should show a projects heading or list
    const heading = page.locator("h1, h2, h3").filter({ hasText: /projects/i });
    const projectsList = page.locator("[data-testid*='project'], table, [role='list']");
    await expect(heading.first().or(projectsList.first())).toBeVisible({ timeout: 10_000 });
  });

  test("Project detail page loads", async ({ page }) => {
    // First get a project via API
    const companiesRes = await page.request.get("/api/companies");
    const companies = await companiesRes.json();

    if (companies.length === 0) {
      test.skip(true, "No companies exist — cannot test project detail");
      return;
    }

    const company = companies[0];
    const projectsRes = await page.request.get(`/api/companies/${company.id}/projects`);

    if (!projectsRes.ok()) {
      test.skip(true, "Projects API not available");
      return;
    }

    const projects = await projectsRes.json();

    if (!Array.isArray(projects) || projects.length === 0) {
      test.skip(true, "No projects exist — cannot test project detail");
      return;
    }

    const project = projects[0];

    // Navigate to the project detail page
    await page.goto(`/${company.urlKey ?? company.id}/projects/${project.urlKey ?? project.id}`);
    await expect(page).toHaveURL(/projects\//, { timeout: 10_000 });

    // Project name should be visible
    await expect(page.locator(`text=${project.name}`).first()).toBeVisible({ timeout: 10_000 });
  });
});
