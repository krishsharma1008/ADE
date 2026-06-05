import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, memoryEntries, contextCaptureOutbox } from "@combyne/db";
import { drainContextCaptureOutbox } from "../services/memory-capture.js";
import { issueService } from "../services/issues.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import {
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "../services/__tests__/_test-db.js";

function createStorageStub() {
  return {
    putObject: async () => {
      throw new Error("unused");
    },
    getObject: async () => {
      throw new Error("unused");
    },
    deleteObject: async () => undefined,
  };
}

// Board principal in local single-user mode: actorType resolves to 'user' and the
// source is 'local_implicit' — the §3.4 trusted-operator case. HOOK 1 must treat this
// as a real human and stamp verified.
function createApp(handle: TestDbHandle) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", issueRoutes(handle.db, createStorageStub() as any));
  app.use(errorHandler);
  return app;
}

describe("issue question answers", () => {
  let handle: TestDbHandle;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Question Answer Co", issuePrefix: "QAC" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    await stopTestDb(handle);
  });

  it("returns a numeric zero after the last structured question is answered", async () => {
    const svc = issueService(handle.db);
    const issue = await svc.create(companyId, {
      title: "Needs field list",
      status: "awaiting_user",
    });
    const question = await svc.addComment(issue.id, "Could you provide the field list?", {
      kind: "question",
    });
    const answer = await svc.addComment(issue.id, "Use the CSV export.", {
      kind: "answer",
    });

    await svc.markQuestionAnswered(question.id, answer.id);

    const remaining = await svc.countOpenQuestions(issue.id);
    expect(remaining).toBe(0);
    expect(typeof remaining).toBe("number");
  });
});

