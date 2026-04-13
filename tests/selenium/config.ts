export const BASE_URL = process.env.COMBYNE_SELENIUM_URL ?? "http://127.0.0.1:3100";
export const BROWSER = process.env.COMBYNE_SELENIUM_BROWSER ?? "chrome";
export const HEADLESS = process.env.COMBYNE_SELENIUM_HEADLESS !== "false";
