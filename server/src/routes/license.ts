/**
 * Combyne AI — License API Routes
 *
 * GET  /api/license/status     — Current license status from cache
 * POST /api/license/activate   — Activate a license key
 * POST /api/license/deactivate — Deactivate the current machine
 */
import { Router } from "express";
import {
  readLicenseCache,
  isLicenseCacheValid,
  activateLicense,
  deactivateLicense,
  type LicenseConfig,
} from "../services/license.js";
import { getLicenseState } from "../middleware/license-gate.js";

export function licenseRoutes(config: LicenseConfig) {
  const router = Router();

  router.get("/status", (_req, res) => {
    const cache = readLicenseCache();
    const gateState = getLicenseState();

    if (!cache) {
      res.json({
        activated: false,
        licenseStatus: "not_activated",
        gateState,
      });
      return;
    }

    const cacheCheck = isLicenseCacheValid(cache, config.gracePeriodHours);

    res.json({
      activated: true,
      licenseKey: maskLicenseKey(cache.licenseKey),
      planTier: cache.planTier,
      status: cache.status,
      validUntil: cache.validUntil,
      lastValidated: cache.lastValidated,
      cacheValid: cacheCheck.valid,
      cacheReason: cacheCheck.valid ? undefined : cacheCheck.reason,
      gateState,
    });
  });

  router.post("/activate", async (req, res) => {
    const { licenseKey } = req.body as { licenseKey?: string };

    if (!licenseKey || typeof licenseKey !== "string") {
      res.status(400).json({ error: "licenseKey is required" });
      return;
    }

    const trimmed = licenseKey.trim().toUpperCase();
    if (!trimmed) {
      res.status(400).json({ error: "licenseKey cannot be empty" });
      return;
    }

    try {
      const result = await activateLicense(trimmed, config);
      if (result.valid) {
        res.json({
          success: true,
          license: result.license,
          activation: result.activation,
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error,
          message: result.message,
          details: result.details,
        });
      }
    } catch (err) {
      res.status(500).json({
        success: false,
        error: "activation_failed",
        message: err instanceof Error ? err.message : "Activation failed",
      });
    }
  });

  router.post("/deactivate", async (_req, res) => {
    try {
      const result = await deactivateLicense(config);
      res.json({
        success: true,
        message: result.message ?? "License deactivated",
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: "deactivation_failed",
        message: err instanceof Error ? err.message : "Deactivation failed",
      });
    }
  });

  return router;
}

function maskLicenseKey(key: string): string {
  // Show first 4 chars (prefix) and last 4 chars, mask the rest
  if (key.length <= 8) return key;
  return `${key.slice(0, 9)}${"*".repeat(Math.max(0, key.length - 13))}${key.slice(-4)}`;
}
