import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentHandoffs, agents, companies, heartbeatRuns, issueComments, issues, qaFeedbackEvents, qaTestResults, qaTestSuites } from "@combyne/db";
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
    await handle.db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: devAgentId, status: "running", invocationSource: "on_demand" });
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
    expect(pdf.content).toContain("QA Validation Report");
    expect(pdf.content).toContain("Result Details");
    expect(pdf.content).toContain("Failures and Blockers");
    expect(pdf.content).toContain("LenderApiTest.badPayload");
    expect(pdf.content).not.toContain("# QA Report");
  });

  it("does not export a final QA report while a run is still queued", async () => {
    const svc = qaService(handle.db);
    const run = await svc.createRun(companyId, {
      issueId,
      qaAgentId,
      title: "Queued QA report",
      platform: "api",
      runnerType: "rest_assured",
      parserType: "junit_xml",
    }, { agentId: qaAgentId, runId: null });

    await expect(svc.exportRun(run.id, { format: "pdf" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("QA report is not ready yet"),
    });
  });

  it("deduplicates QA feedback and sends it to the developer by default", async () => {
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
      expectedResult: "User lands on dashboard after OTP",
      actualResult: "App terminates on OTP submit",
      failureReason: "App crashed after OTP submit",
    });

    const first = await svc.createFeedbackForRun(run.id, {
      toAgentId: devAgentId,
      createBugIssue: false,
      body: `
stdout: demographic setter output
const demographicSetter = () => {
  return rawPayload;
}
Human-readable note: OTP crash reproduces every run.
      `,
    }, { agentId: qaAgentId });
    const second = await svc.createFeedbackForRun(run.id, {
      toAgentId: devAgentId,
      createBugIssue: false,
    }, { agentId: qaAgentId });

    expect(second.id).toBe(first.id);
    expect(first.status).toBe("sent_to_dev");
    const feedback = await handle.db.select().from(qaFeedbackEvents).where(eq(qaFeedbackEvents.runId, run.id));
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.status).toBe("sent_to_dev");

    const handoffs = await handle.db.select().from(agentHandoffs).where(eq(agentHandoffs.issueId, issueId));
    expect(handoffs.some((handoff) => handoff.toAgentId === devAgentId)).toBe(true);
    const comments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => comment.body.includes("QA feedback sent to developer"))).toBe(true);
    const qaComment = comments.find((comment) => comment.body.includes("## QA feedback: Failing Android QA"));
    expect(qaComment?.body).toContain("### Summary");
    expect(qaComment?.body).toContain("Requested action");
    expect(qaComment?.body).toContain("Expected: User lands on dashboard after OTP");
    expect(qaComment?.body).toContain("Actual: App terminates on OTP submit");
    expect(qaComment?.body).toContain("Human-readable note: OTP crash reproduces every run.");
    expect(qaComment?.body).not.toContain("demographic setter output");
    expect(qaComment?.body).not.toContain("const demographicSetter");
    const runs = await handle.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, devAgentId));
    expect(runs.some((heartbeatRun) => {
      const context = heartbeatRun.contextSnapshot as Record<string, unknown> | null;
      return context?.wakeReason === "qa_feedback" &&
        context?.wakeCommentId &&
        typeof context?.qaFeedbackSummary === "string";
    })).toBe(true);
  });

  it("keeps the QA approval gate when explicitly requested", async () => {
    const svc = qaService(handle.db);
    const [approvalIssue] = await handle.db
      .insert(issues)
      .values({ companyId, title: "Validate approval gated QA", status: "in_review", assigneeAgentId: devAgentId })
      .returning();
    const run = await svc.createRun(companyId, {
      issueId: approvalIssue.id,
      qaAgentId,
      title: "Approval-gated QA",
      platform: "android",
      runnerType: "android_emulator",
      parserType: "maestro",
    }, { agentId: qaAgentId, runId: null });
    await svc.addResult(run.id, {
      title: "Settings flow",
      status: "failed",
      failureReason: "Validation failed",
    });

    const first = await svc.createFeedbackForRun(run.id, {
      toAgentId: devAgentId,
      createBugIssue: false,
      wakeDeveloper: false,
      requiresApproval: true,
    }, { agentId: qaAgentId });

    expect(first.status).toBe("pending_qa_approval");
    const handoffs = await handle.db.select().from(agentHandoffs).where(eq(agentHandoffs.issueId, approvalIssue.id));
    expect(handoffs.some((handoff) => handoff.toAgentId === devAgentId)).toBe(false);
    const comments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, approvalIssue.id));
    expect(comments.some((comment) => comment.body.includes("QA feedback sent to developer"))).toBe(false);

    const approved = await svc.approveFeedbackForDevelopers(first.id, {
      userId: "qa-lead",
      note: "Approved by QA lead.",
    });
    expect(approved.status).toBe("approved_for_dev");
    expect((approved.metadata as Record<string, unknown>).developerVisible).toBe(true);

    const approvedHandoffs = await handle.db.select().from(agentHandoffs).where(eq(agentHandoffs.issueId, approvalIssue.id));
    expect(approvedHandoffs.some((handoff) => handoff.toAgentId === devAgentId)).toBe(true);
    const approvedComments = await handle.db.select().from(issueComments).where(eq(issueComments.issueId, approvalIssue.id));
    expect(approvedComments.some((comment) => comment.body.includes("QA approved for developer handoff"))).toBe(true);
  });
});
