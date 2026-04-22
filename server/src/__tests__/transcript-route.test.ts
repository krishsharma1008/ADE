// Round 3 Phase 9 — persisted transcript route.
//
// Verifies the route behavior directly:
//   1. Cross-company request → 403 (company-scope enforced via run lookup).
//   2. Multi-turn ordering: the route returns entries ordered by seq, so the
//      UI can render each turn distinctly even when an adapter re-prompts
//      mid-run (each turn increments seq).
//   3. Missing run → 404.
//
// Uses an isolated embedded Postgres via the services/__tests__/_test-db.ts
// helper. We mount the transcript route inline using the same logic shape as
// agents.ts, so the handler exercises real drizzle + the real service.

import express, { type Request } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, heartbeatRuns } from "@combyne/db";
import { appendTranscriptEntry, loadRunTranscript } from "../services/agent-transcripts.js";
import { heartbeatService } from "../services/heartbeat.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "../services/__tests__/_test-db.js";

describe("GET /heartbeat-runs/:runId/transcript", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let runId: string;

  function makeApp(actor: Record<string, unknown>) {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    const heartbeat = heartbeatService(handle.db);
    app.get(
      "/heartbeat-runs/:runId/transcript",
      async (req: Request, res, next) => {
        try {
          const id = req.params.runId as string;
          const run = await heartbeat.getRun(id);
          if (!run) {
            res.status(404).json({ error: "Heartbeat run not found" });
            return;
          }
          assertCompanyAccess(req, run.companyId);
          const rows = await loadRunTranscript(handle.db, id);
          const entries = rows.map((row) => ({
            id: row.id,
            seq: row.seq,
            ordinal: Number(row.ordinal),
            role: row.role,
            contentKind: row.contentKind,
            content: row.content,
            issueId: row.issueId,
            terminalSessionId: row.terminalSessionId,
            createdAt: row.createdAt,
          }));
          res.json({ runId: id, entries });
        } catch (err) {
          next(err);
        }
      },
    );
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    handle = await startTestDb();
    const [a, b] = await handle.db
      .insert(companies)
      .values([
        { name: "Transcript Route Co", issuePrefix: "TRC" },
        { name: "Other Tenant", issuePrefix: "OTH" },
      ])
      .returning();
    companyId = a.id;
    otherCompanyId = b.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-Route", adapterType: "process" })
      .returning();
    agentId = agent.id;
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "succeeded", invocationSource: "on_demand" })
      .returning();
    runId = run.id;
    // Three turns to exercise multi-turn ordering.
    for (const [seq, role, contentKind, payload] of [
      [0, "user", "bootstrap_preamble", { prompt: "turn 1" }],
      [1, "assistant", null, { text: "response 1" }],
      [2, "user", "adapter.invoke", { prompt: "turn 2" }],
    ] as const) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId,
        runId,
        seq,
        role,
        contentKind,
        content: payload,
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("rejects cross-company agent access with 403", async () => {
    const app = makeApp({
      type: "agent",
      agentId: "foreign-agent",
      companyId: otherCompanyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/heartbeat-runs/${runId}/transcript`);

    expect(res.status).toBe(403);
  });

  it("returns multi-turn entries ordered by seq", async () => {
    const app = makeApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/heartbeat-runs/${runId}/transcript`);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.entries).toHaveLength(3);
    const seqs = res.body.entries.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([0, 1, 2]);
    expect(res.body.entries[0].contentKind).toBe("bootstrap_preamble");
    expect(res.body.entries[2].contentKind).toBe("adapter.invoke");
  });

  it("returns 404 for an unknown run", async () => {
    const app = makeApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(
      "/heartbeat-runs/00000000-0000-0000-0000-000000000000/transcript",
    );

    expect(res.status).toBe(404);
  });
});
