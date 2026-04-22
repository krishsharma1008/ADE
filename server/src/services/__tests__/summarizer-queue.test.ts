import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentTranscripts,
  companies,
  heartbeatRuns,
  issues,
  transcriptSummaries,
} from "@combyne/db";
import { appendTranscriptEntry } from "../agent-transcripts.js";
import { SummarizerQueue } from "../summarizer-queue.js";
import type { SummarizerDriver, SummarizerDriverInput } from "../transcript-summarizer.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

function validStandingJson() {
  return JSON.stringify({
    userPreferences: [],
    repoConventions: [],
    skillsExercised: [],
    recentFacts: [],
    narrative: "test summary",
  });
}

function validWorkingJson(ticketId: string) {
  return JSON.stringify({
    ticketId,
    title: "test",
    currentStatus: "in_progress",
    attemptsMade: [],
    filesExamined: [],
    filesModified: [],
    commandsRun: [],
    decisionsMade: [],
    blockers: [],
    openQuestions: [],
    nextStepPlan: "continue",
    lastUserMessage: "",
    narrative: "working narrative",
  });
}

function makeDriver(responseFactory: (call: number) => string, delayMs = 0) {
  const calls: SummarizerDriverInput[] = [];
  let counter = 0;
  const driver: SummarizerDriver = {
    async invoke(input) {
      calls.push(input);
      const idx = counter++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { raw: responseFactory(idx), inputTokens: 500, outputTokens: 200 };
    },
  };
  return { driver, calls: () => calls };
}

describe("SummarizerQueue", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let runId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Queue Test Co" })
      .returning();
    companyId = company.id;
    const [agent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Agent-Q", adapterType: "process" })
      .returning();
    agentId = agent.id;
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Queue test issue" })
      .returning();
    issueId = issue.id;
    const [run] = await handle.db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "done",
        invocationSource: "on_demand",
        contextSnapshot: { issueId },
      })
      .returning();
    runId = run.id;

    for (let i = 0; i < 8; i++) {
      await appendTranscriptEntry(handle.db, {
        companyId,
        agentId,
        runId,
        issueId,
        seq: i,
        role: i % 2 === 0 ? "user" : "assistant",
        content: { message: "z".repeat(500) + ` turn-${i}` },
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("coalesces concurrent triggers for the same key into one driver call", async () => {
    const { driver, calls } = makeDriver(() => validStandingJson(), 100);
    const queue = new SummarizerQueue({
      driver,
      cooldownMs: { standing: 0, working: 0 },
    });

    const [a, b, c] = await Promise.all([
      queue.maybeEnqueue(handle.db, {
        companyId,
        agentId,
        scope: "standing",
        adapterModel: "claude-haiku-4-5",
        summarizerModel: "claude-haiku-4-5",
        minTriggerTokens: 10,
        maxCostUsd: 10,
      }),
      queue.maybeEnqueue(handle.db, {
        companyId,
        agentId,
        scope: "standing",
        adapterModel: "claude-haiku-4-5",
        summarizerModel: "claude-haiku-4-5",
        minTriggerTokens: 10,
        maxCostUsd: 10,
      }),
      queue.maybeEnqueue(handle.db, {
        companyId,
        agentId,
        scope: "standing",
        adapterModel: "claude-haiku-4-5",
        summarizerModel: "claude-haiku-4-5",
        minTriggerTokens: 10,
        maxCostUsd: 10,
      }),
    ]);

    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    expect(c.status).toBe("created");
    // All three share the same in-flight promise → one driver call only.
    expect(calls().length).toBe(1);
  });

  it("enforces cooldown after a recent summary", async () => {
    // The previous test just wrote one. A fresh queue with positive
    // cooldown should skip.
    const { driver, calls } = makeDriver(() => validStandingJson());
    const queue = new SummarizerQueue({
      driver,
      cooldownMs: { standing: 60_000, working: 60_000 },
    });
    const result = await queue.maybeEnqueue(handle.db, {
      companyId,
      agentId,
      scope: "standing",
      adapterModel: "claude-haiku-4-5",
      summarizerModel: "claude-haiku-4-5",
      minTriggerTokens: 10,
      maxCostUsd: 10,
    });
    expect(result.status).toBe("skipped_cooldown");
    expect(calls().length).toBe(0);
  });

  it("runs standing and working in parallel (different keys)", async () => {
    // Delete the row from the cooldown test's setup so "standing" is eligible again.
    await handle.db
      .delete(transcriptSummaries)
      .where(eq(transcriptSummaries.agentId, agentId));

    const { driver, calls } = makeDriver((idx) =>
      idx === 0 ? validStandingJson() : validWorkingJson("BUK-23"),
    );
    const queue = new SummarizerQueue({
      driver,
      cooldownMs: { standing: 0, working: 0 },
    });

    const [standing, working] = await Promise.all([
      queue.maybeEnqueue(handle.db, {
        companyId,
        agentId,
        scope: "standing",
        adapterModel: "claude-haiku-4-5",
        summarizerModel: "claude-haiku-4-5",
        minTriggerTokens: 10,
        maxCostUsd: 10,
      }),
      queue.maybeEnqueue(handle.db, {
        companyId,
        agentId,
        scope: "working",
        issueId,
        adapterModel: "claude-haiku-4-5",
        summarizerModel: "claude-haiku-4-5",
        minTriggerTokens: 10,
        maxCostUsd: 10,
      }),
    ]);

    expect(standing.status).toBe("created");
    expect(working.status).toBe("created");
    expect(calls().length).toBe(2);
    // Two rows, one per scope.
    const rows = await handle.db
      .select()
      .from(transcriptSummaries)
      .where(eq(transcriptSummaries.agentId, agentId));
    const kinds = rows.map((r) => r.scopeKind).sort();
    expect(kinds).toEqual(["standing", "working"]);
  });
});
