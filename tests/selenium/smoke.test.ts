import { describe, it, expect, afterAll } from "vitest";
import { Builder, Browser, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";
import firefox from "selenium-webdriver/firefox.js";
import { BASE_URL, BROWSER, HEADLESS } from "./config.js";

/**
 * Selenium smoke tests for Combyne.
 *
 * Validates health endpoint, UI loading, and basic navigation
 * using Selenium WebDriver for cross-browser testing.
 *
 * Configure via environment variables:
 *   COMBYNE_SELENIUM_URL       — base URL (default: http://127.0.0.1:3100)
 *   COMBYNE_SELENIUM_BROWSER   — browser name (default: chrome)
 *   COMBYNE_SELENIUM_HEADLESS  — headless mode (default: true, set "false" to disable)
 */

function buildDriver() {
  const builder = new Builder();

  if (BROWSER === "firefox") {
    const opts = new firefox.Options();
    if (HEADLESS) opts.addArguments("--headless");
    return builder.forBrowser(Browser.FIREFOX).setFirefoxOptions(opts).build();
  }

  // Default: Chrome
  const opts = new chrome.Options();
  if (HEADLESS) opts.addArguments("--headless=new", "--no-sandbox", "--disable-gpu");
  return builder.forBrowser(Browser.CHROME).setChromeOptions(opts).build();
}

describe("Selenium smoke tests", () => {
  let driver: Awaited<ReturnType<typeof buildDriver>> | null = null;

  afterAll(async () => {
    if (driver) {
      await driver.quit().catch(() => {});
    }
  });

  it("health endpoint returns 200", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.status).toBe(200);
  });

  it("UI loads and title contains Combyne", async () => {
    driver = await buildDriver();
    await driver.get(BASE_URL);
    await driver.wait(until.titleMatches(/Combyne/i), 15_000);
    const title = await driver.getTitle();
    expect(title).toMatch(/Combyne/i);
  });

  it("navigates to dashboard", async () => {
    if (!driver) driver = await buildDriver();
    await driver.get(`${BASE_URL}/`);
    await driver.wait(until.titleMatches(/Combyne/i), 15_000);

    // Page should have loaded — verify the body has content
    const body = await driver.findElement(By.tagName("body"));
    const text = await body.getText();
    expect(text.length).toBeGreaterThan(0);
  });

  it("navigates to agents page", async () => {
    if (!driver) driver = await buildDriver();

    // Try clicking a sidebar link, or navigate directly
    try {
      const agentsLink = await driver.findElement(By.css("a[href*='agents']"));
      await agentsLink.click();
      await driver.wait(until.urlContains("agents"), 10_000);
    } catch {
      await driver.get(`${BASE_URL}/agents`);
    }

    const url = await driver.getCurrentUrl();
    expect(url).toContain("agents");
  });

  it("navigates to issues page", async () => {
    if (!driver) driver = await buildDriver();

    try {
      const issuesLink = await driver.findElement(By.css("a[href*='issues']"));
      await issuesLink.click();
      await driver.wait(until.urlContains("issues"), 10_000);
    } catch {
      await driver.get(`${BASE_URL}/issues`);
    }

    const url = await driver.getCurrentUrl();
    expect(url).toContain("issues");
  });
});