describe("HOOK 1 — human-answer capture via answer-question route", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Hook1 Co", issuePrefix: "HK1" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    await stopTestDb(handle);
  });

  async function postQuestion(title: string, questionBody: string) {
    const svc = issueService(handle.db);
    const issue = await svc.create(companyId, { title, status: "awaiting_user" });
    const question = await svc.addComment(issue.id, questionBody, { kind: "question" });
    return { issue, question };
  }

  it("captures exactly one human-answer/verified row with subject from the loaded question comment", async () => {
    const { issue, question } = await postQuestion(
      "Default for missing income",
      "Should missing spouse income default to zero?",
    );

    const res = await request(app)
      .post(`/api/issues/${issue.id}/answer-question`)
      .send({ questionCommentId: question.id, answer: "Yes, default it to zero." });

    expect(res.status).toBe(201);
    const answerCommentId = res.body.comment.id as string;

    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.companyId, companyId));
    const captured = rows.filter(
      (r) => r.source === `human-answer:${issue.id}:${answerCommentId}`,
    );
    expect(captured).toHaveLength(1);
    const entry = captured[0]!;
    expect(entry.layer).toBe("workspace");
    expect(entry.kind).toBe("fact");
    expect(entry.provenance).toBe("human-answer");
    expect(entry.verificationState).toBe("verified");
    expect(entry.confidence).toBeCloseTo(0.95, 5);
    expect(entry.authorType).toBe("user");
    expect(entry.sourceRefType).toBe("comment");
    expect(entry.sourceRefId).toBe(answerCommentId);
    // Subject is derived from the LOADED question comment, not the answer.
    expect(entry.subject).toContain("spouse income");
    expect(entry.body).toContain("Q: Should missing spouse income default to zero?");
    expect(entry.body).toContain("A: Yes, default it to zero.");
  });

  it("quarantines an answer containing an sk- key to needs_review (redaction gate)", async () => {
    const { issue, question } = await postQuestion(
      "Which API key for billing?",
      "Which key should the billing job use?",
    );

    const res = await request(app)
      .post(`/api/issues/${issue.id}/answer-question`)
      .send({
        questionCommentId: question.id,
        answer: "Use the key sk-live-ABCDEFGHIJKLMNOPQRSTUVWX for prod.",
      });

    expect(res.status).toBe(201);
    const answerCommentId = res.body.comment.id as string;

    const [entry] = await handle.db
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.companyId, companyId),
          eq(memoryEntries.source, `human-answer:${issue.id}:${answerCommentId}`),
        ),
      );
    expect(entry).toBeTruthy();
    expect(entry!.verificationState).toBe("needs_review");
    expect(entry!.provenance).toBe("human-answer");
    // The secret span is redacted in the stored body — it never lands verbatim.
    expect(entry!.body).not.toContain("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(entry!.body).toContain("***REDACTED***");
  });

  it("returns 201 AND durably enqueues the answer when createEntry throws (RDB-2: no silent drop)", async () => {
    const { issue, question } = await postQuestion(
      "Resilient capture",
      "Does a capture failure break the answer?",
    );

    // HOOK 1 now routes through captureHumanMemoryDurable, which imports
    // memoryService from ../services/memory.js — spy on THAT binding so the context
    // write throws (simulating an unreachable remote context DB), then build a fresh
    // app. The high-value human answer must NOT be silently dropped: it is enqueued
    // to the LOCAL ops outbox and replayed once the context DB is healthy again.
    const memoryModule = await import("../services/memory.js");
    const spy = vi
      .spyOn(memoryModule, "memoryService")
      .mockImplementation(
        (() =>
          ({
            createEntry: async () => {
              throw new Error("synthetic createEntry failure");
            },
          }) as any) as any,
      );

    let answerCommentId = "";
    try {
      const throwingApp = createApp(handle);
      const res = await request(throwingApp)
        .post(`/api/issues/${issue.id}/answer-question`)
        .send({ questionCommentId: question.id, answer: "No — the answer still returns." });
      expect(res.status).toBe(201);
      expect(res.body.comment.body).toContain("the answer still returns");
      answerCommentId = res.body.comment.id as string;

      const source = `human-answer:${issue.id}:${answerCommentId}`;

      // The direct context write failed, so no memory row yet…
      const rows = await handle.db
        .select()
        .from(memoryEntries)
        .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
      expect(rows).toHaveLength(0);

      // …but it was NOT lost: an outbox row exists in the local ops DB for replay.
      const outbox = await handle.db
        .select()
        .from(contextCaptureOutbox)
        .where(eq(contextCaptureOutbox.source, source));
      expect(outbox).toHaveLength(1);
      expect(outbox[0].provenance).toBe("human-answer");
    } finally {
      spy.mockRestore();
    }

    // Once the context DB is healthy again, draining replays it idempotently.
    const source = `human-answer:${issue.id}:${answerCommentId}`;
    await drainContextCaptureOutbox(handle.db);
    {
      const rows = await handle.db
        .select()
        .from(memoryEntries)
        .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
      expect(rows).toHaveLength(1);
      expect(rows[0].provenance).toBe("human-answer");
      expect(rows[0].verificationState).toBe("verified");
      const drained = await handle.db
        .select()
        .from(contextCaptureOutbox)
        .where(eq(contextCaptureOutbox.source, source));
      expect(drained).toHaveLength(0);
    }
  });

  it("is idempotent on retry: re-firing the same answer does not duplicate the row", async () => {
    const { issue, question } = await postQuestion(
      "Idempotent capture",
      "Is the capture retry-safe?",
    );

    const first = await request(app)
      .post(`/api/issues/${issue.id}/answer-question`)
      .send({ questionCommentId: question.id, answer: "Yes, the (companyId,source) upsert dedupes." });
    expect(first.status).toBe(201);
    const answerCommentId = first.body.comment.id as string;
    const source = `human-answer:${issue.id}:${answerCommentId}`;

    // Re-fire HOOK 1 directly against the SAME source key (simulating an endpoint retry
    // that lands on the same answer comment) and assert no duplicate.
    const { memoryService } = await import("../services/memory.js");
    const svc = memoryService(handle.db);
    await svc.createEntry({
      companyId,
      layer: "workspace",
      kind: "fact",
      subject: "Is the capture retry-safe?",
      body: "Q: Is the capture retry-safe?\nA: Yes, the (companyId,source) upsert dedupes.",
      source,
      provenance: "human-answer",
      verificationState: "verified",
      confidence: 0.95,
      authorType: "user",
      sourceRefType: "comment",
      sourceRefId: answerCommentId,
    });

    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
    expect(rows).toHaveLength(1);
  });
});
