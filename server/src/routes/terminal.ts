import { Router } from "express";
import type { Db } from "@combyne/db";
import {
  closeSession,
  createTerminalSession,
  getActiveSessionForAgent,
  toSessionInfo,
  type TerminalMode,
} from "../services/terminal-sessions.js";
import { assertCompanyAccess } from "./authz.js";

export function terminalRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/agents/:agentId/terminal/session", async (req, res) => {
    const { companyId, agentId } = req.params as { companyId: string; agentId: string };
    assertCompanyAccess(req, companyId);
    const session = getActiveSessionForAgent(companyId, agentId);
    res.json({ session: session ? toSessionInfo(session) : null });
  });

  router.post("/companies/:companyId/agents/:agentId/terminal/session", async (req, res) => {
    const { companyId, agentId } = req.params as { companyId: string; agentId: string };
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as { mode?: TerminalMode; cols?: number; rows?: number };
    const existing = getActiveSessionForAgent(companyId, agentId);
    if (existing) {
      res.json({ session: toSessionInfo(existing), reused: true });
      return;
    }
    try {
      const session = await createTerminalSession(db, {
        companyId,
        agentId,
        mode: body.mode === "shell" ? "shell" : "cli",
        cols: body.cols ?? 100,
        rows: body.rows ?? 30,
        openedBy: req.actor.type === "board" ? req.actor.userId ?? null : req.actor.agentId ?? null,
      });
      res.status(201).json({ session: toSessionInfo(session), reused: false });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/companies/:companyId/agents/:agentId/terminal/session", async (req, res) => {
    const { companyId, agentId } = req.params as { companyId: string; agentId: string };
    assertCompanyAccess(req, companyId);
    const session = getActiveSessionForAgent(companyId, agentId);
    if (!session) {
      res.status(204).end();
      return;
    }
    await closeSession(db, session, "api requested");
    res.status(204).end();
  });

  return router;
}
