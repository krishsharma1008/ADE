import { Router } from "express";
import type { Db } from "@combyne/db";
import { count, sql } from "drizzle-orm";
import { companies, instanceUserRoles } from "@combyne/db";
import type { DeploymentExposure, DeploymentMode } from "@combyne/shared";
import { probeAdapterAvailability } from "../services/adapter-availability.js";

export interface HealthDatabaseInfo {
  mode: "embedded-postgres" | "external-postgres";
  host: string;
  port: number | null;
  database: string;
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    licenseEnabled?: boolean;
    database?: HealthDatabaseInfo;
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

    let bootstrapStatus: "ready" | "bootstrap_pending" | "needs_onboarding" = "ready";
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";
    }
    if (bootstrapStatus === "ready") {
      const companyCount = await db
        .select({ count: count() })
        .from(companies)
        .then((rows) => Number(rows[0]?.count ?? 0));
      if (companyCount === 0) {
        bootstrapStatus = "needs_onboarding";
      }
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

    let adapters: Awaited<ReturnType<typeof probeAdapterAvailability>> | null = null;
    try {
      adapters = await probeAdapterAvailability();
    } catch {
      adapters = null;
    }

    res.json({
      status: "ok",
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      licenseEnabled: opts.licenseEnabled ?? false,
      licenseStatus,
      database: opts.database ?? null,
      adapters,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
    });
  });

  return router;
}
