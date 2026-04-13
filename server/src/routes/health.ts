import { Router } from "express";
import type { Db } from "@combyne/db";
import { count, sql } from "drizzle-orm";
import { instanceUserRoles } from "@combyne/db";
import type { DeploymentExposure, DeploymentMode } from "@combyne/shared";

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    licenseEnabled?: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
    licenseEnabled: false,
  },
) {
  const router = Router();

  router.get("/", async (_req, res) => {
    if (!db) {
      res.json({ status: "ok" });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";
    }

    let licenseStatus: string = "not_required";
    if (opts.licenseEnabled) {
      try {
        const { getLicenseState } = await import("../middleware/license-gate.js");
        licenseStatus = getLicenseState();
      } catch {
        licenseStatus = "unchecked";
      }
    }

    res.json({
      status: "ok",
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      licenseEnabled: opts.licenseEnabled ?? false,
      licenseStatus,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
    });
  });

  return router;
}
