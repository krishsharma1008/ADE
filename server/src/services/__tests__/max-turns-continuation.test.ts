// Max-turns continuation engine tests.
//
// Exercises the REAL decision logic (handleMaxTurnsContinuation via the
// __maxTurnsContinuationTestApi surface) and the pure helpers
// (maxTurnsRoundBudget, computeMaxTurnsProgress) against a temp git repo and the
// embedded test DB, without driving a live adapter process.
//
// Covered behaviors (mirror the design's required test matrix):
//   (a) claude_max_turns + git progress + under budget -> CONTINUE (issue NOT
//       blocked; window roundCount bumps; POST session persisted to task session).
//   (b) claude_max_turns + NO progress -> DECLINE (caller blocks via the existing
//       markIssueBlockedAfterFailedRun path — same comment + parent notify).
//   (c) round budget exhausted -> DECLINE (blocked).
//   (d) cumulative-turn HARD ceiling exhausted -> DECLINE even with progress.
//   (e) acceptedWork run -> never continues (decision is declined for non-issue
//       scope; the call-site gate also excludes acceptedWork).
//   (f) idempotency: a duplicate completion for the same run does NOT double-bump.
//   (g) maxTurnsRoundBudget clamps to [DEFAULT, HARD_MAX].
//   (h) computeMaxTurnsProgress: dirty repo -> progressed; clean/no-repo -> false.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import {
  agents,
  agentTaskSessions,
  companies,
  heartbeatRuns,
  issues,
  issueComments,
  maxTurnsContinuationWindows,
} from "@combyne/db";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import {
  computeMaxTurnsProgress,
  heartbeatService,
  markIssueBlockedAfterFailedRun,
  maxTurnsContinuationEnabled,
  maxTurnsRoundBudget,
} from "../heartbeat.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

const execFileAsync = promisify(execFile);

async function makeGitRepo(opts: { dirty: boolean }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-mtc-git-"));
  await execFileAsync("git", ["-C", dir, "init", "-q"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Tester"]);
  await fs.writeFile(path.join(dir, "seed.txt"), "seed\n");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  if (opts.dirty) {
    // An untracked file is the artifact of progress the gate looks for.
    await fs.writeFile(path.join(dir, "new-controller.ts"), "export class C {}\n");
  }
  return dir;
}

function makeMaxTurnsAdapterResult(overrides?: Partial<AdapterExecutionResult>): AdapterExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: "Reached maximum number of turns (50)",
    errorCode: "claude_max_turns",
    sessionId: "sess_post_maxturns",
    sessionDisplayId: "sess_post_maxturns",
    resultJson: { subtype: "error_max_turns", num_turns: 50, session_id: "sess_post_maxturns" },
    clearSession: false,
    ...overrides,
  } as AdapterExecutionResult;
}

