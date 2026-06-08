import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";
import { loadConfig } from "../config.js";
import { resolveContextDbUrl } from "../services/context-db.js";

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: Request, companyId: string | null | undefined) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  // Instance-wide GLOBAL entries (0054) carry company_id = NULL. They are not
  // owned by any company, so per-company scoping does not apply — any
  // authenticated actor may READ them (the cross-company visibility is the point).
  // Mutating a global entry is gated separately by assertInstanceAdmin at the route.
  if (companyId === null) {
    return;
  }
  // Fail-closed (PR-17): an EMPTY-STRING or undefined companyId is an
  // unresolved/missing scope, NOT the deliberate global-layer null above. Allowing
  // it through would let a principal — including local_implicit / isInstanceAdmin
  // (who otherwise skip the per-company checks below) — operate with no company
  // bound, the narrow real gap. Reject it for ALL principals before any bypass.
  if (companyId === undefined || companyId === "") {
    throw forbidden("Company scope is required");
  }
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
  }
}

/**
 * Phase B (company-pin enforcement): when a SEPARATE shared context DB is wired
 * (`resolveContextDbUrl()` non-empty) AND the team has pinned a canonical company
 * UUID (`cfg.contextCompanyId`), every memory route must address exactly that
 * tenant. The shared rail is a single physical Postgres many teammates point at;
 * without this fence a mistyped `:companyId` would read/write another team's
 * context on the same instance. Fail-closed (403).
 *
 * No-op when single-DB mode (no separate context URL) or when no pin is set —
 * which is the default local-first posture, so this is zero behavior change until
 * a team opts into the shared rail + a pin.
 *
 * Call AFTER `assertCompanyAccess(req, companyId)` so the standard scope check
 * runs first and this only narrows further (the pin is stricter than access).
 */
export function assertPinnedCompany(companyId: string | null | undefined) {
  // Instance-wide GLOBAL entries carry company_id = NULL — they are tenant-agnostic
  // and the pin (a single-tenant fence) does not apply. Mirrors assertCompanyAccess,
  // which also returns early for the deliberate global-layer null.
  if (companyId === null) {
    return;
  }
  if (!isPinnedCompany(companyId)) {
    throw forbidden("companyId does not match the pinned context tenant");
  }
}

/**
 * Non-throwing twin of {@link assertPinnedCompany}, for SERVICE-level capture
 * paths that have no request actor to 403 — the attachment-extraction drainer,
 * the outbox replay, and any background writer that addresses the shared rail off
 * a stored `companyId` rather than a live request. Returns `true` (allowed) when:
 * single-DB mode, no pin set, a global (null) row, or the companyId equals the
 * pin; `false` only when a SEPARATE context rail is wired, a pin is set, and the
 * companyId is a DIFFERENT tenant. Callers SKIP/drop the off-tenant write rather
 * than throw into a best-effort heartbeat tick.
 */
export function isPinnedCompany(companyId: string | null | undefined): boolean {
  if (companyId === null) {
    return true; // global rows are tenant-agnostic
  }
  const cfg = loadConfig();
  if (resolveContextDbUrl() && cfg.contextCompanyId && companyId !== cfg.contextCompanyId) {
    return false;
  }
  return true;
}

export function getActorInfo(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
