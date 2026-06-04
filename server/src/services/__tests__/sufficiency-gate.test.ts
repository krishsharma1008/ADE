import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, issueComments, issues, memoryEntries } from "@combyne/db";
import {
  maybeRunSufficiencyGate,
  sufficiencyGateEnabled,
  type SufficiencyTelemetryEvent,
} from "../heartbeat.js";
import { evaluateAskBudget } from "../sufficiency-budget.js";
import { memoryService } from "../memory.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

/**
 * PR-10 acceptance — the gate is shipped DARK. With
 * COMBYNE_SUFFICIENCY_GATE_ENABLED off the heartbeat path emits a
 * `sufficiency_verdict` telemetry event but NEVER withholds context and NEVER
 * posts a question (proven). The sufficiency-budget enforces ≤2 asks/issue and
 * the per-subjectKey cooldown (exercised only when enabled).
 */

const GATE_FLAG = "COMBYNE_SUFFICIENCY_GATE_ENABLED";

describe("sufficiency gate — budget + dark no-op", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let agentId: string;
  let emId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Sufficiency Gate Co", issuePrefix: "SG" })
      .returning();
    companyId = company.id;
    const [em] = await handle.db
      .insert(agents)
      .values({ companyId, name: "EM", role: "em", adapterType: "process" })
      .returning();
    emId = em.id;
    const [dev] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Engineer", role: "engineer", reportsTo: em.id, adapterType: "process" })
      .returning();
    agentId = dev.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  afterEach(() => {
    delete process.env[GATE_FLAG];
  });

  async function freshIssue(title: string) {
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title, status: "in_progress", assigneeAgentId: agentId })
      .returning();
    return issue;
  }

  it("sufficiencyGateEnabled defaults OFF and reads the env flag live", () => {
    delete process.env[GATE_FLAG];
    expect(sufficiencyGateEnabled()).toBe(false);
    process.env[GATE_FLAG] = "true";
    expect(sufficiencyGateEnabled()).toBe(true);
    process.env[GATE_FLAG] = "false";
    expect(sufficiencyGateEnabled()).toBe(false);
  });

  it("evaluateAskBudget enforces ≤2 asks/issue and the per-subjectKey cooldown", async () => {
    const issue = await freshIssue("Budget issue");

    // 1st ask allowed.
    const q1 = "What is the intended approach for the refund flow?";
    let d = await evaluateAskBudget(handle.db, { companyId, issueId: issue.id, question: q1 });
    expect(d.allowed).toBe(true);
    await handle.db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorAgentId: agentId,
      body: q1,
      kind: "manager_question",
    });

    // Cooldown: the SAME subjectKey (paraphrase that normalizes identically) is blocked.
    d = await evaluateAskBudget(handle.db, {
      companyId,
      issueId: issue.id,
      question: "  What   is the INTENDED approach for the refund flow?  ",
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("subject_key_cooldown");

    // 2nd distinct ask allowed (budget = 2).
    const q2 = "Which idempotency key should the webhook use?";
    d = await evaluateAskBudget(handle.db, { companyId, issueId: issue.id, question: q2 });
    expect(d.allowed).toBe(true);
    await handle.db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorAgentId: agentId,
      body: q2,
      kind: "manager_question",
    });

    // 3rd distinct ask exceeds the per-issue budget.
    d = await evaluateAskBudget(handle.db, {
      companyId,
      issueId: issue.id,
      question: "A third entirely different question about deployment?",
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("issue_budget_exhausted");
    expect(d.askedOnIssue).toBe(2);
    expect(d.budget).toBe(2);
  });

  it("DARK: gate OFF emits sufficiency_verdict telemetry but never withholds and never asks", async () => {
    delete process.env[GATE_FLAG];
    const issue = await freshIssue("Dark gate issue — no vetted context");

    // No memory entries ⇒ empty ranked ⇒ would be insufficient if enabled.
    const longTerm = memoryService(handle.db);
    const ranked = await longTerm.queryRanked(companyId, issue.title, {
      ownerType: "agent",
      ownerId: agentId,
      requireVerified: true,
    });
    expect(ranked.items.length).toBe(0);

    const events: SufficiencyTelemetryEvent[] = [];
    const outcome = await maybeRunSufficiencyGate(handle.db, {
      companyId,
      agentId,
      issueId: issue.id,
      ranked,
      entries: [],
      ticket: { serviceScope: "payments-service", title: issue.title, description: "refund webhook idempotency" },
      complexity: "medium",
      onTelemetry: (e) => events.push(e),
    });

    // Telemetry emitted with the computed verdict.
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("sufficiency_verdict");
    expect(events[0].gateEnabled).toBe(false);
    expect(events[0].verdict).toBe("insufficient");
    expect(events[0].withheld).toBe(false);
    expect(events[0].asked).toBe(false);

    // Proven dark: never withheld, never asked.
    expect(outcome.withholdPreamble).toBe(false);
    expect(outcome.asked).toBe(false);

    // NO question comment was posted and the issue was NOT transitioned.
    const comments = await handle.db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issue.id), eq(issueComments.kind, "manager_question")));
    expect(comments.length).toBe(0);
    const [row] = await handle.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(row.status).toBe("in_progress");
  });

  it("ENABLED: insufficient + entityCoverage 0 posts ONE gate question and respects the budget", async () => {
    process.env[GATE_FLAG] = "true";
    const issue = await freshIssue("Enabled gate issue");

    const ranked = { items: [], layerCounts: { workspace: 0, personal: 0, shared: 0 } };
    const events: SufficiencyTelemetryEvent[] = [];
    const outcome = await maybeRunSufficiencyGate(handle.db, {
      companyId,
      agentId,
      issueId: issue.id,
      ranked,
      entries: [],
      ticket: { serviceScope: "payments-service", title: issue.title, description: "refund webhook" },
      complexity: "medium",
      onTelemetry: (e) => events.push(e),
    });

    expect(outcome.verdict).toBe("insufficient");
    expect(outcome.withholdPreamble).toBe(true); // H1
    expect(outcome.asked).toBe(true); // H2
    expect(events[0].withheld).toBe(true);
    expect(events[0].asked).toBe(true);

    // A manager_question was posted and the issue transitioned to blocked.
    const comments = await handle.db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issue.id), eq(issueComments.kind, "manager_question")));
    expect(comments.length).toBe(1);
    const [row] = await handle.db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id));
    expect(row.status).toBe("blocked");
  });

  it("ENABLED but threshold set missing for the active version ⇒ non-actionable (no ask)", async () => {
    process.env[GATE_FLAG] = "true";
    const issue = await freshIssue("Unknown embedder issue");

    // An entry stamped with an UNKNOWN embedding_version drives the active
    // version off the calibrated hash-64 set ⇒ thresholds flagged missing.
    const longTerm = memoryService(handle.db);
    const entry = await longTerm.createEntry({
      companyId,
      layer: "workspace",
      subject: "payments refund policy",
      body: "refunds are idempotent on webhook id",
      serviceScope: "payments-service",
    });
    await handle.db
      .update(memoryEntries)
      .set({ embeddingVersion: "openai:text-embedding-3-small:1536" })
      .where(eq(memoryEntries.id, entry.id));
    const reloaded = await longTerm.getEntry(entry.id);

    const ranked = {
      items: [
        {
          id: entry.id,
          layer: "workspace" as const,
          subject: entry.subject,
          kind: "fact" as const,
          tags: [],
          serviceScope: "payments-service",
          score: 0.05,
          snippet: "",
        },
      ],
      layerCounts: { workspace: 1, personal: 0, shared: 0 },
    };
    const outcome = await maybeRunSufficiencyGate(handle.db, {
      companyId,
      agentId,
      issueId: issue.id,
      ranked,
      entries: reloaded ? [reloaded] : [],
      ticket: { serviceScope: "payments-service", title: issue.title, description: "refund" },
      complexity: "medium",
    });

    // Flagged missing ⇒ forced sufficient ⇒ never withholds, never asks.
    expect(outcome.result.thresholdsMissing).toBe(true);
    expect(outcome.verdict).toBe("sufficient");
    expect(outcome.withholdPreamble).toBe(false);
    expect(outcome.asked).toBe(false);
    const comments = await handle.db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issue.id), eq(issueComments.kind, "manager_question")));
    expect(comments.length).toBe(0);
  });
});
