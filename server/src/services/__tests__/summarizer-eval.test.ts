import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregate,
  checkAgainstBaseline,
  loadBaselineFile,
  loadFixtureFile,
  makeKeyFactsJudge,
  runEval,
  splitAtCutoff,
  validateFixture,
  type Answerer,
  type BaselineFile,
  type Fixture,
  type RunEvalResult,
} from "../summarizer-eval.js";
import type { SummarizerDriver } from "../transcript-summarizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../../../tests/fixtures/summarizer");

// Lightweight stub driver: returns a fixed JSON blob so the harness
// exercises the parse + render path without any network.
function stubSummarizerDriver(json: Record<string, unknown>): SummarizerDriver {
  return {
    async invoke() {
      return {
        raw: JSON.stringify(json),
        inputTokens: 1000,
        outputTokens: 200,
      };
    },
  };
}

function stubAnswerer(lookup: (q: string) => string): Answerer {
  return {
    async answer({ userPrompt }) {
      const m = userPrompt.match(/QUESTION: (.*)\nANSWER:/);
      const question = m ? m[1] : "";
      return { text: lookup(question), inputTokens: 100, outputTokens: 20 };
    },
  };
}

describe("summarizer-eval", () => {
  describe("validateFixture", () => {
    it("accepts a minimal valid fixture", () => {
      const fx: Fixture = {
        id: "t",
        description: "d",
        scope: "working",
        transcript: [{ ordinal: 1, role: "user", content: "hi" }],
        questions: [
          { id: "q1", question: "q?", oracleAnswer: "a", keyFacts: ["a"] },
        ],
      };
      expect(validateFixture(fx)).toEqual(fx);
    });
    it("rejects an invalid scope", () => {
      expect(() =>
        validateFixture({
          id: "t",
          description: "d",
          scope: "bogus",
          transcript: [{ ordinal: 1, role: "user", content: "hi" }],
          questions: [{ id: "q", question: "q", oracleAnswer: "a", keyFacts: ["a"] }],
        }),
      ).toThrow(/scope/);
    });
    it("rejects empty transcript", () => {
      expect(() =>
        validateFixture({
          id: "t",
          description: "d",
          scope: "working",
          transcript: [],
          questions: [{ id: "q", question: "q", oracleAnswer: "a", keyFacts: ["a"] }],
        }),
      ).toThrow(/transcript/);
    });
    it("rejects a question without keyFacts", () => {
      expect(() =>
        validateFixture({
          id: "t",
          description: "d",
          scope: "working",
          transcript: [{ ordinal: 1, role: "user", content: "hi" }],
          questions: [{ id: "q", question: "q", oracleAnswer: "a", keyFacts: [] }],
        }),
      ).toThrow(/keyFacts/);
    });
  });

  describe("loadFixtureFile", () => {
    it("loads the debug-session fixture", async () => {
      const f = await loadFixtureFile(path.join(FIXTURE_DIR, "fix-01-debug-session.json"));
      expect(f.fixtures).toHaveLength(1);
      expect(f.fixtures[0].id).toBe("fix-01-debug-session");
      expect(f.fixtures[0].scope).toBe("working");
      expect(f.fixtures[0].questions.length).toBeGreaterThan(0);
    });
    it("loads the multi-ticket standing fixture", async () => {
      const f = await loadFixtureFile(
        path.join(FIXTURE_DIR, "fix-02-multi-ticket-standing.json"),
      );
      expect(f.fixtures[0].scope).toBe("standing");
    });
  });

  describe("splitAtCutoff", () => {
    it("splits at the explicit cutoff", () => {
      const fx: Fixture = {
        id: "t",
        description: "",
        scope: "working",
        summaryCutoffOrdinal: 3,
        transcript: Array.from({ length: 6 }, (_, i) => ({
          ordinal: i + 1,
          role: "user" as const,
          content: `t${i + 1}`,
        })),
        questions: [{ id: "q", question: "q", oracleAnswer: "a", keyFacts: ["a"] }],
      };
      const { head, tail } = splitAtCutoff(fx);
      expect(head.map((e) => e.ordinal)).toEqual([1, 2, 3]);
      expect(tail.map((e) => e.ordinal)).toEqual([4, 5, 6]);
    });
    it("falls back to last-5-turns when cutoff is absent", () => {
      const fx: Fixture = {
        id: "t",
        description: "",
        scope: "working",
        transcript: Array.from({ length: 8 }, (_, i) => ({
          ordinal: i + 1,
          role: "user" as const,
          content: `t${i + 1}`,
        })),
        questions: [{ id: "q", question: "q", oracleAnswer: "a", keyFacts: ["a"] }],
      };
      const { head, tail } = splitAtCutoff(fx);
      expect(tail.map((e) => e.ordinal)).toEqual([4, 5, 6, 7, 8]);
      expect(head.map((e) => e.ordinal)).toEqual([1, 2, 3]);
    });
  });

  describe("makeKeyFactsJudge", () => {
    const judge = makeKeyFactsJudge();
    it("scores 1.0 when every keyFact appears", async () => {
      const r = await judge({
        question: "q?",
        candidateAnswer: "The root cause was a stale materialized view refreshed every 15 minutes.",
        oracleAnswer: "stale materialized view",
        keyFacts: ["materialized view", "15 minutes"],
      });
      expect(r.score).toBe(1);
      expect(r.missingFacts).toEqual([]);
    });
    it("scores partial credit when some facts are missing", async () => {
      const r = await judge({
        question: "q?",
        candidateAnswer: "A materialized view was involved.",
        oracleAnswer: "...",
        keyFacts: ["materialized view", "15 minutes"],
      });
      expect(r.score).toBe(0.5);
      expect(r.missingFacts).toEqual(["15 minutes"]);
    });
    it("penalizes mustAvoid terms", async () => {
      const r = await judge({
        question: "q?",
        candidateAnswer: "I don't know, maybe it's a cache. I invented a file name admin-inbox.ts.",
        oracleAnswer: "...",
        keyFacts: ["admin-inbox.ts"],
        mustAvoid: ["I don't know", "invented"],
      });
      expect(r.score).toBeLessThan(1);
      expect(r.violatedAvoids.length).toBe(2);
    });
  });

  describe("runEval (summary vs control)", () => {
    it("summary mode outperforms control on the debug fixture", async () => {
      const f = await loadFixtureFile(path.join(FIXTURE_DIR, "fix-01-debug-session.json"));
      const fx = f.fixtures[0];
      const driver = stubSummarizerDriver({
        ticketId: "BUK-23",
        title: "Inbox stale counts",
        currentStatus: "Ready to commit",
        attemptsMade: [
          { approach: "Add refresh after status change", outcome: "success", reason: "root cause was the 15-minute cron" },
        ],
        filesExamined: ["server/src/routes/inbox.ts", "packages/db/src/schema/inbox.ts"],
        filesModified: [
          "server/src/services/issues.ts",
          "server/src/routes/admin-inbox.ts",
          "server/src/index.ts",
        ],
        commandsRun: ["pnpm vitest run issues.test.ts"],
        decisionsMade: ["Refresh inbox_counts_v materialized view on every status change"],
        blockers: [],
        openQuestions: [],
        nextStepPlan: "Commit and open PR",
        narrative: "Fixed stale inbox counts by refreshing inbox_counts_v materialized view on the after-commit hook of status change, added admin endpoint, and an integration test issues-inbox-refresh.test.ts.",
      });
      const answerer = stubAnswerer((question) => {
        // Minimal keyword lookup: the stub looks for fact mentions in the
        // composed context (passed via userPrompt) but we cheat here to model
        // a competent model: it parrots whatever overlaps the keyFacts that
        // appear in the context block it received.
        return answerFromCompositeContext(question, fx);
      });
      const summaryRes = await runEval({
        fixture: fx,
        mode: "summary",
        summarizerDriver: driver,
        answerer: {
          async answer(input) {
            // Answerer looks at userPrompt (which contains the composed context)
            // and returns verbatim keyFacts that are present in that context.
            return {
              text: extractAnswerFromContext(input.userPrompt, fx),
            };
          },
        },
        judge: makeKeyFactsJudge(),
        model: "claude-haiku-4-5",
      });
      const controlRes = await runEval({
        fixture: fx,
        mode: "control",
        summarizerDriver: driver,
        answerer: {
          async answer(input) {
            return {
              text: extractAnswerFromContext(input.userPrompt, fx),
            };
          },
        },
        judge: makeKeyFactsJudge(),
        model: "claude-haiku-4-5",
      });
      void answerer;
      void answerFromCompositeContext;
      expect(summaryRes.accuracy).toBeGreaterThanOrEqual(controlRes.accuracy);
      expect(summaryRes.summaryContent).not.toBeNull();
      expect(controlRes.summaryContent).toBeNull();
    });
  });

  describe("baseline regression", () => {
    const baseline: BaselineFile = {
      tolerance: 0.1,
      anchors: [
        {
          fixtureId: "fix-A",
          summaryAccuracy: 0.9,
          controlAccuracy: 0.4,
          pinnedAt: "2026-04-23",
        },
      ],
    };
    function mockResult(id: string, mode: "summary" | "control", acc: number): RunEvalResult {
      return {
        fixtureId: id,
        mode,
        accuracy: acc,
        perQuestion: [],
        summaryTokens: 0,
        tailTokens: 0,
        summaryContent: null,
        tailContent: "",
      };
    }
    it("passes when observed is within tolerance", () => {
      const c = checkAgainstBaseline(mockResult("fix-A", "summary", 0.85), baseline);
      expect(c.passed).toBe(true);
    });
    it("fails when observed regresses beyond tolerance", () => {
      const c = checkAgainstBaseline(mockResult("fix-A", "summary", 0.7), baseline);
      expect(c.passed).toBe(false);
      expect(c.reason).toBe("regression_beyond_tolerance");
    });
    it("passes when no anchor exists (first run)", () => {
      const c = checkAgainstBaseline(mockResult("new-fx", "summary", 0.1), baseline);
      expect(c.passed).toBe(true);
      expect(c.reason).toBe("no_anchor_yet");
    });
  });

  describe("aggregate", () => {
    it("computes mean accuracy and lift", () => {
      const results: RunEvalResult[] = [
        { fixtureId: "a", mode: "summary", accuracy: 0.9, perQuestion: [], summaryTokens: 0, tailTokens: 0, summaryContent: null, tailContent: "" },
        { fixtureId: "a", mode: "control", accuracy: 0.4, perQuestion: [], summaryTokens: 0, tailTokens: 0, summaryContent: null, tailContent: "" },
        { fixtureId: "b", mode: "summary", accuracy: 0.8, perQuestion: [], summaryTokens: 0, tailTokens: 0, summaryContent: null, tailContent: "" },
        { fixtureId: "b", mode: "control", accuracy: 0.5, perQuestion: [], summaryTokens: 0, tailTokens: 0, summaryContent: null, tailContent: "" },
      ];
      const agg = aggregate(results, []);
      expect(agg.totalFixtures).toBe(2);
      expect(agg.summaryAccuracyMean).toBeCloseTo(0.85, 5);
      expect(agg.controlAccuracyMean).toBeCloseTo(0.45, 5);
      expect(agg.liftMean).toBeCloseTo(0.4, 5);
    });
  });

  describe("loadBaselineFile", () => {
    it("loads the committed baseline anchors file", async () => {
      const b = await loadBaselineFile(path.join(FIXTURE_DIR, "baseline-anchors.json"));
      expect(typeof b.tolerance).toBe("number");
      expect(Array.isArray(b.anchors)).toBe(true);
    });
  });
});

// Simulates an answerer: extracts the keyFacts from the composed context,
// returning them as the candidate answer. This mirrors how a competent
// model would behave given accurate context — facts that appear in the
// context are echoed in the answer. Facts absent from context stay absent.
function extractAnswerFromContext(userPrompt: string, fx: Fixture): string {
  // Pull the question out so we can grab only its own keyFacts.
  const m = userPrompt.match(/QUESTION: (.*)\nANSWER:/);
  const question = m ? m[1] : "";
  const q = fx.questions.find((x) => x.question === question);
  if (!q) return "no_question_match";
  const contextBody = userPrompt.replace(/\n---\nQUESTION:[\s\S]*$/, "");
  const facts = q.keyFacts.filter((f) =>
    contextBody.toLowerCase().includes(f.toLowerCase()),
  );
  return facts.join(", ");
}

function answerFromCompositeContext(_question: string, _fx: Fixture): string {
  return "";
}
