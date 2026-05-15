#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_API_URL = process.env.COMBYNE_API_URL ?? "http://127.0.0.1:3100/api";
const DEFAULT_ROOT = path.join("/tmp", `combyne-em-autonomy-audit-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const DEFAULT_BNPL = "/Users/krishsharma/Desktop/Lending_team/fs-bnpl-service";
const DEFAULT_BRICK = "/Users/krishsharma/Desktop/Lending_team/fs-brick-service";

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? fallback;
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: opts.capture ? "pipe" : "inherit",
    cwd: opts.cwd,
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `${command} exited ${result.status}`;
    throw new Error(detail.trim());
  }
  return result.stdout ?? "";
}

function gitHead(source) {
  return run("git", ["-C", source, "rev-parse", "HEAD"], { capture: true }).trim();
}

async function copyCleanRepo(source, target) {
  if (!existsSync(path.join(source, ".git"))) {
    throw new Error(`Source repo is not a git checkout: ${source}`);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  run("bash", ["-lc", `git -C ${shellQuote(source)} archive --format=tar HEAD | tar -xf - -C ${shellQuote(target)}`]);
  return { source, target, head: gitHead(source) };
}

const apiUrl = readArg("api-url", DEFAULT_API_URL).replace(/\/$/, "");
const root = readArg("root", DEFAULT_ROOT);
const sourceBnpl = readArg("bnpl", DEFAULT_BNPL);
const sourceBrick = readArg("brick", DEFAULT_BRICK);
const mode = readArg("mode", "hybrid");
const adapterType = readArg("adapter-type", "process");
const wakeRealAgents = hasFlag("wake-real-agents");
const runQualityChecks = hasFlag("quality-checks");
const watchMs = Math.max(0, Number(readArg("watch-ms", wakeRealAgents ? "120000" : "10000")) || 0);
const boardToken = process.env.COMBYNE_BOARD_TOKEN ?? null;

const processStubAdapterConfig = {
  command: process.execPath,
  args: [
    "-e",
    "console.log('EM autonomy audit stub agent acknowledged wake.');",
  ],
  timeoutSec: 10,
};

function headers(token = null) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : boardToken ? { authorization: `Bearer ${boardToken}` } : {}),
  };
}

async function api(pathname, { method = "GET", body, token } = {}) {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${pathname} -> ${response.status}: ${text}`);
  }
  return json;
}

async function createAgent(companyId, data) {
  const resolvedAdapterType = data.adapterType ?? adapterType;
  const agent = await api(`/companies/${companyId}/agents`, {
    method: "POST",
    body: {
      adapterType: resolvedAdapterType,
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: data.role === "em" ? 4 : 1 } },
      adapterConfig:
        data.adapterConfig ??
        (resolvedAdapterType === "process" ? processStubAdapterConfig : {}),
      ...data,
    },
  });
  const key = await api(`/agents/${agent.id}/keys`, {
    method: "POST",
    body: { name: "em-autonomy-audit" },
  });
  return { ...agent, token: key.token };
}

async function createIssue(companyId, data) {
  return api(`/companies/${companyId}/issues`, { method: "POST", body: data });
}

async function listComments(issueId) {
  return api(`/issues/${issueId}/comments`);
}

async function listRuns(companyId, agentId = null) {
  const suffix = agentId ? `?agentId=${encodeURIComponent(agentId)}&limit=200` : "?limit=200";
  return api(`/companies/${companyId}/heartbeat-runs${suffix}`);
}