describe("max-turns continuation engine", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let svc: ReturnType<typeof heartbeatService>;
  const tmpDirs: string[] = [];
  const prevFlag = process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED;

  beforeAll(async () => {
    handle = await startTestDb();
    process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED = "true";
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Max Turns Continuation Co", status: "active", issuePrefix: "MTC" })
      .returning();
    companyId = company.id;
    svc = heartbeatService(handle.db);
  }, 60_000);

  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED;
    else process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED = prevFlag;
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    if (handle) await stopTestDb();
  });

  afterEach(async () => {
    await handle.db.delete(maxTurnsContinuationWindows);
  });

  async function seedAgent(): Promise<typeof agents.$inferSelect> {
    const [agent] = await handle.db
      .insert(agents)
      .values({
        companyId,
        name: `Agent-${Math.random().toString(36).slice(2, 8)}`,
        adapterType: "claude_local",
        status: "running",
      })
      .returning();
    return agent;
  }

  async function seedIssue(opts?: { title?: string; status?: string }): Promise<typeof issues.$inferSelect> {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        companyId,
        title: opts?.title ?? "Create LendingTwoFAController",
        status: opts?.status ?? "in_progress",
      })
      .returning();
    return issue;
  }

  async function seedRun(opts: {
    agentId: string;
    issueId: string;
  }): Promise<typeof heartbeatRuns.$inferSelect> {
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: opts.agentId,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date(),
        contextSnapshot: { issueId: opts.issueId, taskId: opts.issueId },
      })
      .returning();
    return run;
  }

  // ── flag gate parity ──────────────────────────────────────────────────────

  it("the feature gate reflects COMBYNE_MAX_TURNS_CONTINUATION_ENABLED (off = today's block behavior)", () => {
    const prev = process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED;
    try {
      process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED = "true";
      expect(maxTurnsContinuationEnabled()).toBe(true);
      delete process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED;
      expect(maxTurnsContinuationEnabled()).toBe(false); // default OFF — guard never fires, run blocks as today
      process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED = "false";
      expect(maxTurnsContinuationEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED;
      else process.env.COMBYNE_MAX_TURNS_CONTINUATION_ENABLED = prev;
    }
  });

  // ── (g) maxTurnsRoundBudget complexity heuristic ──────────────────────────

  it("(g) maxTurnsRoundBudget clamps to [DEFAULT, HARD_MAX]", () => {
    expect(maxTurnsRoundBudget("")).toBe(3); // empty -> default
    expect(maxTurnsRoundBudget("a one-line ticket")).toBe(3); // short -> default
    // Many endpoints / DTOs / checklist items -> scaled up, but never past HARD_MAX (5).
    const big = [
      "Implement the controller with 8 endpoints and DTOs:",
      "- GET /a endpoint",
      "- POST /b endpoint",
      "- PUT /c endpoint",
      "- DELETE /d endpoint",
      "- GET /e endpoint",
      "- POST /f endpoint",
      "- PUT /g endpoint",
      "- DELETE /h endpoint",
      "1. add RequestDTO",
      "2. add ResponseDTO",
      "3. wire the route handler",
      "4. add the controller method",
    ].join("\n");
    const budget = maxTurnsRoundBudget(big);
    expect(budget).toBeGreaterThanOrEqual(3);
    expect(budget).toBeLessThanOrEqual(5);
    // A pathologically large input still clamps to HARD_MAX.
    const huge = Array.from({ length: 200 }, (_, i) => `- endpoint ${i} DTO controller route handler`).join("\n");
    expect(maxTurnsRoundBudget(huge)).toBe(5);
  });

  // ── (h) computeMaxTurnsProgress git signal ────────────────────────────────

  it("(h) computeMaxTurnsProgress: untracked file -> progressed=true", async () => {
    const repo = await makeGitRepo({ dirty: true });
    tmpDirs.push(repo);
    const res = await computeMaxTurnsProgress(repo, null);
    expect(res.progressed).toBe(true);
    expect(res.filesChanged).toBeGreaterThan(0);
    expect(res.headSha).not.toBeNull();
  });

  it("(h) computeMaxTurnsProgress: clean repo + same HEAD -> progressed=false", async () => {
    const repo = await makeGitRepo({ dirty: false });
    tmpDirs.push(repo);
    const first = await computeMaxTurnsProgress(repo, null);
    // Second round compares against the prior round's sha; unchanged -> no progress.
    const res = await computeMaxTurnsProgress(repo, first.headSha);
    expect(res.progressed).toBe(false);
    expect(res.filesChanged).toBe(0);
  });

  it("(h) computeMaxTurnsProgress: non-repo / missing cwd -> degrade to progressed=false", async () => {
    expect((await computeMaxTurnsProgress(null, null)).progressed).toBe(false);
    expect((await computeMaxTurnsProgress("", null)).progressed).toBe(false);
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-mtc-nogit-"));
    tmpDirs.push(plainDir);
    expect((await computeMaxTurnsProgress(plainDir, null)).progressed).toBe(false);
  });

  // ── (a) progress + under budget -> CONTINUE ───────────────────────────────

  it("(a) max_turns + progress + under budget -> CONTINUE, window bumps, session persisted, issue NOT blocked", async () => {
    const agent = await seedAgent();
    const issue = await seedIssue();
    const run = await seedRun({ agentId: agent.id, issueId: issue.id });
    const repo = await makeGitRepo({ dirty: true });
    tmpDirs.push(repo);

    const decision = await svc.__maxTurnsContinuationTestApi.handleMaxTurnsContinuation({
      run,
      agent,
      adapterResult: makeMaxTurnsAdapterResult(),
      sessionIdToResume: "sess_post_maxturns",
      sessionCwd: repo,
      taskKey: issue.id,
      nextSessionParams: { sessionId: "sess_post_maxturns" },
      nextSessionDisplayId: "sess_post_maxturns",
      seq: 1,
    });

    expect(decision.continue).toBe(true);
    expect(decision.issueId).toBe(issue.id);

    // Window created with roundCount=1.
    const [window] = await handle.db
      .select()
      .from(maxTurnsContinuationWindows)
      .where(eq(maxTurnsContinuationWindows.issueId, issue.id));
    expect(window).toBeTruthy();
    expect(window.roundCount).toBe(1);
    expect(window.cumulativeTurns).toBe(50);
    expect(window.sessionIdToResume).toBe("sess_post_maxturns");

    // POST session persisted into the task session so the continuation resumes warm.
    const [session] = await handle.db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, issue.id));
    expect(session).toBeTruthy();
    expect(session.sessionDisplayId).toBe("sess_post_maxturns");

    // The issue is NOT blocked by the continuation decision (caller skips block).
    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("in_progress");
  });

  // ── (b) no progress -> DECLINE -> block path preserved ────────────────────

  it("(b) max_turns + NO git progress -> DECLINE; the normal block path still blocks + notifies", async () => {
    const agent = await seedAgent();
    const issue = await seedIssue();
    const run = await seedRun({ agentId: agent.id, issueId: issue.id });
    const repo = await makeGitRepo({ dirty: false }); // clean -> no progress
    tmpDirs.push(repo);

    const decision = await svc.__maxTurnsContinuationTestApi.handleMaxTurnsContinuation({
      run,
      agent,
      adapterResult: makeMaxTurnsAdapterResult(),
      sessionIdToResume: "sess_post_maxturns",
      sessionCwd: repo,
      taskKey: issue.id,
      nextSessionParams: { sessionId: "sess_post_maxturns" },
      nextSessionDisplayId: "sess_post_maxturns",
      seq: 1,
    });
    expect(decision.continue).toBe(false);

    // No window left behind on a decline.
    const windows = await handle.db
      .select()
      .from(maxTurnsContinuationWindows)
      .where(eq(maxTurnsContinuationWindows.issueId, issue.id));
    expect(windows).toHaveLength(0);

    // Caller falls through to the existing block path — same behavior as today.
    const blocked = await markIssueBlockedAfterFailedRun(handle.db, {
      run,
      agent: { id: agent.id, name: agent.name },
      message: "Reached maximum number of turns (50)",
      errorCode: "claude_max_turns",
    });
    expect(blocked.blocked).toBe(true);

    const [refreshed] = await handle.db.select().from(issues).where(eq(issues.id, issue.id));
    expect(refreshed.status).toBe("blocked");
    const comments = await handle.db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id));
    expect(comments.some((c) => c.body.includes("Agent run failed"))).toBe(true);
  });

  // ── (c) round budget exhausted -> DECLINE ─────────────────────────────────

  it("(c) round budget exhausted -> DECLINE even with progress", async () => {
    const agent = await seedAgent();
    const issue = await seedIssue();
    const run = await seedRun({ agentId: agent.id, issueId: issue.id });
    const repo = await makeGitRepo({ dirty: true });
    tmpDirs.push(repo);

    // A PRIOR round's run (distinct id) drove the window up to its round budget.
    const priorRun = await seedRun({ agentId: agent.id, issueId: issue.id });
    await handle.db.insert(maxTurnsContinuationWindows).values({
      companyId,
      agentId: agent.id,
      issueId: issue.id,
      runId: priorRun.id,
      sessionIdToResume: "sess_prev",
      sessionCwd: repo,
      roundCount: 3,
      maxRounds: 3,
      cumulativeTurns: 90,
      maxTotalTurns: 200,
    });

    const decision = await svc.__maxTurnsContinuationTestApi.handleMaxTurnsContinuation({
      run,
      agent,
      adapterResult: makeMaxTurnsAdapterResult(),
      sessionIdToResume: "sess_post_maxturns",
      sessionCwd: repo,
      taskKey: issue.id,
      nextSessionParams: { sessionId: "sess_post_maxturns" },
      nextSessionDisplayId: "sess_post_maxturns",
      seq: 1,
    });
    expect(decision.continue).toBe(false);
    // Window dropped on decline so the next failure escalates cleanly.
    const windows = await handle.db
      .select()
      .from(maxTurnsContinuationWindows)
      .where(eq(maxTurnsContinuationWindows.issueId, issue.id));
    expect(windows).toHaveLength(0);
  });

  // ── (d) cumulative-turn HARD ceiling -> DECLINE even with progress ────────

  it("(d) cumulative-turn ceiling exhausted -> DECLINE even with progress and rounds left", async () => {
    const agent = await seedAgent();
    const issue = await seedIssue();
    const run = await seedRun({ agentId: agent.id, issueId: issue.id });
    const repo = await makeGitRepo({ dirty: true });
    tmpDirs.push(repo);

    // Round budget has room (1 < 5) but cumulativeTurns already at the ceiling.
    // A PRIOR round's run (distinct id) drove the window there.
    const priorRun = await seedRun({ agentId: agent.id, issueId: issue.id });
    await handle.db.insert(maxTurnsContinuationWindows).values({
      companyId,
      agentId: agent.id,
      issueId: issue.id,
      runId: priorRun.id,
      sessionIdToResume: "sess_prev",
      sessionCwd: repo,
      roundCount: 1,
      maxRounds: 5,
      cumulativeTurns: 200,
      maxTotalTurns: 200,
    });

    const decision = await svc.__maxTurnsContinuationTestApi.handleMaxTurnsContinuation({
      run,
      agent,
      adapterResult: makeMaxTurnsAdapterResult(),
      sessionIdToResume: "sess_post_maxturns",
      sessionCwd: repo,
      taskKey: issue.id,
      nextSessionParams: { sessionId: "sess_post_maxturns" },
      nextSessionDisplayId: "sess_post_maxturns",
      seq: 1,
    });
    expect(decision.continue).toBe(false);
  });

  // ── (e) non-issue / acceptedWork scope -> never continues ─────────────────

  it("(e) a run with no issue scope -> DECLINE (continuation is a task-level lever only)", async () => {
    const agent = await seedAgent();
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId: agent.id,
        status: "running",
        invocationSource: "on_demand",
        startedAt: new Date(),
        contextSnapshot: {}, // no issueId
      })
      .returning();
    const repo = await makeGitRepo({ dirty: true });
    tmpDirs.push(repo);

    const decision = await svc.__maxTurnsContinuationTestApi.handleMaxTurnsContinuation({
      run,
      agent,
      adapterResult: makeMaxTurnsAdapterResult(),
      sessionIdToResume: "sess_post_maxturns",
      sessionCwd: repo,
      taskKey: null,
      nextSessionParams: null,
      nextSessionDisplayId: null,
      seq: 1,
    });
    expect(decision.continue).toBe(false);
    expect(decision.issueId).toBeNull();
  });

  // ── (f) idempotency: duplicate completion for the SAME run -> no double-bump

  it("(f) idempotency: a duplicate completion for the same run does NOT double-bump the window", async () => {
    const agent = await seedAgent();
    const issue = await seedIssue();
    const run = await seedRun({ agentId: agent.id, issueId: issue.id });
    const repo = await makeGitRepo({ dirty: true });
    tmpDirs.push(repo);

    const args = {
      run,
      agent,
      adapterResult: makeMaxTurnsAdapterResult(),
      sessionIdToResume: "sess_post_maxturns",
      sessionCwd: repo,
      taskKey: issue.id,
      nextSessionParams: { sessionId: "sess_post_maxturns" },
      nextSessionDisplayId: "sess_post_maxturns",
      seq: 1,
    };

    const first = await svc.__maxTurnsContinuationTestApi.handleMaxTurnsContinuation(args);
    expect(first.continue).toBe(true);
    // A duplicate completion event for the SAME run id reaches us again.
    const second = await svc.__maxTurnsContinuationTestApi.handleMaxTurnsContinuation(args);
    expect(second.continue).toBe(true);

    const [window] = await handle.db
      .select()
      .from(maxTurnsContinuationWindows)
      .where(eq(maxTurnsContinuationWindows.issueId, issue.id));
    // The ON CONFLICT setWhere(runId != run.id) skips the bump for the same run.
    expect(window.roundCount).toBe(1);
    expect(window.cumulativeTurns).toBe(50);
  });
});
