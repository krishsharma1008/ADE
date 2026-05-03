import { Router } from "express";
import { agentTerminalSessions, issues } from "@combyne/db";
import type { Db } from "@combyne/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  closeSession,
  continueTerminalSession,
  createTerminalSession,
  getActiveSessionForAgent,
  getSessionById,
  toSessionInfo,
  type TerminalMode,
} from "../services/terminal-sessions.js";
import { issueService } from "../services/index.js";
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

  router.post("/companies/:companyId/agents/:agentId/terminal/continue", async (req, res) => {
    const { companyId, agentId } = req.params as { companyId: string; agentId: string };
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as { issueId?: string; cols?: number; rows?: number };
    if (!body.issueId) {
      res.status(400).json({ error: "issueId is required" });
      return;
    }
    try {
      const session = await continueTerminalSession(db, {
        companyId,
        agentId,
        issueId: body.issueId,
        cols: body.cols ?? 100,
        rows: body.rows ?? 30,
        openedBy: req.actor.type === "board" ? req.actor.userId ?? null : req.actor.agentId ?? null,
      });
      res.status(201).json({ session: toSessionInfo(session), resumed: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found|not a terminal/i.test(message) ? 404 : 500;
      res.status(status).json({ error: message });
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

  router.delete("/companies/:companyId/agents/:agentId/terminal/session/:sessionId", async (req, res) => {
    const { companyId, agentId, sessionId } = req.params as {
      companyId: string;
      agentId: string;
      sessionId: string;
    };
    assertCompanyAccess(req, companyId);

    const session = getSessionById(sessionId);
    if (session) {
      if (session.companyId !== companyId || session.agentId !== agentId) {
        res.status(404).json({ error: "Terminal session not found" });
        return;
      }
      await closeSession(db, session, "api requested");
      res.status(204).end();
      return;
    }

    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agentId),
          eq(issues.originKind, "terminal_session"),
          eq(issues.originId, sessionId),
        ),
      )
      .limit(1);

    if (!issue) {
      res.status(404).json({ error: "Terminal session not found" });
      return;
    }

    await db
      .update(agentTerminalSessions)
      .set({ status: "closed", endedAt: new Date() })
      .where(and(eq(agentTerminalSessions.id, sessionId), isNull(agentTerminalSessions.endedAt)));

    const svc = issueService(db);
    await svc.addComment(
      issue.id,
      `Terminal session closed (reason: \`api requested\`) at ${new Date().toISOString()}.`,
      { userId: req.actor.type === "board" ? req.actor.userId ?? undefined : undefined },
    );
    await svc.update(issue.id, { status: "done" });
    res.status(204).end();
  });

  return router;
}