function runBelongsToIssue(run, issueId) {
  const ctx = run.contextSnapshot ?? {};
  return run.issueId === issueId || ctx.issueId === issueId || ctx.taskId === issueId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForIssueRunsToSettle(companyId, issueIds, timeoutMs = watchMs) {
  if (timeoutMs <= 0) return { settled: false, timedOut: false, liveRuns: [] };
  const deadline = Date.now() + timeoutMs;
  let lastRelevant = [];
  while (Date.now() < deadline) {
    const runs = await listRuns(companyId);
    lastRelevant = runs.filter((run) => issueIds.some((issueId) => runBelongsToIssue(run, issueId)));
    const liveRuns = lastRelevant.filter((run) => run.status === "queued" || run.status === "running");
    if (lastRelevant.length > 0 && liveRuns.length === 0) {
      return { settled: true, timedOut: false, liveRuns: [] };
    }
    await sleep(Math.min(1000, Math.max(250, timeoutMs / 10)));
  }
  return {
    settled: false,
    timedOut: true,
    liveRuns: lastRelevant.filter((run) => run.status === "queued" || run.status === "running"),
  };
}

async function summarizeIssue(companyId, issueId) {
  const [issue, comments, runs] = await Promise.all([
    api(`/issues/${issueId}`),
    listComments(issueId),
    listRuns(companyId),
  ]);
  const relevantRuns = runs.filter((run) => runBelongsToIssue(run, issueId));
  return {
    issue,
    humanQuestions: comments.filter((comment) => comment.kind === "question"),
    openHumanQuestions: comments.filter((comment) => comment.kind === "question" && !comment.answeredAt),
    managerQuestions: comments.filter((comment) => comment.kind === "manager_question"),
    openManagerQuestions: comments.filter((comment) => comment.kind === "manager_question" && !comment.answeredAt),
    managerAnswers: comments.filter((comment) => comment.kind === "manager_answer"),
    qaComments: comments.filter((comment) => /QA feedback/i.test(comment.body)),
    rawLogLikeComments: comments.filter((comment) => /(?:Exception|stack trace|public\s+class|System\.out\.println|^at\s+\w)/m.test(comment.body)),
    runs: relevantRuns.map((run) => ({
      id: run.id,
      status: run.status,
      agentId: run.agentId,
      wakeReason: run.contextSnapshot?.wakeReason ?? null,
      wakeCommentId: run.contextSnapshot?.wakeCommentId ?? null,
      queueReason: run.queueReason ?? null,
      queueReasonText: run.queueReasonText ?? null,
      sessionIdBefore: run.sessionIdBefore ?? null,
      tokens: tokenSummaryFromRun(run),
    })),
  };
}

function pass(name, ok, detail = "") {
  return { name, status: ok ? "pass" : "fail", detail };
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenSummaryFromRun(run) {
  const usage = run.usageJson && typeof run.usageJson === "object" ? run.usageJson : {};
  const budget = run.promptBudgetJson && typeof run.promptBudgetJson === "object" ? run.promptBudgetJson : {};
  const directTotal =
    readNumber(usage.totalTokens) ??
    readNumber(usage.total_tokens) ??
    readNumber(usage.tokens) ??
    readNumber(budget.totalTokens) ??
    readNumber(budget.estimatedTotalTokens);
  if (directTotal !== null) return String(directTotal);

  const input =
    readNumber(usage.inputTokens) ??
    readNumber(usage.input_tokens) ??
    readNumber(usage.promptTokens) ??
    readNumber(usage.prompt_tokens);
  const output =
    readNumber(usage.outputTokens) ??
    readNumber(usage.output_tokens) ??
    readNumber(usage.completionTokens) ??
    readNumber(usage.completion_tokens);
  if (input !== null || output !== null) return `${input ?? 0}+${output ?? 0}`;
  return null;
}

function collectMetricSummaries(metrics) {
  if (!metrics) return [];
  if (metrics.humanQuestions) return [metrics];
  return Object.values(metrics).filter((value) => value && typeof value === "object" && value.humanQuestions);
}

function aggregateMetricCounts(metrics) {
  const summaries = collectMetricSummaries(metrics);
  return summaries.reduce(
    (acc, summary) => {
      acc.humanQuestions += summary.humanQuestions.length;
      acc.openHumanQuestions += summary.openHumanQuestions.length;
      acc.managerQuestions += summary.managerQuestions.length;
      acc.openManagerQuestions += summary.openManagerQuestions.length;
      acc.managerAnswers += summary.managerAnswers.length;
      acc.runs += summary.runs.length;
      acc.queueReasons.push(...summary.runs.map((run) => run.queueReasonText || run.queueReason).filter(Boolean));
      acc.sessionReuse += summary.runs.filter((run) => run.sessionIdBefore).length;
      acc.tokenSummaries.push(...summary.runs.map((run) => run.tokens).filter(Boolean));
      if (summary.issue?.status) acc.issueStatuses.push(summary.issue.status);
      return acc;
    },
    {
      humanQuestions: 0,
      openHumanQuestions: 0,
      managerQuestions: 0,
      openManagerQuestions: 0,
      managerAnswers: 0,
      runs: 0,
      queueReasons: [],
      sessionReuse: 0,
      tokenSummaries: [],
      issueStatuses: [],
    },
  );
}

function renderRuns(metrics) {
  const runs = collectMetricSummaries(metrics).flatMap((summary) => summary.runs ?? []);
  if (runs.length === 0) return "none";
  return runs
    .map((run) => {
      const parts = [run.status];
      if (run.wakeReason) parts.push(run.wakeReason);
      if (run.queueReason) parts.push(`queue:${run.queueReason}`);
      if (run.sessionIdBefore) parts.push("reused-session");
      if (run.tokens) parts.push(`tokens:${run.tokens}`);
      return parts.join("/");
    })
    .join(", ");
}

async function scenarioAnswerableAmbiguity(ctx) {
  const parent = await createIssue(ctx.company.id, {
    projectId: ctx.bnplProject.id,
    title: "S audit: BNPL validation defaulting",
    description: `Implement defensive defaulting in ${ctx.bnplCopy.target}.`,
    status: "backlog",
    priority: "medium",
    assigneeAgentId: ctx.em.id,
  });
  const child = await createIssue(ctx.company.id, {
    projectId: ctx.bnplProject.id,
    parentId: parent.id,
    title: "S audit child: default missing spouse income",
    description: "If spouse income is missing during BNPL validation, decide a safe default and add a regression test.",
    status: "backlog",
    priority: "medium",
    assigneeAgentId: ctx.bnplDev.id,
  });
  const ask = await api(`/issues/${child.id}/ask-user`, {
    method: "POST",
    token: ctx.bnplDev.token,
    body: { question: "Should missing spouse income default to zero or block validation?" },
  });
  const answer = await api(`/issues/${child.id}/internal-questions/${ask.routedCommentId}/answer`, {
    method: "POST",
    token: ctx.em.token,
    body: {
      answer: "Use zero as the defensive default for missing spouse income and cover it with a regression test.",
      assumption: true,
    },
  });
  await waitForIssueRunsToSettle(ctx.company.id, [child.id]);
  const summary = await summarizeIssue(ctx.company.id, child.id);
  return {
    key: "S answerable ambiguity",
    issueId: child.id,
    checks: [
      pass("sub-agent routed to EM", ask.routedToManager === true && ask.routedToAgentId === ctx.em.id),
      pass("no user-facing question", summary.humanQuestions.length === 0),
      pass("manager question answered", summary.managerQuestions.length === 1 && summary.managerAnswers.length === 1),
      pass("child resumed in progress", answer.issue.status === "in_progress"),
      pass("wake has answer context", summary.runs.some((run) => run.wakeReason === "manager_question_answered" && run.wakeCommentId)),
    ],
    metrics: summary,
  };
}

async function scenarioQaFeedback(ctx) {
  const issue = await createIssue(ctx.company.id, {
    projectId: ctx.brickProject.id,
    title: "S audit: Brick token filter regression",
    description: `Fix a small token filter regression in ${ctx.brickCopy.target}.`,
    status: "backlog",
    priority: "medium",
    assigneeAgentId: ctx.brickDev.id,
  });
  const run = await api(`/companies/${ctx.company.id}/qa/runs`, {
    method: "POST",
    token: ctx.qa.token,
    body: {
      issueId: issue.id,
      projectId: ctx.brickProject.id,
      qaAgentId: ctx.qa.id,
      title: "QA validation: Brick token filter",
      platform: "api",
      runnerType: "rest_assured",
      service: "fs-brick-service",
      commandProfile: { command: "./gradlew test --tests '*PanaceaTokenFilterTest'", cwd: ctx.brickCopy.target },
    },
  });
  await api(`/qa/runs/${run.id}/results`, {
    method: "POST",
    token: ctx.qa.token,
    body: {
      title: "Rejects missing Panacea token with structured 401",
      status: "failed",
      expectedResult: "Missing token returns 401 with the standard error body.",
      actualResult: "Missing token bypassed the expected error body.",
      failureReason: "Filter does not map missing token to the standard Unauthorized response.",
    },
  });
  const feedback = await api(`/qa/runs/${run.id}/feedback/send`, {
    method: "POST",
    token: ctx.qa.token,
    body: {
      toAgentId: ctx.brickDev.id,
      title: "QA feedback: Brick token filter",
      severity: "high",
      body: "The missing-token path should return the standard 401 error body. Please update the filter and regression test.",
      requiresApproval: false,
    },
  });
  await waitForIssueRunsToSettle(ctx.company.id, [issue.id]);
  const summary = await summarizeIssue(ctx.company.id, issue.id);
  return {
    key: "S QA feedback loop",
    issueId: issue.id,
    checks: [
      pass("feedback auto-sent to developer", feedback.status === "sent_to_dev"),
      pass("structured QA comment present", summary.qaComments.length > 0 && /Failures and Blockers|Requested action|QA feedback/i.test(summary.qaComments[0].body)),
      pass("no raw log/code dump", summary.rawLogLikeComments.length === 0),
      pass("developer wake includes QA feedback", summary.runs.some((run) => run.wakeReason === "qa_feedback" && run.wakeCommentId)),
    ],
    metrics: summary,
  };
}

async function scenarioParallelTwoRepo(ctx) {
  const parent = await createIssue(ctx.company.id, {
    title: "M audit: parallel BNPL and Brick validation updates",
    description: "Coordinate independent BNPL and Brick changes, then verify both before closure.",
    status: "backlog",
    priority: "high",
    assigneeAgentId: ctx.em.id,
  });
  const bnpl = await createIssue(ctx.company.id, {
    projectId: ctx.bnplProject.id,
    parentId: parent.id,
    title: "M audit child: BNPL validation update",
    description: `Make the BNPL-side change in ${ctx.bnplCopy.target}.`,
    status: "backlog",
    priority: "high",
    assigneeAgentId: ctx.bnplDev.id,
  });
  const brick = await createIssue(ctx.company.id, {
    projectId: ctx.brickProject.id,
    parentId: parent.id,
    title: "M audit child: Brick validation update",
    description: `Make the Brick-side change in ${ctx.brickCopy.target}.`,
    status: "backlog",
    priority: "high",
    assigneeAgentId: ctx.brickDev.id,
  });
  const bnplWake = await api(`/agents/${ctx.bnplDev.id}/wakeup`, {
    method: "POST",
    body: { source: "automation", triggerDetail: "system", reason: "audit_parallel_bnpl", payload: { issueId: bnpl.id } },
  });
  const brickWake = await api(`/agents/${ctx.brickDev.id}/wakeup`, {
    method: "POST",
    body: { source: "automation", triggerDetail: "system", reason: "audit_parallel_brick", payload: { issueId: brick.id } },
  });
  await waitForIssueRunsToSettle(ctx.company.id, [bnpl.id, brick.id]);
  const [bnplSummary, brickSummary] = await Promise.all([
    summarizeIssue(ctx.company.id, bnpl.id),
    summarizeIssue(ctx.company.id, brick.id),
  ]);
  return {
    key: "M parallel two-repo work",
    issueId: parent.id,
    checks: [
      pass("BNPL child wake queued or started", ["queued", "running"].includes(bnplWake.status)),
      pass("Brick child wake queued or started", ["queued", "running"].includes(brickWake.status)),
      pass("queue reasons are visible", [...bnplSummary.runs, ...brickSummary.runs].every((run) => run.status !== "queued" || run.queueReasonText)),
      pass("independent child issue scopes", bnpl.id !== brick.id && bnpl.assigneeAgentId !== brick.assigneeAgentId),
    ],
    metrics: { bnpl: bnplSummary, brick: brickSummary },
  };
}

async function scenarioReviewFeedback(ctx) {
  const parent = await createIssue(ctx.company.id, {
    projectId: ctx.bnplProject.id,
    title: "M/L audit: review feedback rework",
    description: "Review a broader BNPL change and make sure review feedback wakes the EM without user nudges.",
    status: "backlog",
    priority: "high",
    assigneeAgentId: ctx.em.id,
  });
  const review = await createIssue(ctx.company.id, {
    projectId: ctx.bnplProject.id,
    parentId: parent.id,
    title: "M/L audit child: reviewer feedback",
    description: "Review the BNPL validation diff and report actionable changes.",
    status: "backlog",
    priority: "high",
    assigneeAgentId: ctx.reviewer.id,
  });
  await api(`/issues/${review.id}`, {
    method: "PATCH",
    body: {
      status: "done",
      comment: "Review completed. Feedback: add a regression test for null spouse income and ensure validation errors keep the existing error code contract. Next step: assign the implementation engineer to patch tests and error mapping.",
    },
  });
  await waitForIssueRunsToSettle(ctx.company.id, [parent.id]);
  const parentSummary = await summarizeIssue(ctx.company.id, parent.id);
  const parentComments = await listComments(parent.id);
  return {
    key: "M/L review feedback and rework",
    issueId: parent.id,
    checks: [
      pass("parent received child handoff", parentComments.some((comment) => /Recommended next action|Handoff digest/i.test(comment.body))),
      pass("EM wake from child completion exists", parentSummary.runs.some((run) => run.wakeReason === "child_issue_done" && run.wakeCommentId)),
      pass("handoff includes recommended action", parentComments.some((comment) => /Recommended next action|assign or fix/i.test(comment.body))),
      pass("no user-facing question", parentSummary.humanQuestions.length === 0),
    ],
    metrics: parentSummary,
  };
}

async function scenarioHardBlocker(ctx) {
  const issue = await createIssue(ctx.company.id, {
    title: "Negative control: unavailable production credential",
    description: "Requires a missing production Veefin credential that is not present in repo, memory, or company secrets.",
    status: "backlog",
    priority: "critical",
    assigneeAgentId: ctx.em.id,
  });
  const ask = await api(`/issues/${issue.id}/ask-user`, {
    method: "POST",
    token: ctx.em.token,
    body: {
      question: "Please provide the production Veefin credential or confirm that this task must remain blocked.",
      escalationCategory: "credentials_access",
    },
  });
  const summary = await summarizeIssue(ctx.company.id, issue.id);
  return {
    key: "Negative hard blocker",
    issueId: issue.id,
    checks: [
      pass("coordinator escalated to user", ask.routedToManager === false && ask.issue.status === "awaiting_user"),
      pass("exactly one user-facing question", summary.humanQuestions.length === 1 && summary.openHumanQuestions.length === 1),
      pass("no internal manager question", summary.managerQuestions.length === 0),
    ],
    metrics: summary,
  };
}

async function qualityCheck(copy) {
  if (!runQualityChecks) {
    return { repo: copy.target, status: "not_run", detail: "Pass --quality-checks to run Gradle task discovery." };
  }
  try {
    const output = run("./gradlew", ["tasks", "--all", "--no-daemon"], { cwd: copy.target, capture: true });
    return { repo: copy.target, status: "pass", detail: output.slice(0, 1000) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const javaVersion = (() => {
      try {
        return run("java", ["-version"], { capture: true }).trim();
      } catch (javaErr) {
        return javaErr instanceof Error ? javaErr.message : String(javaErr);
      }
    })();
    if (/Unsupported class file major version/i.test(detail)) {
      return {
        repo: copy.target,
        status: "env_blocked",
        detail: [
          "Gradle/JDK toolchain mismatch: Gradle could not compile settings.gradle because the installed Java runtime emits an unsupported class file major version.",
          javaVersion,
          detail,
        ].filter(Boolean).join("\n"),
      };
    }
    return { repo: copy.target, status: "fail", detail };
  }
}

function renderReport(context, scenarios, quality) {
  const lines = [
    "# EM Autonomy Scenario Audit",
    "",
    `- API: ${apiUrl}`,
    `- Mode: ${mode}`,
    `- Company: ${context.company.name} (${context.company.id})`,
    `- Root: ${root}`,
    `- BNPL copy: ${context.bnplCopy.target} @ ${context.bnplCopy.head}`,
    `- Brick copy: ${context.brickCopy.target} @ ${context.brickCopy.head}`,
    `- Real agent wakes requested: ${wakeRealAgents ? "yes" : "no"}`,
    `- Watch cap per scenario: ${watchMs} ms`,
    "",
    "## Scenario Results",
  ];
  for (const scenario of scenarios) {
    const failed = scenario.checks.filter((check) => check.status !== "pass");
    lines.push("", `### ${scenario.key}`, "", `- Issue: ${scenario.issueId}`, `- Status: ${failed.length === 0 ? "PASS" : "FAIL"}`);
    for (const check of scenario.checks) {
      lines.push(`- [${check.status === "pass" ? "x" : " "}] ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    const summaries = collectMetricSummaries(scenario.metrics);
    if (summaries.length > 0) {
      const counts = aggregateMetricCounts(scenario.metrics);
      const statuses = [...new Set(counts.issueStatuses)].join(", ") || "unknown";
      const queueReasons = [...new Set(counts.queueReasons)].join("; ") || "none";
      lines.push(`- Final issue status: ${statuses}`);
      lines.push(`- Human questions: ${counts.humanQuestions} (${counts.openHumanQuestions} open)`);
      lines.push(`- Internal questions: ${counts.managerQuestions} (${counts.openManagerQuestions} open)`);
      lines.push(`- EM answers: ${counts.managerAnswers}`);
      lines.push(`- Runs: ${counts.runs} (${renderRuns(scenario.metrics)})`);
      lines.push(`- Queue reasons: ${queueReasons}`);
      lines.push(`- Session reuse: ${counts.sessionReuse > 0 ? `${counts.sessionReuse} run(s)` : "none observed"}`);
      lines.push(`- Token metadata: ${counts.tokenSummaries.length > 0 ? counts.tokenSummaries.join(", ") : "not reported by adapter"}`);
    }
  }
  lines.push("", "## Workspace Quality Checks");
  for (const item of quality) {
    lines.push(`- ${item.status.toUpperCase()}: ${item.repo} — ${item.detail.split("\n")[0]}`);
  }
  return lines.join("\n");
}

async function main() {
  await mkdir(root, { recursive: true });
  const bnplCopy = await copyCleanRepo(sourceBnpl, path.join(root, "fs-bnpl-service"));
  const brickCopy = await copyCleanRepo(sourceBrick, path.join(root, "fs-brick-service"));

  const company = await api("/companies", {
    method: "POST",
    body: {
      name: `EM autonomy audit ${new Date().toISOString()}`,
      description: "Isolated company for EM autonomy, internal-question routing, queue, QA, and review feedback audit.",
    },
  });
  const em = await createAgent(company.id, {
    name: "Audit EM",
    role: "em",
    permissions: { canAssignTasks: true, taskAssignmentScope: "company", canCreateAgents: true },
    capabilities: "Coordinates Buku-style engineering work and answers small-task ambiguity from context.",
  });
  const bnplDev = await createAgent(company.id, {
    name: "Audit BNPL Engineer",
    role: "engineer",
    reportsTo: em.id,
    capabilities: "Implements fs-bnpl-service Java/Spring changes.",
  });
  const brickDev = await createAgent(company.id, {
    name: "Audit Brick Engineer",
    role: "engineer",
    reportsTo: em.id,
    capabilities: "Implements fs-brick-service Java/Spring changes.",
  });
  const qa = await createAgent(company.id, {
    name: "Audit QA",
    role: "qa",
    reportsTo: em.id,
    capabilities: "Runs API and regression QA and sends structured feedback.",
  });
  const reviewer = await createAgent(company.id, {
    name: "Audit Reviewer",
    role: "engineer",
    reportsTo: em.id,
    capabilities: "Reviews Buku Java diffs and posts actionable review handoffs.",
  });
  const bnplProject = await api(`/companies/${company.id}/projects`, {
    method: "POST",
    body: {
      name: "fs-bnpl-service audit copy",
      description: "Clean copied workspace for BNPL autonomy audit.",
      leadAgentId: em.id,
      workspace: { name: "BNPL audit copy", sourceType: "local_path", cwd: bnplCopy.target, isPrimary: true },
    },
  });
  const brickProject = await api(`/companies/${company.id}/projects`, {
    method: "POST",
    body: {
      name: "fs-brick-service audit copy",
      description: "Clean copied workspace for Brick autonomy audit.",
      leadAgentId: em.id,
      workspace: { name: "Brick audit copy", sourceType: "local_path", cwd: brickCopy.target, isPrimary: true },
    },
  });

  const context = { company, em, bnplDev, brickDev, qa, reviewer, bnplProject, brickProject, bnplCopy, brickCopy };
  const scenarios = [];
  for (const scenario of [
    scenarioAnswerableAmbiguity,
    scenarioQaFeedback,
    scenarioParallelTwoRepo,
    scenarioReviewFeedback,
    scenarioHardBlocker,
  ]) {
    scenarios.push(await scenario(context));
  }
  const quality = await Promise.all([qualityCheck(bnplCopy), qualityCheck(brickCopy)]);
  const report = renderReport(context, scenarios, quality);
  const json = { context, scenarios, quality, reportPath: path.join(root, "em-autonomy-audit-report.md") };
  await writeFile(path.join(root, "em-autonomy-audit-report.md"), report);
  await writeFile(path.join(root, "em-autonomy-audit-report.json"), JSON.stringify(json, null, 2));
  console.log(report);
  console.log(`\nWrote ${path.join(root, "em-autonomy-audit-report.md")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
