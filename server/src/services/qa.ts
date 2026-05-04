import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import {
  agents,
  issueComments,
  issues,
  qaArtifacts,
  qaDevices,
  qaEnvironments,
  qaFeedbackEvents,
  qaTestCases,
  qaTestResults,
  qaTestRuns,
  qaTestSuites,
} from "@combyne/db";
import type {
  GitHubConfig,
  JiraConfig,
  QaArtifactCreate,
  QaDeviceDiscoveryResult,
  QaDeviceRegister,
  QaEnvironmentUpsert,
  QaExport,
  QaFeedbackSend,
  QaRunDetail,
  QaSummary,
  QaTestCaseCreate,
  QaTestResultCreate,
  QaTestRunCreate,
  QaTestRunUpdate,
  QaTestSuiteCreate,
} from "@combyne/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { createHandoff } from "./agent-handoff.js";
import { heartbeatService } from "./heartbeat.js";
import { integrationService } from "./integrations.js";
import { issueService } from "./issues.js";
import { createGitHubClient } from "./github.js";
import { createJiraClient } from "./jira.js";
import {
  buildQaRunnerCommand,
  discoverLocalAndroidEmulators,
  parseJUnitXml,
  recommendedArtifactTypesForParser,
  statusFromGitHubChecks,
} from "./qa-runner.js";

function now() {
  return new Date();
}

function isFailure(status: string) {
  return status === "failed" || status === "blocked";
}

function feedbackHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function countBy<T extends { status: string }>(rows: T[]) {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = (out[row.status] ?? 0) + 1;
  return out;
}

function normalizeRunPatch(data: QaTestRunUpdate): Partial<typeof qaTestRuns.$inferInsert> {
  return {
    ...data,
    startedAt: data.startedAt === undefined ? undefined : data.startedAt ? new Date(data.startedAt) : null,
    finishedAt: data.finishedAt === undefined ? undefined : data.finishedAt ? new Date(data.finishedAt) : null,
    updatedAt: now(),
  };
}

