/**
 * Combyne AI — License Gate Middleware
 *
 * Blocks API requests when the license is revoked or expired.
 * Always allows /api/health, /api/license/*, and /api/personas/* endpoints.
 */
import type { RequestHandler } from "express";

type LicenseState = "valid" | "expired" | "revoked" | "unchecked";

let licenseState: LicenseState = "unchecked";

export function setLicenseState(state: LicenseState): void {
  licenseState = state;
}

export function getLicenseState(): LicenseState {
  return licenseState;
}

export function licenseGateMiddleware(): RequestHandler {
  return (req, res, next) => {
    // Always allow health, license, and personas endpoints
    if (
      req.path === "/api/health" ||
      req.path.startsWith("/api/health/") ||
      req.path === "/api/license" ||
      req.path.startsWith("/api/license/") ||
      req.path === "/api/personas" ||
      req.path.startsWith("/api/personas/")
    ) {
      next();
      return;
    }

    // Also allow static assets and auth routes
    if (
      !req.path.startsWith("/api/") ||
      req.path.startsWith("/api/auth/")
    ) {
      next();
      return;
    }

    if (licenseState === "revoked") {
      res.status(403).json({
        error: "License revoked",
        licenseStatus: "revoked",
        message: "This license has been revoked. Please contact support@combyne.ai.",
      });
      return;
    }

    if (licenseState === "expired") {
      res.status(403).json({
        error: "License expired",
        licenseStatus: "expired",
        message: "Your Combyne AI license has expired. Please renew your license.",
      });
      return;
    }

    next();
  };
}
