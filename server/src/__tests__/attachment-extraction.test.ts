// INFRA_FIXES_PLAN Phase F — multi-modal Q&A answer-attachment capture.
//
// Drives the answer-question route (enqueue side) + drainAttachmentExtractionJobs
// (process side) end-to-end against the single-DB rig, with a FAKE injected
// extractor for determinism (NEVER a real model). Asserts:
//   - a PDF attachment on the answer enqueues a job; draining it with a fake
//     extractor lands a memory_entries row (human-answer / verified / sourceRefType
//     'attachment') with the extracted text;
//   - redaction (scanBody) is applied to the extracted content before capture;
//   - an image attachment lands verified-summary;
//   - an extractor that throws keeps the TEXT answer captured AND leaves the job for
//     retry (attempts bumped);
//   - draining twice does not duplicate the memory row (idempotent on the asset-id
//     source key).

import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, memoryEntries, attachmentExtractionJobs, contextCaptureOutbox } from "@combyne/db";
import { issueService } from "../services/issues.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import {
  drainAttachmentExtractionJobs,
  type AttachmentExtractor,
} from "../services/attachment-extract.js";
import {
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "../services/__tests__/_test-db.js";

// Storage stub: getObject streams back a fixed buffer for any object key. The
// FAKE extractor ignores the bytes, so the content is irrelevant — we only need a
// readable stream so the drainer's streamToBuffer succeeds.
function createStorageStub(bytes = Buffer.from("%PDF-1.4 fake bytes")) {
  return {
    provider: "local-disk" as const,
    putFile: async (input: { contentType: string; body: Buffer; originalFilename: string | null }) => ({
      provider: "local-disk" as const,
      objectKey: `obj-${Math.random().toString(36).slice(2)}`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "0".repeat(64),
      originalFilename: input.originalFilename,
    }),
    getObject: async () => ({
      stream: Readable.from([bytes]),
      contentType: "application/octet-stream",
      contentLength: bytes.length,
    }),
    headObject: async () => ({ exists: true }),
    deleteObject: async () => undefined,
  };
}

// Board principal in local single-user mode: actorType 'user' / source
// 'local_implicit' — the trusted-operator case, so HOOK 1 + the enqueue fire.
function createApp(handle: TestDbHandle, storage = createStorageStub()) {
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
  app.use("/api", issueRoutes(handle.db, storage as any));
  app.use(errorHandler);
  return app;
}

// A deterministic fake extractor. `pdfText` / `imageText` are returned verbatim;
// pass `throwOn` to make a given path throw (failure-path test).
function fakeExtractor(opts: {
  pdfText?: string | null;
  imageText?: string | null;
  throwOn?: "pdf" | "image";
}): AttachmentExtractor {
  return {
    enabled: true,
    async extractPdf() {
      if (opts.throwOn === "pdf") throw new Error("synthetic pdf extract failure");
      return opts.pdfText ?? null;
    },
    async describeImage() {
      if (opts.throwOn === "image") throw new Error("synthetic image extract failure");
      return opts.imageText ?? null;
    },
  };
}

describe("Phase F — multi-modal attachment extraction", () => {
  let handle: TestDbHandle;
  let app: express.Express;
  let companyId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    app = createApp(handle);
    const [company] = await handle.db
      .insert(companies)
      .values({ name: "Attachment Co", issuePrefix: "ATT" })
      .returning();
    companyId = company.id;
  }, 60_000);

  afterAll(async () => {
    await stopTestDb();
  });

  // The extraction queue is process-global within this file's DB; drains pick up
  // ALL due jobs. Clear it (and the captured rows) between tests so each test
  // observes only its OWN enqueue/drain — no leakage from a prior test's pending
  // job. (Separate test FILES run in isolated DBs, so this only scopes intra-file.)
  beforeEach(async () => {
    await handle.db.delete(attachmentExtractionJobs);
    await handle.db.delete(memoryEntries);
  });

  // Answer a question and attach a stored object of `contentType` to the answer
  // comment, returning the ids needed by the assertions.
  async function answerWithAttachment(input: {
    title: string;
    questionBody: string;
    answer: string;
    contentType: string;
  }) {
    const svc = issueService(handle.db);
    const issue = await svc.create(companyId, { title: input.title, status: "awaiting_user" });
    const question = await svc.addComment(issue.id, input.questionBody, { kind: "question" });

    const res = await request(app)
      .post(`/api/issues/${issue.id}/answer-question`)
      .send({ questionCommentId: question.id, answer: input.answer });
    expect(res.status).toBe(201);
    const answerCommentId = res.body.comment.id as string;

    // Attach a stored object to the ANSWER comment (mirrors the upload route).
    const attachment = await svc.createAttachment({
      issueId: issue.id,
      issueCommentId: answerCommentId,
      provider: "local-disk",
      objectKey: `issues/${issue.id}/${input.contentType.replace("/", "_")}-${answerCommentId}`,
      contentType: input.contentType,
      byteSize: 42,
      sha256: "0".repeat(64),
      originalFilename: "answer-attachment",
      createdByUserId: "local-board",
    });

    return { issue, question, answerCommentId, attachment };
  }

  it("a PDF attachment on the answer enqueues a job; the answer route stays fast", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Pricing terms",
      questionBody: "What are the agreed pricing terms?",
      answer: "See the attached signed contract.",
      contentType: "application/pdf",
    });

    // We attached AFTER the answer route ran (the upload route would normally do
    // this with the answer comment id), so explicitly enqueue via the route's helper
    // path would not have fired. Drive the enqueue the way the upload+answer flow
    // does: re-post is not needed — instead assert the drain enqueues nothing yet,
    // then enqueue directly through the public helper used by the route.
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "What are the agreed pricing terms?",
      answerText: "See the attached signed contract.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });

    const jobs = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].contentType).toBe("application/pdf");
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].issueId).toBe(issue.id);
  });

  it("draining a PDF job captures human-answer/verified with the extracted text + redaction", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Onboarding doc",
      questionBody: "Where is the onboarding runbook?",
      answer: "Attached.",
      contentType: "application/pdf",
    });

    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "Where is the onboarding runbook?",
      answerText: "Attached.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });

    // The extracted PDF text carries a secret → it must be redacted before capture.
    const extractor = fakeExtractor({
      pdfText: "Runbook: deploy with token sk-live-ABCDEFGHIJKLMNOPQRSTUVWX then verify.",
    });
    const result = await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor,
    });
    expect(result.captured).toBe(1);

    const source = `attachment-extract:${attachment.assetId}`;
    const [entry] = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
    expect(entry).toBeTruthy();
    expect(entry!.provenance).toBe("human-answer");
    // Note: redaction quarantines to needs_review (a secret was present), which is the
    // correct trust outcome — a verified secret must never land. The extracted CONTENT
    // is present but the secret span is redacted.
    expect(entry!.verificationState).toBe("needs_review");
    expect(entry!.sourceRefType).toBe("attachment");
    expect(entry!.sourceRefId).toBe(attachment.assetId);
    expect(entry!.layer).toBe("workspace");
    expect(entry!.body).toContain("Runbook: deploy with token");
    expect(entry!.body).not.toContain("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(entry!.body).toContain("***REDACTED***");

    // The job is deleted on success.
    const jobs = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(jobs).toHaveLength(0);
  });

  it("a clean PDF transcription lands verified (no redaction findings)", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Spec",
      questionBody: "What does the spec say about retries?",
      answer: "See attached.",
      contentType: "application/pdf",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "What does the spec say about retries?",
      answerText: "See attached.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });

    await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: fakeExtractor({ pdfText: "Retries: exponential backoff, max five attempts." }),
    });

    const source = `attachment-extract:${attachment.assetId}`;
    const [entry] = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
    expect(entry!.provenance).toBe("human-answer");
    expect(entry!.verificationState).toBe("verified");
    expect(entry!.body).toContain("exponential backoff");
  });

  it("an image attachment lands provenance verified-summary / verified", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Whiteboard photo",
      questionBody: "What did the architecture sketch show?",
      answer: "See the whiteboard photo.",
      contentType: "image/png",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "What did the architecture sketch show?",
      answerText: "See the whiteboard photo.",
      attachments: [
        { assetId: attachment.assetId, contentType: "image/png", issueCommentId: attachment.issueCommentId },
      ],
    });

    await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: fakeExtractor({
        imageText: "A box-and-arrow diagram: client -> gateway -> three services.",
      }),
    });

    const source = `attachment-extract:${attachment.assetId}`;
    const [entry] = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
    expect(entry).toBeTruthy();
    expect(entry!.provenance).toBe("verified-summary");
    expect(entry!.verificationState).toBe("verified");
    expect(entry!.sourceRefType).toBe("attachment");
    expect(entry!.body).toContain("box-and-arrow diagram");
  });

  it("an extractor that throws keeps the text answer AND leaves the job for retry (attempts bumped)", async () => {
    const { issue, question, answerCommentId, attachment } = await answerWithAttachment({
      title: "Resilient extraction",
      questionBody: "Does an extraction failure lose the answer?",
      answer: "No — the text answer survives.",
      contentType: "application/pdf",
    });

    // The TEXT answer was already captured by HOOK 1 in the answer route.
    const textSource = `human-answer:${issue.id}:${answerCommentId}`;
    const textRows = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, textSource)));
    expect(textRows).toHaveLength(1);
    expect(textRows[0].provenance).toBe("human-answer");

    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: question.body,
      answerText: "No — the text answer survives.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });

    const result = await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: fakeExtractor({ throwOn: "pdf" }),
    });
    expect(result.failed).toBe(1);
    expect(result.captured).toBe(0);

    // No attachment-derived memory row was created…
    const attSource = `attachment-extract:${attachment.assetId}`;
    const attRows = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, attSource)));
    expect(attRows).toHaveLength(0);

    // …but the job survives for retry with attempts bumped + backoff scheduled.
    const [job] = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(job).toBeTruthy();
    expect(job!.attempts).toBe(1);
    expect(job!.lastError).toContain("synthetic pdf extract failure");
    expect(job!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // The text answer is still intact.
    const stillThere = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, textSource)));
    expect(stillThere).toHaveLength(1);
  });

  it("draining twice does not duplicate the captured memory row", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Idempotent extraction",
      questionBody: "Is the extraction capture retry-safe?",
      answer: "Yes.",
      contentType: "application/pdf",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "Is the extraction capture retry-safe?",
      answerText: "Yes.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });

    const extractor = fakeExtractor({ pdfText: "Capture is idempotent on the asset-id source key." });

    const first = await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor,
    });
    expect(first.captured).toBe(1);

    // Re-enqueue the SAME asset (simulating a re-fire of the answer route) and drain
    // again. The (company_id, source) onConflictDoNothing means no duplicate row.
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "Is the extraction capture retry-safe?",
      answerText: "Yes.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });
    await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor,
    });

    const source = `attachment-extract:${attachment.assetId}`;
    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
    expect(rows).toHaveLength(1);
  });

  it("the enqueue helper is idempotent: a second enqueue of the same asset is a no-op", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Enqueue idempotency",
      questionBody: "Does re-enqueue pile up jobs?",
      answer: "No.",
      contentType: "image/jpeg",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    const args = {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "Does re-enqueue pile up jobs?",
      answerText: "No.",
      attachments: [
        { assetId: attachment.assetId, contentType: "image/jpeg", issueCommentId: attachment.issueCommentId },
      ],
    };
    const a = await enqueueAttachmentExtractionJobs(handle.db, args);
    const b = await enqueueAttachmentExtractionJobs(handle.db, args);
    expect(a.enqueued).toBe(1);
    expect(b.enqueued).toBe(0);

    const jobs = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(jobs).toHaveLength(1);
  });

  // A call-counting extractor: proves the model is/ isn't called (the row-count
  // assertions elsewhere can't distinguish "captured once" from "charged twice").
  function countingExtractor(opts: { pdfText?: string | null; imageText?: string | null }) {
    const calls = { pdf: 0, image: 0 };
    const extractor: AttachmentExtractor = {
      enabled: true,
      async extractPdf() {
        calls.pdf += 1;
        return opts.pdfText ?? null;
      },
      async describeImage() {
        calls.image += 1;
        return opts.imageText ?? null;
      },
    };
    return { extractor, calls };
  }

  // MAX_ATTEMPTS is 12 internally; pre-seed attempts to 11 so the NEXT failure is the
  // ceiling without driving 12 real drains.
  const ATTEMPTS_BEFORE_CEILING = 11;

  it("F1: a permanently-failing job becomes terminal ('failed') at MAX_ATTEMPTS and is never re-selected/re-charged", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Corrupt PDF",
      questionBody: "What is in this corrupt PDF?",
      answer: "Attached.",
      contentType: "application/pdf",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "What is in this corrupt PDF?",
      answerText: "Attached.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });
    // Jump to the brink of the ceiling.
    await handle.db
      .update(attachmentExtractionJobs)
      .set({ attempts: ATTEMPTS_BEFORE_CEILING })
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));

    // The ceiling-tipping drain marks it terminal.
    const failing = countingExtractor({ pdfText: null });
    failing.extractor.extractPdf = async () => {
      throw new Error("synthetic permanent failure");
    };
    const r1 = await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: failing.extractor,
    });
    expect(r1.failed).toBe(1);
    const [terminal] = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(terminal!.status).toBe("failed");
    // Parked far in the future so the time filter alone would also exclude it.
    expect(terminal!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000);

    // A subsequent drain must NOT re-select or re-charge the terminal row.
    const next = countingExtractor({ pdfText: "should never run" });
    const r2 = await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: next.extractor,
    });
    expect(next.calls.pdf).toBe(0);
    expect(r2.processed).toBe(0);
  });

  it("F2: an ENABLED extractor returning empty backs off (not re-called every tick), then is abandoned at MAX_ATTEMPTS", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Scanned blank PDF",
      questionBody: "What does the blank scan say?",
      answer: "Nothing legible.",
      contentType: "application/pdf",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "What does the blank scan say?",
      answerText: "Nothing legible.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });

    // First empty drain: attempts bumped + backed off, NOT re-called in a loop.
    const empty = countingExtractor({ pdfText: "" });
    await drainAttachmentExtractionJobs(handle.db, { storage: createStorageStub() as any, extractor: empty.extractor });
    expect(empty.calls.pdf).toBe(1);
    const [afterOne] = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(afterOne!.attempts).toBe(1);
    expect(afterOne!.lastError).toBe("empty_extraction");
    expect(afterOne!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // At the ceiling, an always-empty job is abandoned (deleted), not retried forever.
    await handle.db
      .update(attachmentExtractionJobs)
      .set({ attempts: ATTEMPTS_BEFORE_CEILING, nextAttemptAt: new Date(0) })
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    await drainAttachmentExtractionJobs(handle.db, { storage: createStorageStub() as any, extractor: empty.extractor });
    const remaining = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(remaining).toHaveLength(0);
  });

  it("F5: an oversized attachment is abandoned (terminal) WITHOUT calling the model or buffering bytes", async () => {
    const svc = issueService(handle.db);
    const issue = await svc.create(companyId, { title: "Huge PDF", status: "awaiting_user" });
    const question = await svc.addComment(issue.id, "What is in the giant PDF?", { kind: "question" });
    const answerRes = await request(app)
      .post(`/api/issues/${issue.id}/answer-question`)
      .send({ questionCommentId: question.id, answer: "See attached." });
    const answerCommentId = answerRes.body.comment.id as string;
    // byteSize ABOVE the 24MB PDF cap → the preflight gate trips before any fetch.
    const attachment = await svc.createAttachment({
      issueId: issue.id,
      issueCommentId: answerCommentId,
      provider: "local-disk",
      objectKey: `issues/${issue.id}/huge-${answerCommentId}`,
      contentType: "application/pdf",
      byteSize: 25_000_000,
      sha256: "0".repeat(64),
      originalFilename: "huge.pdf",
      createdByUserId: "local-board",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId,
      questionText: "What is in the giant PDF?",
      answerText: "See attached.",
      attachments: [{ assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: answerCommentId }],
    });

    const counting = countingExtractor({ pdfText: "must not run" });
    await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: counting.extractor,
    });
    expect(counting.calls.pdf).toBe(0); // never charged
    const jobs = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(jobs).toHaveLength(0); // terminal: dropped
    const source = `attachment-extract:${attachment.assetId}`;
    const rows = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
    expect(rows).toHaveLength(0);
  });

  it("F4: a secret typed into the ANSWER (not the attachment) is redacted at rest + quarantined", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "Secret in answer",
      questionBody: "What is the deploy token?",
      answer: "The token is sk-live-ABCDEFGHIJKLMNOPQRSTUVWX — see attached.",
      contentType: "application/pdf",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "What is the deploy token?",
      // The UNREDACTED typed answer (the upload-route enqueue carries it verbatim).
      answerText: "The token is sk-live-ABCDEFGHIJKLMNOPQRSTUVWX — see attached.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });

    // The ATTACHMENT content is clean — the secret is only in the typed answer.
    await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: fakeExtractor({ pdfText: "Deployment runbook with no secrets." }),
    });

    const source = `attachment-extract:${attachment.assetId}`;
    const [entry] = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
    expect(entry).toBeTruthy();
    expect(entry!.body).not.toContain("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(entry!.body).toContain("***REDACTED***");
    // A finding ANYWHERE in the composed body quarantines the whole entry.
    expect(entry!.verificationState).toBe("needs_review");
  });

  it("Cond 1: the drainer DROPS an off-tenant job under a pin (no model call, no capture)", async () => {
    const savedUrl = process.env.COMBYNE_CONTEXT_DATABASE_URL;
    const savedPin = process.env.COMBYNE_CONTEXT_COMPANY_ID;
    try {
      const { issue, attachment } = await answerWithAttachment({
        title: "Off-tenant attachment",
        questionBody: "Should an off-tenant attachment be captured?",
        answer: "No.",
        contentType: "application/pdf",
      });
      const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
      await enqueueAttachmentExtractionJobs(handle.db, {
        companyId, // this company is NOT the pin below
        issueId: issue.id,
        answerCommentId: attachment.issueCommentId!,
        questionText: "Should an off-tenant attachment be captured?",
        answerText: "No.",
        attachments: [
          { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
        ],
      });
      // Pin the rail to a DIFFERENT company id with a separate context URL active.
      process.env.COMBYNE_CONTEXT_DATABASE_URL = handle.connectionString;
      process.env.COMBYNE_CONTEXT_COMPANY_ID = "11111111-1111-4111-8111-111111111111";

      const counting = countingExtractor({ pdfText: "must not run" });
      await drainAttachmentExtractionJobs(handle.db, {
        storage: createStorageStub() as any,
        extractor: counting.extractor,
      });
      expect(counting.calls.pdf).toBe(0); // off-tenant: dropped before the model call
      const jobs = await handle.db
        .select()
        .from(attachmentExtractionJobs)
        .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
      expect(jobs).toHaveLength(0); // terminal drop
      const source = `attachment-extract:${attachment.assetId}`;
      const rows = await handle.db
        .select()
        .from(memoryEntries)
        .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
      expect(rows).toHaveLength(0);
    } finally {
      process.env.COMBYNE_CONTEXT_DATABASE_URL = savedUrl ?? "";
      process.env.COMBYNE_CONTEXT_COMPANY_ID = savedPin ?? "";
    }
  });

  it("P1-b: when the context write fails but the outbox enqueue SUCCEEDS, the job is deleted (durably queued)", async () => {
    const savedUrl = process.env.COMBYNE_CONTEXT_DATABASE_URL;
    const savedPin = process.env.COMBYNE_CONTEXT_COMPANY_ID;
    try {
      const { issue, attachment } = await answerWithAttachment({
        title: "Durable queue",
        questionBody: "Is the capture durable when the rail is down?",
        answer: "Yes — queued.",
        contentType: "application/pdf",
      });
      const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
      await enqueueAttachmentExtractionJobs(handle.db, {
        companyId,
        issueId: issue.id,
        answerCommentId: attachment.issueCommentId!,
        questionText: "Is the capture durable when the rail is down?",
        answerText: "Yes — queued.",
        attachments: [
          { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
        ],
      });

      // Route memory writes to an UNREACHABLE context DB (port 1 = instant refuse) so
      // createEntry fails — but the outbox lives in the reachable ops DB (handle.db),
      // so the enqueue succeeds. NO pin set, so the fence is inert and capture runs.
      process.env.COMBYNE_CONTEXT_DATABASE_URL = "postgres://combyne:combyne@127.0.0.1:1/combyne";
      process.env.COMBYNE_CONTEXT_COMPANY_ID = "";

      await drainAttachmentExtractionJobs(handle.db, {
        storage: createStorageStub() as any,
        extractor: fakeExtractor({ pdfText: "Durable content." }),
      });

      // Job is gone (durably queued, not retried-forever)…
      const jobs = await handle.db
        .select()
        .from(attachmentExtractionJobs)
        .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
      expect(jobs).toHaveLength(0);
      // …and the full payload is in the outbox for replay.
      const source = `attachment-extract:${attachment.assetId}`;
      const queued = await handle.db
        .select()
        .from(contextCaptureOutbox)
        .where(eq(contextCaptureOutbox.source, source));
      expect(queued).toHaveLength(1);
      await handle.db.delete(contextCaptureOutbox).where(eq(contextCaptureOutbox.source, source));
    } finally {
      process.env.COMBYNE_CONTEXT_DATABASE_URL = savedUrl ?? "";
      process.env.COMBYNE_CONTEXT_COMPANY_ID = savedPin ?? "";
    }
  });

  it("a disabled extractor leaves jobs pending (no capture, no model call)", async () => {
    const { issue, attachment } = await answerWithAttachment({
      title: "No key",
      questionBody: "What happens with no ANTHROPIC_API_KEY?",
      answer: "Jobs wait.",
      contentType: "application/pdf",
    });
    const { enqueueAttachmentExtractionJobs } = await import("../services/memory-capture.js");
    await enqueueAttachmentExtractionJobs(handle.db, {
      companyId,
      issueId: issue.id,
      answerCommentId: attachment.issueCommentId!,
      questionText: "What happens with no ANTHROPIC_API_KEY?",
      answerText: "Jobs wait.",
      attachments: [
        { assetId: attachment.assetId, contentType: "application/pdf", issueCommentId: attachment.issueCommentId },
      ],
    });

    const disabled: AttachmentExtractor = {
      enabled: false,
      async extractPdf() {
        throw new Error("must not be called");
      },
      async describeImage() {
        throw new Error("must not be called");
      },
    };
    const result = await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: disabled,
    });
    expect(result.captured).toBe(0);

    // The job is still pending (it was not consumed or failed).
    const jobs = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, attachment.assetId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].attempts).toBe(0);
  });

  it("end-to-end: uploading a PDF to an answer comment via the upload route enqueues + captures", async () => {
    // Answer FIRST (creates the answer comment), THEN upload the PDF linked to it —
    // the realistic UI flow. The upload route is where the attachment becomes
    // visible on the answer, so that is where the enqueue fires.
    const svc = issueService(handle.db);
    const issue = await svc.create(companyId, { title: "E2E upload", status: "awaiting_user" });
    const question = await svc.addComment(issue.id, "What is in the signed PDF?", { kind: "question" });

    const answerRes = await request(app)
      .post(`/api/issues/${issue.id}/answer-question`)
      .send({ questionCommentId: question.id, answer: "See the attached PDF." });
    expect(answerRes.status).toBe(201);
    const answerCommentId = answerRes.body.comment.id as string;

    const uploadRes = await request(app)
      .post(`/api/companies/${companyId}/issues/${issue.id}/attachments`)
      .field("issueCommentId", answerCommentId)
      .attach("file", Buffer.from("%PDF-1.4 signed contract bytes"), {
        filename: "contract.pdf",
        contentType: "application/pdf",
      });
    expect(uploadRes.status).toBe(201);
    const assetId = uploadRes.body.assetId as string;
    expect(assetId).toBeTruthy();

    // The upload route enqueued an extraction job for the answer attachment.
    const jobs = await handle.db
      .select()
      .from(attachmentExtractionJobs)
      .where(eq(attachmentExtractionJobs.assetId, assetId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].questionText).toContain("signed PDF");
    expect(jobs[0].answerCommentId).toBe(answerCommentId);

    // Draining with a fake extractor captures the content into the central DB.
    await drainAttachmentExtractionJobs(handle.db, {
      storage: createStorageStub() as any,
      extractor: fakeExtractor({ pdfText: "Signed contract: net-30 payment terms." }),
    });
    const source = `attachment-extract:${assetId}`;
    const [entry] = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.companyId, companyId), eq(memoryEntries.source, source)));
    expect(entry).toBeTruthy();
    expect(entry!.provenance).toBe("human-answer");
    expect(entry!.verificationState).toBe("verified");
    expect(entry!.sourceRefType).toBe("attachment");
    expect(entry!.body).toContain("net-30 payment terms");
    expect(entry!.body).toContain("Q: What is in the signed PDF?");
  });
});
