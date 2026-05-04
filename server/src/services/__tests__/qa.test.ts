import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentHandoffs, agents, companies, issueComments, issues, qaFeedbackEvents, qaTestResults, qaTestSuites } from "@combyne/db";
import { qaService } from "../qa.js";
import { startTestDb, stopTestDb, type TestDbHandle } from "./_test-db.js";

describe("qa service", () => {
  let handle: TestDbHandle;
  let companyId: string;
  let qaAgentId: string;
  let devAgentId: string;
  let issueId: string;

  beforeAll(async () => {
    handle = await startTestDb();
    const [company] = await handle.db.insert(companies).values({ name: "QA Co", issuePrefix: "QA" }).returning();
    companyId = company.id;
    const [qaAgent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Android QA", role: "qa", adapterType: "process" })
      .returning();
    qaAgentId = qaAgent.id;
    const [devAgent] = await handle.db
      .insert(agents)
      .values({ companyId, name: "Lender Engineer", role: "engineer", adapterType: "process" })
      .returning();
    devAgentId = devAgent.id;
    const [issue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Validate lender callback", status: "in_review", assigneeAgentId: devAgentId })
      .returning();
    issueId = issue.id;
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopTestDb();
  });

  it("creates reusable cases, suites, devices, runs, results, and exports", async () => {
    const svc = qaService(handle.db);
    const testCase = await svc.createCase(companyId, {
      title: "Approved callback payload",
      expectedResult: "Payload is accepted",
      platform: "api",
      service: "lender",
      steps: ["POST callback"],
      tags: ["rest-assured"],
    });
    const suite = await svc.createSuite(companyId, {
      name: "Lender REST Assured",
      platform: "api",
      runnerType: "rest_assured",
      parserType: "junit_xml",
      service: "lender",
      caseIds: [testCase.id],
      commandProfile: { command: "mvn test" },
    });
    const updatedSuite = await svc.createSuite(companyId, {
      name: "Lender REST Assured",
      platform: "api",
      runnerType: "rest_assured",
      parserType: "junit_xml",
      service: "lender",
      commandProfile: { command: "./gradlew test" },
      tags: ["rest-assured", "lender"],
    });
    expect(updatedSuite.id).toBe(suite.id);
    expect((updatedSuite.commandProfile as Record<string, unknown>).command).toBe("./gradlew test");
    const matchingSuites = await handle.db.select().from(qaTestSuites).where(eq(qaTestSuites.name, "Lender REST Assured"));
    expect(matchingSuites).toHaveLength(1);
    const device = await svc.registerDevice(companyId, {
      workerId: "worker-1",
      name: "Pixel_7_API_35",
      apiLevel: "35",
      healthStatus: "healthy",
      capabilities: { reactNative: true, emulatorFirst: true },
    });
    const run = await svc.createRun(companyId, {
      issueId,
      suiteId: suite.id,
      deviceId: device.id,
      qaAgentId,
      title: "Run lender API QA",
    }, { agentId: qaAgentId, runId: null });
    expect(run.runnerType).toBe("rest_assured");
    expect((run.metadata as Record<string, unknown>).runnerCommand).toBeTruthy();

    await svc.addResultsFromJUnit(run.id, `
      <testsuite>
        <testcase classname="LenderApiTest" name="approvedPayload" />
        <testcase classname="LenderApiTest" name="badPayload"><failure>expected validation error</failure></testcase>
      </testsuite>
    `);
    const results = await handle.db.select().from(qaTestResults).where(eq(qaTestResults.runId, run.id));
    expect(results).toHaveLength(2);
    const detail = await svc.getRunDetail(run.id);
    expect(detail.run.status).toBe("failed");

    const csv = await svc.exportRun(run.id, { format: "csv" });
    expect(csv.content).toContain("LenderApiTest.badPayload");
    const pdf = await svc.exportRun(run.id, { format: "pdf" });
    expect(pdf.content).toContain("%PDF-1.4");
  });

  it("deduplicates QA feedback and waits for QA approval before developer handoff", async () => {
    const svc = qaService(handle.db);
    const run = await svc.createRun(companyId, {
      issueId,
      qaAgentId,
      title: "Failing Android QA",
      platform: "android",
      runnerType: "android_emulator",
      parserType: "maestro",
    }, { agentId: qaAgentId, runId: null });
    await svc.addResult(run.id, {
      title: "Login flow",
      status: "failed",
      failureReason: "App crashed after OTP submit",
    });

    const first = await svc.createFeedbackForRun(run.id, {
      toAgentId: devAgentId,
      createBugIssue: false,
      wakeDeveloper: false,
    }, { agentId: qaAgentId });
    const second = await svc.createFeedbackForRun(run.id, {
      toAgentId: devAgentId,
      createBugIssue: false,
      wakeDeveloper: false,
    }, { agentId: qaAgentId });

    expect(second.id).toBe(first.id);
    expect(first.status).toBe("pending_qa_approval");
    const feedback = await handle.db.select().from(qaFeedbackEvents).where(eq(qaFeedbackEvents.runId, run.id));
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.status).toBe("pending_qa_approval");

    const handoffs = await handle.db.select().from(agentHandoffs).where(eq(agentHandoffs.issueId, issueId));
    expect(handoffs.some((handoff) => handoff.toAgentId === devAgentId)).toBe(false);
    const comments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("QA Feedback"))).toBe(false);

    const approved = await svc.approveFeedbackForDevelopers(first.id, {
      userId: "qa-lead",
      note: "Approved by QA lead.",
    });
    expect(approved.status).toBe("approved_for_dev");
    expect((approved.metadata as Record<string, unknown>).developerVisible).toBe(true);

    const approvedHandoffs = await handle.db.select().from(agentHandoffs).where(eq(agentHandoffs.issueId, issueId));
    expect(approvedHandoffs.some((handoff) => handoff.toAgentId === devAgentId)).toBe(true);
    const approvedComments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(approvedComments.some((comment) => comment.body.includes("QA approved for developer handoff"))).toBe(true);
  });
});
