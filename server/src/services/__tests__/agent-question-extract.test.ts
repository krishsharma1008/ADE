import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agents, companies, issueComments, issues } from "@combyne/db";
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

    it("drops trailing pleasantries that look like questions", () => {
      const text = `
Migration finished. Tests pass.

- Want me to do anything else?
- Should I continue with the second phase?
- Anything else you need?
      `;
      const out = extractQuestionsFromText(text);
      expect(out).toEqual([]);
    });

    it("does not extract bare prose lines that happen to end in '?'", () => {
      // Pre-fix: this prose-only "Should I continue?" leaked through and
      // forced the issue into awaiting_user. After the fix Pass 2 requires
      // an explicit bullet, so a bare line is ignored.
      const text = `
I finished the migration.
Should I continue with the second phase?
      `;
      const out = extractQuestionsFromText(text);
      expect(out).toEqual([]);
    });

    it("filters pleasantries even inside a dedicated Open questions section", () => {
      const text = `
## Open questions
- Want me to do anything else?
- Should we adopt the new payment provider?
      `;
      const out = extractQuestionsFromText(text);
      expect(out).toEqual(["Should we adopt the new payment provider?"]);
    });

    it("still accepts a bare-line question inside a dedicated section", () => {
      const text = `
## Open questions
Should we adopt the new payment provider?
      `;
      const out = extractQuestionsFromText(text);
      expect(out).toEqual(["Should we adopt the new payment provider?"]);
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

    it("does not rebound a closed issue to awaiting_user", async () => {
      // User closes the ticket while the agent run is still in flight.
      // When the run finishes and the extractor runs, it must NOT post
      // new question rows or flip the closed issue back to awaiting_user.
      const [closedIssue] = await handle.db
        .insert(issues)
        .values({
          companyId,
          title: "Closed-mid-run ticket",
          status: "done",
          completedAt: new Date(),
          priority: "low",
          assigneeAgentId: agentId,
        })
        .returning();

      const sourceText = `
## Open questions
1. A genuine clarifying question that should normally post?
2. Another genuine clarifying question that should normally post?
      `;
      const result = await extractAndPostQuestions(handle.db, {
        companyId,
        agentId,
        issueId: closedIssue.id,
        sourceText,
      });
      expect(result.posted).toBe(0);
      expect(result.statusTransitioned).toBe(false);

      const questions = await handle.db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, closedIssue.id),
            eq(issueComments.kind, "question"),
          ),
        );
      expect(questions).toHaveLength(0);

      const [refreshed] = await handle.db
        .select()
        .from(issues)
        .where(eq(issues.id, closedIssue.id));
      expect(refreshed.status).toBe("done");
    });
  });
});
