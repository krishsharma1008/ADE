import { companies } from "@combyne/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueService } from "../services/issues.js";
import {
  startTestDb,
  stopTestDb,
  type TestDbHandle,
} from "../services/__tests__/_test-db.js";

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
