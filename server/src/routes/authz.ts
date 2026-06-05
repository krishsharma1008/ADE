import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

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
