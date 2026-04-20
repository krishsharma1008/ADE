import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, isNull } from "drizzle-orm";
import { activityLog, agents, companies, issueComments, issues } from "@combyne/db";
import {
  extractQuestionsFromText,
  extractAndPostQuestions,
} from "../agent-question-extract.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("agent-question-extract", () => {
  describe("extractQuestionsFromText (pure)", () => {
    it("pulls numbered questions from an Open questions section", () => {
      const text = `
# Plan

Some prose here.

## Open questions

1. Do we have sandbox access to Brick/BNPL?
2. Which transport provider should we prefer?
3. Is the failing test a regression or a new flake?

## Next steps

Do the thing.
      `;
      const out = extractQuestionsFromText(text);
      expect(out).toHaveLength(3);
      expect(out[0]).toMatch(/sandbox access/);
      expect(out[2]).toMatch(/regression or a new flake/);
    });

    it("falls back to bulleted questions when no dedicated section exists", () => {
      const text = `
I had a few thoughts:
- Should we use a new branch?
- What is the target latency budget?
- also: unrelated comment without a question mark
      `;
      const out = extractQuestionsFromText(text);
      expect(out).toHaveLength(2);
    });

    it("dedupes questions that only differ in whitespace/case", () => {
      const text = `
## Clarifying questions
- Do we need FX support?
-   DO we need FX support?
- do we need fx support?
      `;
      const out = extractQuestionsFromText(text);
      expect(out).toHaveLength(1);
    });

    it("respects the maxQuestions cap", () => {
      const text = `
## Open questions
${Array.from({ length: 20 }, (_, i) => `- Q${i + 1}: Is item ${i + 1} important?`).join("\n")}
      `;
      expect(extractQuestionsFromText(text, 5)).toHaveLength(5);
    });

    it("ignores lines that are too short or not questions", () => {
      const text = `
## Open questions
- ok?
- This is a proper question?
- Not a question, just a sentence.
      `;
      const out = extractQuestionsFromText(text);
      expect(out).toEqual(["This is a proper question?"]);
    });
  });

  describe("extractAndPostQuestions (DB integration)", () => {
    let handle: TestDbHandle;
    let companyId: string;
    let agentId: string;
    let issueId: string;

    beforeAll(async () => {
      handle = await startTestDb();
      const [company] = await handle.db
        .insert(companies)
        .values({ name: "Question Extract Co" })
        .returning();
      companyId = company.id;
      const [agent] = await handle.db
        .insert(agents)
        .values({ companyId, name: "question-extract-agent", adapterType: "claude_local" })
        .returning();
      agentId = agent.id;
      const [issue] = await handle.db
        .insert(issues)
        .values({
          companyId,
          title: "Veefin provider analysis plan",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: agentId,
        })
        .returning();
      issueId = issue.id;
    }, 60_000);

    afterAll(async () => {
      if (handle) await stopTestDb();
    });

    it("posts each extracted question as a structured comment and awaits user", async () => {
      const sourceText = `
Drafted the plan and appended it to the issue.

## Open questions
1. Do we have sandbox access for Brick and BNPL?
2. What is the preferred transport provider?
3. Is FX settlement in scope for phase 1?

That's all for now.
      `;
      const result = await extractAndPostQuestions(handle.db, {
        companyId,
        agentId,
        issueId,
        sourceText,
      });
      expect(result.posted).toBe(3);
      expect(result.statusTransitioned).toBe(true);

      const questions = await handle.db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, issueId),
            eq(issueComments.kind, "question"),
            isNull(issueComments.answeredAt),
          ),
        );
      expect(questions).toHaveLength(3);
      for (const row of questions) {
        expect(row.authorAgentId).toBe(agentId);
        expect(row.body.endsWith("?")).toBe(true);
      }

      const [refreshed] = await handle.db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(refreshed.status).toBe("awaiting_user");
      expect(refreshed.awaitingUserSince).not.toBeNull();
    });

    it("emits a single activity_log entry per extraction so the issue timeline surfaces it", async () => {
      const sourceText = `
## Open questions
1. Activity-log emit question one?
2. Activity-log emit question two?
      `;
      await extractAndPostQuestions(handle.db, {
        companyId,
        agentId,
        issueId,
        sourceText,
      });
      const rows = await handle.db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "issue.questions_extracted"),
            eq(activityLog.entityId, issueId),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(1);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.actorType).toBe("agent");
      expect(row.actorId).toBe(agentId);
      expect(row.entityType).toBe("issue");
      const details = (row.details ?? {}) as Record<string, unknown>;
      expect(typeof details.posted).toBe("number");
      expect((details.posted as number) > 0).toBe(true);
    });

    it("skips questions already open on the issue so re-runs don't multiply cards", async () => {
      const sourceText = `
## Open questions
1. Do we have sandbox access for Brick and BNPL?
2. Brand new question for this run?
      `;
      const result = await extractAndPostQuestions(handle.db, {
        companyId,
        agentId,
        issueId,
        sourceText,
      });
      expect(result.posted).toBe(1); // only the new one
      expect(result.skippedExisting).toBe(1);
    });
  });
});
