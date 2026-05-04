import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  licenseGateMiddleware,
  setLicenseState,
} from "../middleware/license-gate.js";

/**
 * Tests that the license gate middleware correctly blocks/allows the NEW
 * routes added during the Paperclip→Combyne merge (routines, plugins,
 * execution-workspaces, company-skills, instance-settings, org-chart).
 */
describe("License Gate — New Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(licenseGateMiddleware());

    // Stub all new routes to return 200
    const newPaths = [
      "/api/companies/test/routines",
      "/api/routines/test",
      "/api/routines/test/trigger",
      "/api/execution-workspaces",
      "/api/execution-workspaces/test",
      "/api/companies/test/skills",
      "/api/plugins",
      "/api/plugins/test",
      "/api/instance-settings",
      "/api/companies/test/org.svg",
      "/api/companies/test/org.png",
      "/api/companies/test/budgets",
      "/api/companies/test/budgets/incidents",
      "/api/issues/test/documents",
      "/api/issues/test/work-products",
      "/api/companies/test/qa/runs",
      "/api/companies/test/qa/test-cases",
      "/api/qa/runs/test/export",
    ];
    for (const p of newPaths) {
      app.all(p, (_req, res) => res.json({ ok: true }));
    }
  });

  it("allows new routes when license is valid", async () => {
    setLicenseState("valid");
    const res = await request(app).get("/api/companies/test/routines");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("blocks routines route when license is expired", async () => {
    setLicenseState("expired");
    const res = await request(app).get("/api/companies/test/routines");
    expect(res.status).toBe(403);
    expect(res.body.licenseStatus).toBe("expired");
  });

  it("blocks plugins route when license is revoked", async () => {
    setLicenseState("revoked");
    const res = await request(app).get("/api/plugins");
    expect(res.status).toBe(403);
    expect(res.body.licenseStatus).toBe("revoked");
  });

  it("blocks execution-workspaces when license is expired", async () => {
    setLicenseState("expired");
    const res = await request(app).get("/api/execution-workspaces");
    expect(res.status).toBe(403);
  });

  it("blocks instance-settings when license is revoked", async () => {
    setLicenseState("revoked");
    const res = await request(app).get("/api/instance-settings");
    expect(res.status).toBe(403);
  });

  it("blocks org chart export when license is expired", async () => {
    setLicenseState("expired");
    const res = await request(app).get("/api/companies/test/org.svg");
    expect(res.status).toBe(403);
  });

  it("blocks budget routes when license is revoked", async () => {
    setLicenseState("revoked");
    const res = await request(app).get("/api/companies/test/budgets");
    expect(res.status).toBe(403);
  });

  it("still allows health endpoint when license is expired", async () => {
    setLicenseState("expired");
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });

  it("still allows license endpoint when license is revoked", async () => {
    setLicenseState("revoked");
    app.get("/api/license/status", (_req, res) => res.json({ active: false }));
    const res = await request(app).get("/api/license/status");
    expect(res.status).toBe(200);
  });

  it("allows all routes when license state is unchecked", async () => {
    setLicenseState("unchecked");
    const res = await request(app).get("/api/plugins");
    expect(res.status).toBe(200);
  });
});