function runToCsv(detail: QaRunDetail) {
  const rows = [
    ["run_id", "suite", "platform", "runner", "case", "status", "failure_reason", "duration_ms"],
    ...detail.results.map((result) => [
      detail.run.id,
      detail.suite?.name ?? "",
      detail.run.platform,
      detail.run.runnerType,
      result.title,
      result.status,
      result.failureReason ?? "",
      result.durationMs?.toString() ?? "",
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function runToReport(detail: QaRunDetail) {
  const failed = detail.results.filter((r) => isFailure(r.status));
  const lines: string[] = [];
  lines.push(`# QA Report — ${detail.run.title}`);
  lines.push("");
  lines.push(`- Status: ${detail.run.status}`);
  lines.push(`- Platform: ${detail.run.platform}`);
  lines.push(`- Runner: ${detail.run.runnerType}`);
  if (detail.run.repo) lines.push(`- Repo: ${detail.run.repo}${detail.run.pullNumber ? `#${detail.run.pullNumber}` : ""}`);
  if (detail.run.headSha) lines.push(`- Head SHA: ${detail.run.headSha}`);
  if (detail.suite) lines.push(`- Suite: ${detail.suite.name}`);
  if (detail.device) lines.push(`- Device: ${detail.device.name} (${detail.device.apiLevel ?? "unknown API"})`);
  lines.push("");
  lines.push(`## Results`);
  lines.push(`- Total: ${detail.results.length}`);
  lines.push(`- Failed/blocked: ${failed.length}`);
  for (const result of detail.results) {
    lines.push(`- [${result.status}] ${result.title}${result.failureReason ? ` — ${result.failureReason}` : ""}`);
  }
  if (detail.artifacts.length > 0) {
    lines.push("", "## Artifacts");
    for (const artifact of detail.artifacts) {
      lines.push(`- ${artifact.type}: ${artifact.title}${artifact.url ? ` (${artifact.url})` : ""}`);
    }
  }
  return lines.join("\n");
}

function minimalPdf(text: string) {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .split("\n")
    .slice(0, 50)
    .join("\\n");
  return `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${escaped.length + 64} >> stream
BT /F1 10 Tf 50 742 Td (${escaped}) Tj ET
endstream endobj
xref
0 6
0000000000 65535 f 
trailer << /Root 1 0 R /Size 6 >>
startxref
0
%%EOF`;
}

export function qaService(db: Db) {
  const integrations = integrationService(db);

  async function getRun(id: string) {
    return db.select().from(qaTestRuns).where(eq(qaTestRuns.id, id)).then((rows) => rows[0] ?? null);
  }

  async function getRunDetail(id: string): Promise<QaRunDetail> {
    const run = await getRun(id);
    if (!run) throw notFound("QA run not found");
    const [suite, environment, device, results, artifacts, feedbackEvents] = await Promise.all([
      run.suiteId ? db.select().from(qaTestSuites).where(eq(qaTestSuites.id, run.suiteId)).then((r) => r[0] ?? null) : null,
      run.environmentId ? db.select().from(qaEnvironments).where(eq(qaEnvironments.id, run.environmentId)).then((r) => r[0] ?? null) : null,
      run.deviceId ? db.select().from(qaDevices).where(eq(qaDevices.id, run.deviceId)).then((r) => r[0] ?? null) : null,
      db.select().from(qaTestResults).where(eq(qaTestResults.runId, id)).orderBy(qaTestResults.createdAt),
      db.select().from(qaArtifacts).where(eq(qaArtifacts.runId, id)).orderBy(qaArtifacts.createdAt),
      db.select().from(qaFeedbackEvents).where(eq(qaFeedbackEvents.runId, id)).orderBy(desc(qaFeedbackEvents.createdAt)),
    ]);
    return { run: run as never, suite: suite as never, environment: environment as never, device: device as never, results: results as never, artifacts: artifacts as never, feedbackEvents: feedbackEvents as never };
  }

  async function assertRunCompany(runId: string, companyId: string) {
    const run = await getRun(runId);
    if (!run) throw notFound("QA run not found");
    if (run.companyId !== companyId) throw forbidden("QA run belongs to another company");
    return run;
  }

  async function refreshRunConclusion(runId: string) {
    const results = await db.select().from(qaTestResults).where(eq(qaTestResults.runId, runId));
    if (results.length === 0) return getRun(runId);
    const status = results.some((r) => r.status === "failed")
      ? "failed"
      : results.some((r) => r.status === "blocked")
        ? "blocked"
        : "passed";
    return db
      .update(qaTestRuns)
      .set({ status, conclusion: status, finishedAt: status === "passed" || status === "failed" ? now() : undefined, updatedAt: now() })
      .where(eq(qaTestRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function createFeedbackForRun(runId: string, input: QaFeedbackSend, actor: { userId?: string | null; agentId?: string | null }) {
    const detail = await getRunDetail(runId);
    const failed = detail.results.filter((result) => isFailure(result.status));
    if (failed.length === 0 && !input.body) {
      throw unprocessable("QA run has no failures to send");
    }
    const issue = detail.run.issueId
      ? await db.select().from(issues).where(eq(issues.id, detail.run.issueId)).then((rows) => rows[0] ?? null)
      : null;
    const targetAgentId = input.toAgentId ?? issue?.assigneeAgentId ?? detail.run.requestedByAgentId ?? null;
    const title = input.title ?? `QA feedback: ${detail.run.title}`;
    const body = input.body ?? buildFeedbackBody(detail);
    const hash = feedbackHash({
      companyId: detail.run.companyId,
      runId,
      issueId: detail.run.issueId,
      targetAgentId,
      failures: failed.map((r) => [r.title, r.status, r.failureReason]),
    });
    const artifactRefs = detail.artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      url: artifact.url,
    }));

    const existing = await db
      .select()
      .from(qaFeedbackEvents)
      .where(and(eq(qaFeedbackEvents.companyId, detail.run.companyId), eq(qaFeedbackEvents.dedupeHash, hash)))
      .then((rows) => rows[0] ?? null);

    const metadata = {
      runTitle: detail.run.title,
      runnerType: detail.run.runnerType,
      requestedCreateBugIssue: input.createBugIssue === true,
      requestedWakeDeveloper: input.wakeDeveloper !== false,
      requestedByUserId: actor.userId ?? null,
      requestedByAgentId: actor.agentId ?? null,
      developerVisible: existing?.status === "approved_for_dev" || existing?.status === "sent_to_dev",
    };

    if (existing?.status === "approved_for_dev" || existing?.status === "sent_to_dev") {
      return existing;
    }

    if (existing) {
      const [updated] = await db
        .update(qaFeedbackEvents)
        .set({
          toAgentId: targetAgentId,
          title,
          body,
          severity: input.severity ?? existing.severity,
          artifactRefs,
          metadata: { ...(existing.metadata ?? {}), ...metadata },
          updatedAt: now(),
        })
        .where(eq(qaFeedbackEvents.id, existing.id))
        .returning();
      return updated;
    }

    return db
      .insert(qaFeedbackEvents)
      .values({
        companyId: detail.run.companyId,
        runId,
        issueId: detail.run.issueId,
        fromQaAgentId: detail.run.qaAgentId ?? actor.agentId ?? null,
        toAgentId: targetAgentId,
        title,
        body,
        status: "pending_qa_approval",
        severity: input.severity ?? (failed.some((r) => r.status === "blocked") ? "high" : "medium"),
        dedupeHash: hash,
        artifactRefs,
        metadata,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function getFeedback(feedbackId: string) {
    return db.select().from(qaFeedbackEvents).where(eq(qaFeedbackEvents.id, feedbackId)).then((rows) => rows[0] ?? null);
  }

  async function approveFeedbackForDevelopers(feedbackId: string, input: { userId?: string | null; note?: string | null }) {
    const feedback = await getFeedback(feedbackId);
    if (!feedback) throw notFound("QA feedback not found");
    if (feedback.status === "approved_for_dev" || feedback.status === "sent_to_dev") {
      return feedback;
    }

    const detail = feedback.runId ? await getRunDetail(feedback.runId) : null;
    const issue = feedback.issueId
      ? await db.select().from(issues).where(eq(issues.id, feedback.issueId)).then((rows) => rows[0] ?? null)
      : null;
    const metadata = (feedback.metadata ?? {}) as Record<string, unknown>;
    const shouldCreateBugIssue = metadata.requestedCreateBugIssue === true;
    const shouldWakeDeveloper = metadata.requestedWakeDeveloper !== false;
    let bugIssueId = feedback.bugIssueId;

    if (shouldCreateBugIssue && feedback.issueId && !bugIssueId) {
      const bug = await issueService(db).create(feedback.companyId, {
        title: feedback.title,
        description: feedback.body,
        status: "todo",
        priority: feedback.severity === "critical" ? "critical" : "high",
        parentId: feedback.issueId,
        assigneeAgentId: feedback.toAgentId,
        createdByAgentId: null,
        createdByUserId: input.userId ?? null,
      });
      bugIssueId = bug.id;
    }

    if (feedback.issueId) {
      await db.insert(issueComments).values({
        companyId: feedback.companyId,
        issueId: feedback.issueId,
        authorAgentId: null,
        authorUserId: input.userId ?? null,
        body: `${feedback.body}\n\n_QA approved for developer handoff._${input.note ? `\n\nApproval note: ${input.note}` : ""}`,
      });
    }

    if (feedback.toAgentId && feedback.issueId) {
      await createHandoff(db, {
        companyId: feedback.companyId,
        issueId: feedback.issueId,
        fromAgentId: feedback.fromQaAgentId,
        toAgentId: feedback.toAgentId,
      });
      if (shouldWakeDeveloper) {
        await heartbeatService(db).wakeup(feedback.toAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "qa_feedback",
          payload: { qaFeedbackEventId: feedback.id, qaRunId: feedback.runId, issueId: feedback.issueId },
          requestedByActorType: "user",
          requestedByActorId: input.userId ?? "board",
          contextSnapshot: { qaFeedbackEventId: feedback.id, qaRunId: feedback.runId },
        });
      }
    }

    const [updated] = await db
      .update(qaFeedbackEvents)
      .set({
        status: "approved_for_dev",
        sentAt: now(),
        createsBugIssue: Boolean(bugIssueId),
        bugIssueId,
        metadata: {
          ...metadata,
          developerVisible: true,
          approvedByUserId: input.userId ?? null,
          approvedAt: now().toISOString(),
          approvalNote: input.note ?? null,
          linkedIssueTitle: issue?.title ?? null,
          runTitle: detail?.run.title ?? metadata.runTitle ?? null,
        },
        updatedAt: now(),
      })
      .where(eq(qaFeedbackEvents.id, feedback.id))
      .returning();
    return updated;
  }

  function buildFeedbackBody(detail: QaRunDetail) {
    const failed = detail.results.filter((result) => isFailure(result.status));
    const lines = [`## QA Feedback — ${detail.run.title}`, "", `Runner: \`${detail.run.runnerType}\``, `Platform: \`${detail.run.platform}\``];
    if (detail.run.repo) lines.push(`Repo: \`${detail.run.repo}\`${detail.run.pullNumber ? ` PR #${detail.run.pullNumber}` : ""}`);
    if (detail.run.headSha) lines.push(`Head SHA: \`${detail.run.headSha}\``);
    lines.push("", "### Failures");
    for (const result of failed) {
      lines.push(`- **${result.title}**: ${result.failureReason ?? result.actualResult ?? result.status}`);
    }
    if (detail.artifacts.length > 0) {
      lines.push("", "### Evidence");
      for (const artifact of detail.artifacts.slice(0, 10)) {
        lines.push(`- ${artifact.type}: ${artifact.title}${artifact.url ? ` — ${artifact.url}` : ""}`);
      }
    }
    return lines.join("\n");
  }

  return {
    async summary(companyId: string): Promise<QaSummary> {
      const [runs, feedback, devices] = await Promise.all([
        db.select().from(qaTestRuns).where(eq(qaTestRuns.companyId, companyId)).orderBy(desc(qaTestRuns.updatedAt)).limit(20),
        db.select().from(qaFeedbackEvents).where(eq(qaFeedbackEvents.companyId, companyId)),
        db.select().from(qaDevices).where(eq(qaDevices.companyId, companyId)).orderBy(desc(qaDevices.updatedAt)).limit(10),
      ]);
      return {
        runCounts: countBy(runs),
        feedbackCounts: countBy(feedback),
        recentRuns: runs as never,
        devices: devices as never,
      };
    },

    listCases: (companyId: string) =>
      db.select().from(qaTestCases).where(eq(qaTestCases.companyId, companyId)).orderBy(desc(qaTestCases.updatedAt)),

    createCase: async (companyId: string, input: QaTestCaseCreate) => {
      const [row] = await db.insert(qaTestCases).values({
        ...input,
        companyId,
        projectId: input.projectId ?? null,
        issueId: input.issueId ?? null,
        ownerAgentId: input.ownerAgentId ?? null,
        description: input.description ?? null,
        steps: input.steps ?? [],
        platform: input.platform ?? "api",
        priority: input.priority ?? "medium",
        service: input.service ?? null,
        tags: input.tags ?? [],
        status: input.status ?? "active",
        metadata: input.metadata ?? null,
      }).returning();
      return row!;
    },

    listSuites: (companyId: string) =>
      db.select().from(qaTestSuites).where(eq(qaTestSuites.companyId, companyId)).orderBy(desc(qaTestSuites.updatedAt)),

    createSuite: async (companyId: string, input: QaTestSuiteCreate) => {
      const values = {
        name: input.name,
        projectId: input.projectId ?? null,
        description: input.description ?? null,
        platform: input.platform ?? "api",
        runnerType: input.runnerType ?? "custom_command",
        service: input.service ?? null,
        caseIds: input.caseIds ?? [],
        commandProfile: input.commandProfile ?? {},
        parserType: input.parserType ?? "none",
        tags: input.tags ?? [],
        status: input.status ?? "active",
        updatedAt: now(),
      };
      const existing = await db
        .select()
        .from(qaTestSuites)
        .where(and(eq(qaTestSuites.companyId, companyId), eq(qaTestSuites.name, input.name)))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        return db.update(qaTestSuites).set(values).where(eq(qaTestSuites.id, existing.id)).returning().then((rows) => rows[0]!);
      }
      return db.insert(qaTestSuites).values({ ...values, companyId }).returning().then((rows) => rows[0]!);
    },

    listEnvironments: (companyId: string) =>
      db.select().from(qaEnvironments).where(eq(qaEnvironments.companyId, companyId)).orderBy(desc(qaEnvironments.updatedAt)),

    createEnvironment: (companyId: string, input: QaEnvironmentUpsert) =>
      db.insert(qaEnvironments).values({
        companyId,
        name: input.name,
        kind: input.kind ?? "api",
        baseUrl: input.baseUrl ?? null,
        variables: input.variables ?? {},
        status: input.status ?? "active",
      }).returning().then((rows) => rows[0]) as never,

    listDevices: (companyId: string) =>
      db.select().from(qaDevices).where(eq(qaDevices.companyId, companyId)).orderBy(desc(qaDevices.updatedAt)),

    registerDevice: async (companyId: string, input: QaDeviceRegister) => {
      const existing = await db
        .select()
        .from(qaDevices)
        .where(and(eq(qaDevices.companyId, companyId), eq(qaDevices.workerId, input.workerId), eq(qaDevices.name, input.name)))
        .then((rows) => rows[0] ?? null);
      const values = {
        workerId: input.workerId,
        name: input.name,
        kind: input.kind ?? "android_emulator",
        platform: input.platform ?? "android",
        osVersion: input.osVersion ?? null,
        apiLevel: input.apiLevel ?? null,
        capabilities: input.capabilities ?? {},
        healthStatus: input.healthStatus ?? "unknown",
        lastSeenAt: now(),
        updatedAt: now(),
      };
      if (existing) {
        return db.update(qaDevices).set(values).where(eq(qaDevices.id, existing.id)).returning().then((rows) => rows[0]);
      }
      return db.insert(qaDevices).values({ ...values, companyId }).returning().then((rows) => rows[0]);
    },

    registerLocalAndroidEmulators: async (
      companyId: string,
      input?: { workerId?: string | null },
    ): Promise<QaDeviceDiscoveryResult> => {
      const discovery = await discoverLocalAndroidEmulators({
        workerId: input?.workerId ?? undefined,
      });
      const registered = [];
      for (const device of discovery.devices) {
        const existing = await db
          .select()
          .from(qaDevices)
          .where(and(eq(qaDevices.companyId, companyId), eq(qaDevices.workerId, device.workerId), eq(qaDevices.name, device.name)))
          .then((rows) => rows[0] ?? null);
        const values = {
          workerId: device.workerId,
          name: device.name,
          kind: device.kind ?? "android_emulator",
          platform: device.platform ?? "android",
          osVersion: device.osVersion ?? null,
          apiLevel: device.apiLevel ?? null,
          capabilities: device.capabilities ?? {},
          healthStatus: device.healthStatus ?? "unknown",
          lastSeenAt: now(),
          updatedAt: now(),
        };
        const row = existing
          ? await db.update(qaDevices).set(values).where(eq(qaDevices.id, existing.id)).returning().then((rows) => rows[0]!)
          : await db.insert(qaDevices).values({ ...values, companyId }).returning().then((rows) => rows[0]!);
        registered.push(row);
      }
      return { registered: registered as never, diagnostics: discovery.diagnostics };
    },

    listRuns: (companyId: string, filters?: { issueId?: string | null }) => {
      const conditions = [eq(qaTestRuns.companyId, companyId)];
      if (filters?.issueId) conditions.push(eq(qaTestRuns.issueId, filters.issueId));
      return db.select().from(qaTestRuns).where(and(...conditions)).orderBy(desc(qaTestRuns.updatedAt));
    },

    createRun: async (companyId: string, input: QaTestRunCreate, actor: { agentId?: string | null; runId?: string | null }) => {
      const suite = input.suiteId
        ? await db.select().from(qaTestSuites).where(and(eq(qaTestSuites.id, input.suiteId), eq(qaTestSuites.companyId, companyId))).then((rows) => rows[0] ?? null)
        : null;
      if (input.suiteId && !suite) throw notFound("QA suite not found");
      const commandProfile = { ...(suite?.commandProfile ?? {}), ...(input.commandProfile ?? {}) };
      const runnerType = input.runnerType ?? suite?.runnerType ?? "custom_command";
      const parserType = input.parserType ?? suite?.parserType ?? "none";
      const command = buildQaRunnerCommand({ runnerType, commandProfile });
      return db.insert(qaTestRuns).values({
        companyId,
        issueId: input.issueId ?? null,
        projectId: input.projectId ?? suite?.projectId ?? null,
        suiteId: input.suiteId ?? null,
        environmentId: input.environmentId ?? null,
        deviceId: input.deviceId ?? null,
        qaAgentId: input.qaAgentId ?? actor.agentId ?? null,
        requestedByAgentId: actor.agentId ?? null,
        createdByRunId: actor.runId ?? null,
        title: input.title,
        platform: input.platform ?? suite?.platform ?? "api",
        runnerType,
        repo: input.repo ?? null,
        service: input.service ?? suite?.service ?? null,
        pullNumber: input.pullNumber ?? null,
        pullUrl: input.pullUrl ?? null,
        headSha: input.headSha ?? null,
        buildSha: input.buildSha ?? null,
        status: "queued",
        conclusion: "unknown",
        commandProfile,
        parserType,
        metadata: {
          ...(input.metadata ?? {}),
          runnerCommand: command,
          recommendedArtifactTypes: recommendedArtifactTypesForParser(parserType),
        },
      }).returning().then((rows) => rows[0]);
    },

    getRunDetail,
    assertRunCompany,

    updateRun: async (runId: string, input: QaTestRunUpdate) => {
      const [run] = await db.update(qaTestRuns).set(normalizeRunPatch(input)).where(eq(qaTestRuns.id, runId)).returning();
      return run ?? null;
    },

    addResult: async (runId: string, input: QaTestResultCreate) => {
      const run = await getRun(runId);
      if (!run) throw notFound("QA run not found");
      const result = await db.insert(qaTestResults).values({
        companyId: run.companyId,
        runId,
        caseId: input.caseId ?? null,
        title: input.title,
        status: input.status,
        expectedResult: input.expectedResult ?? null,
        actualResult: input.actualResult ?? null,
        failureReason: input.failureReason ?? null,
        durationMs: input.durationMs ?? null,
        metadata: input.metadata ?? null,
      }).returning().then((rows) => rows[0]);
      await refreshRunConclusion(runId);
      return result;
    },

    addResultsFromJUnit: async (runId: string, xml: string) => {
      const run = await getRun(runId);
      if (!run) throw notFound("QA run not found");
      const parsed = parseJUnitXml(xml);
      const results = [];
      for (const result of parsed) {
        results.push(await db.insert(qaTestResults).values({
          companyId: run.companyId,
          runId,
          title: result.title,
          status: result.status,
          failureReason: result.failureReason,
          durationMs: result.durationMs,
          metadata: { source: "junit_xml" },
        }).returning().then((rows) => rows[0]));
      }
      await refreshRunConclusion(runId);
      return results;
    },

    addArtifact: async (runId: string, input: QaArtifactCreate) => {
      const run = await getRun(runId);
      if (!run) throw notFound("QA run not found");
      return db.insert(qaArtifacts).values({
        companyId: run.companyId,
        runId,
        resultId: input.resultId ?? null,
        type: input.type,
        title: input.title,
        url: input.url ?? null,
        storageKey: input.storageKey ?? null,
        contentType: input.contentType ?? null,
        byteSize: input.byteSize ?? null,
        summary: input.summary ?? null,
        metadata: input.metadata ?? null,
      }).returning().then((rows) => rows[0]);
    },

    syncGitHubCi: async (runId: string) => {
      const run = await getRun(runId);
      if (!run) throw notFound("QA run not found");
      if (!run.repo || !run.headSha) throw unprocessable("GitHub CI sync requires repo and headSha");
      const configRow = await integrations.getByProvider(run.companyId, "github");
      if (!configRow || configRow.enabled !== "true") throw notFound("GitHub integration is not configured or is disabled");
      const github = createGitHubClient(configRow.config as unknown as GitHubConfig);
      const checks = await github.listCheckRuns(run.repo, run.headSha);
      const profile = run.commandProfile as Record<string, unknown> | null;
      const pattern = typeof profile?.githubCheckNamePattern === "string" ? profile.githubCheckNamePattern : null;
      const normalized = statusFromGitHubChecks(checks, pattern);
      await db.delete(qaTestResults).where(eq(qaTestResults.runId, runId));
      for (const result of normalized.results) {
        await db.insert(qaTestResults).values({
          companyId: run.companyId,
          runId,
          title: result.title,
          status: result.status,
          failureReason: result.failureReason,
          durationMs: result.durationMs,
          metadata: { source: "github_checks" },
        });
      }
      await db.insert(qaArtifacts).values({
        companyId: run.companyId,
        runId,
        type: "github_check_log",
        title: "GitHub CI checks",
        summary: `${checks.length} check(s) reconciled`,
        metadata: { checks },
      });
      return db.update(qaTestRuns).set({
        status: normalized.status,
        conclusion: normalized.status,
        finishedAt: normalized.status === "blocked" ? null : now(),
        metadata: { ...(run.metadata ?? {}), githubChecks: checks },
        updatedAt: now(),
      }).where(eq(qaTestRuns.id, runId)).returning().then((rows) => rows[0]);
    },

    createFeedbackForRun,
    getFeedback,
    approveFeedbackForDevelopers,

    signoff: async (runId: string, input: { status: "pending" | "approved" | "rejected"; note?: string | null; userId: string | null }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("QA run not found");
      if (input.status === "approved" && run.status !== "passed") {
        throw conflict("Only passed QA runs can receive approved signoff");
      }
      const [updated] = await db.update(qaTestRuns).set({
        signoffStatus: input.status,
        signoffByUserId: input.status === "pending" ? null : input.userId,
        signoffAt: input.status === "pending" ? null : now(),
        metadata: { ...(run.metadata ?? {}), signoffNote: input.note ?? null },
        updatedAt: now(),
      }).where(eq(qaTestRuns.id, runId)).returning();
      return updated;
    },

    exportRun: async (runId: string, input: QaExport) => {
      const detail = await getRunDetail(runId);
      const report = runToReport(detail);
      if (input.format === "csv") {
        return {
          format: "csv" as const,
          filename: `qa-run-${detail.run.id}.csv`,
          contentType: "text/csv",
          content: runToCsv(detail),
        };
      }
      if (input.format === "pdf") {
        return {
          format: "pdf" as const,
          filename: `qa-run-${detail.run.id}.pdf`,
          contentType: "application/pdf",
          content: minimalPdf(report),
        };
      }
      const jiraRow = await integrations.getByProvider(detail.run.companyId, "jira");
      if (!jiraRow || jiraRow.enabled !== "true") throw notFound("Jira integration is not configured or is disabled");
      const jira = createJiraClient(jiraRow.config as unknown as JiraConfig);
      const issue = await jira.createIssue(`QA Report: ${detail.run.title}`, report, input.jiraIssueType ?? "Task");
      return { format: "jira" as const, jiraIssue: issue };
    },

    async listFeedback(companyId: string) {
      return db.select().from(qaFeedbackEvents).where(eq(qaFeedbackEvents.companyId, companyId)).orderBy(desc(qaFeedbackEvents.updatedAt));
    },

    async agentsByRole(companyId: string) {
      return db.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.role, ["qa", "engineer"])));
    },

    async countsForIssue(issueId: string) {
      const rows = await db
        .select({ status: qaTestRuns.status, count: sql<number>`count(*)::int` })
        .from(qaTestRuns)
        .where(eq(qaTestRuns.issueId, issueId))
        .groupBy(qaTestRuns.status);
      return rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = Number(row.count);
        return acc;
      }, {});
    },
  };
}
