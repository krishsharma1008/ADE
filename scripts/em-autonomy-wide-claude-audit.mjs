#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const apiUrl = readArg("api-url", process.env.COMBYNE_API_URL ?? "http://127.0.0.1:3100/api").replace(/\/$/, "");
const root = readArg("root", path.join("/tmp", `combyne-em-autonomy-wide-claude-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const sourceBnpl = readArg("bnpl", "/Users/krishsharma/Desktop/Lending_team/fs-bnpl-service");
const sourceBrick = readArg("brick", "/Users/krishsharma/Desktop/Lending_team/fs-brick-service");
const watchMs = Math.max(30_000, Number(readArg("watch-ms", "300000")) || 300_000);
const initialSampleMs = Math.max(5_000, Number(readArg("initial-sample-ms", "20000")) || 20_000);
const maxTurns = Math.max(1, Number(readArg("max-turns", "60")) || 60);
const timeoutSec = Math.max(60, Number(readArg("agent-timeout-sec", "600")) || 600);
const archiveExisting = hasFlag("archive-existing");

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

async function copyCleanGitRepo(source, target) {
  if (!existsSync(path.join(source, ".git"))) throw new Error(`Source repo is not a git checkout: ${source}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  run("git", ["clone", "--quiet", "--no-hardlinks", source, target]);
  const head = gitHead(source);
  run("git", ["-C", target, "checkout", "--quiet", head]);
  run("git", ["-C", target, "clean", "-fdx"]);
  return { source, target, head };
}

function headers(token = null) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${text}`);
  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function claudeConfig(promptTemplate) {
  return {
    dangerouslySkipPermissions: true,
    maxTurnsPerRun: maxTurns,
    timeoutSec,
    effort: "low",
    promptTemplate,
  };
}

async function createAgent(companyId, data) {
  return api(`/companies/${companyId}/agents`, {
    method: "POST",
    body: {
      adapterType: "claude_local",
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: data.role === "em" ? 4 : 2 } },
      ...data,
    },
  });
}

async function createIssue(companyId, data) {
  return api(`/companies/${companyId}/issues`, { method: "POST", body: data });
}

async function listIssues(companyId) {
  return api(`/companies/${companyId}/issues`);
}

async function listComments(issueId) {
  return api(`/issues/${issueId}/comments`);
}

async function listRuns(companyId) {
  return api(`/companies/${companyId}/heartbeat-runs?limit=1000`);
}

async function wake(agentId, issueId, reason) {
  return api(`/agents/${agentId}/wakeup`, {
    method: "POST",
    body: {
      source: "automation",
      triggerDetail: "system",
      reason,
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, taskKey: issueId, wakeReason: reason, source: "wide_claude_audit" },
    },
  });
}

function runBelongsToIssue(run, issueIds) {
  const ctx = run.contextSnapshot ?? {};
  return issueIds.has(run.issueId) || issueIds.has(ctx.issueId) || issueIds.has(ctx.taskId);
}

function descendantsFor(issueId, allIssues) {
  const byParent = new Map();
  for (const issue of allIssues) {
    if (!issue.parentId) continue;
    const list = byParent.get(issue.parentId) ?? [];
    list.push(issue);
    byParent.set(issue.parentId, list);
  }
  const out = [];
  const stack = [...(byParent.get(issueId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    out.push(next);
    stack.push(...(byParent.get(next.id) ?? []));
  }
  return out;
}

async function summarizeTask(companyId, task) {
  const allIssues = await listIssues(companyId);
  const issueIds = new Set([task.issue.id, ...descendantsFor(task.issue.id, allIssues).map((issue) => issue.id)]);
  const comments = (await Promise.all([...issueIds].map((id) => listComments(id)))).flat();
  const runs = (await listRuns(companyId)).filter((run) => runBelongsToIssue(run, issueIds));
  const topIssue = allIssues.find((issue) => issue.id === task.issue.id) ?? task.issue;
  return {
    key: task.key,
    size: task.size,
    issueId: task.issue.id,
    identifier: topIssue.identifier,
    title: task.issue.title,
    finalStatus: topIssue.status,
    issueCount: issueIds.size,
    humanQuestions: comments.filter((comment) => comment.kind === "question"),
    openHumanQuestions: comments.filter((comment) => comment.kind === "question" && !comment.answeredAt),
    internalQuestions: comments.filter((comment) => comment.kind === "manager_question"),
    internalAnswers: comments.filter((comment) => comment.kind === "manager_answer"),
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      agentId: run.agentId,
      wakeReason: run.contextSnapshot?.wakeReason ?? null,
      queueReason: run.queueReason ?? null,
      queueReasonText: run.queueReasonText ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error ?? null,
    })),
  };
}

async function waitForRuns(companyId, issueIds, timeoutMs) {
  const idSet = new Set(issueIds);
  const deadline = Date.now() + timeoutMs;
  let relevant = [];
  while (Date.now() < deadline) {
    relevant = (await listRuns(companyId)).filter((run) => runBelongsToIssue(run, idSet));
    const live = relevant.filter((run) => run.status === "queued" || run.status === "running");
    if (relevant.length >= issueIds.length && live.length === 0) break;
    await sleep(5_000);
  }
  return relevant;
}

function repoStatus(copy) {
  const status = run("git", ["-C", copy.target, "status", "--short"], { capture: true }).trim();
  const stat = run("git", ["-C", copy.target, "diff", "--stat"], { capture: true }).trim();
  return { repo: copy.target, status: status || "(clean)", diffStat: stat || "(no diff)" };
}

function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    reportsTo: agent.reportsTo ?? null,
    adapterType: agent.adapterType,
  };
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    leadAgentId: project.leadAgentId ?? null,
  };
}

function publicTask(task) {
  return {
    key: task.key,
    size: task.size,
    title: task.title,
    issue: {
      id: task.issue.id,
      identifier: task.issue.identifier,
      title: task.issue.title,
      status: task.issue.status,
    },
  };
}

function publicRun(run) {
  return {
    id: run.id,
    status: run.status,
    agentId: run.agentId,
    issueId: run.issueId ?? null,
    queueReason: run.queueReason ?? null,
    queueReasonText: run.queueReasonText ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    contextIssueId: run.contextSnapshot?.issueId ?? null,
    contextWakeReason: run.contextSnapshot?.wakeReason ?? null,
  };
}

function qualityCheck(copy) {
  try {
    const output = run("./gradlew", ["tasks", "--all", "--no-daemon"], { cwd: copy.target, capture: true });
    return { repo: copy.target, status: "pass", detail: output.slice(0, 1000) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/Unsupported class file major version/i.test(detail)) {
      return {
        repo: copy.target,
        status: "env_blocked",
        detail: "Gradle/JDK toolchain mismatch: Gradle could not compile settings.gradle because the installed Java runtime emits an unsupported class file major version.",
      };
    }
    return { repo: copy.target, status: "fail", detail };
  }
}

async function archiveExistingAuditCompanies() {
  const companies = await api("/companies");
  const candidates = companies.filter((company) =>
    String(company.name).startsWith("EM autonomy audit") ||
    String(company.name).startsWith("EM wide Claude audit")
  );
  for (const company of candidates) {
    if (company.status === "archived") continue;
    await api(`/companies/${company.id}/archive`, { method: "POST" });
  }
  return candidates.length;
}

function taskDefinitions(ctx) {
  const bnpl = ctx.bnplCopy.target;
  const brick = ctx.brickCopy.target;
  return [
    {
      key: "S1",
      size: "S",
      projectId: ctx.bnplProject.id,
      title: "S1 BNPL null-safe spouse-income default",
      description: `Small autonomous ticket. In the copied BNPL repo at ${bnpl}, inspect only the DTO/model path around src/main/java/com/bukuwarung/fsbnplservice/model/Demographic.java and nearby tests. Make the smallest reasonable null-safe default/guard for missing spouse income or equivalent spouse demographic ambiguity. If the exact product choice is unclear, assume missing optional spouse-income style fields default to zero/not-present and continue. Human question budget: 0. Delegate to BNPL engineer if useful, then verify and close or summarize blocker.`,
    },
    {
      key: "S2",
      size: "S",
      projectId: ctx.brickProject.id,
      title: "S2 Brick missing-token message mapping",
      description: `Small autonomous ticket. In the copied Brick repo at ${brick}, inspect src/main/java/com/bukuwarung/fsbrickservice/util/BrickErrorMapping.java. Add or verify a readable mapping for a missing/blank token style error using the existing login/authorization fallback. If wording is ambiguous, use the existing Unauthorized style message. Human question budget: 0. Keep changes tiny and add/update a nearby lightweight test only if one already exists.`,
    },
    {
      key: "S3",
      size: "S",
      projectId: ctx.bnplProject.id,
      title: "S3 BNPL bank-validation boolean default",
      description: `Small autonomous ticket. In ${bnpl}, inspect src/main/java/com/bukuwarung/fsbnplservice/dto/BankValidationRequestDto.java and usages. Make the smallest safe handling improvement so missing is_payment_in is treated as false/defensive default where consumed, or document no code change if already safe. If ambiguous, assume false. Human question budget: 0.`,
    },
    {
      key: "S4",
      size: "S",
      projectId: ctx.brickProject.id,
      title: "S4 Brick request-status constant cleanup",
      description: `Small autonomous ticket. In ${brick}, inspect src/main/java/com/bukuwarung/fsbrickservice/constants/RequestStatusCodeConstants.java and usages. Add a missing common failure constant only if the code already uses that status pattern, otherwise leave a short implementation comment. If ambiguous, do not ask the user; choose the least invasive constant-only change. Human question budget: 0.`,
    },
    {
      key: "M1",
      size: "M",
      projectId: ctx.bnplProject.id,
      title: "M1 Cross-repo nullable validation consistency",
      description: `Medium coordination ticket. Coordinate one BNPL child and one Brick child in parallel across ${bnpl} and ${brick}. Goal: align nullable validation defaults for low-risk optional request fields and add a brief note/test where appropriate. The EM should parallelize across BNPL and Brick engineers, then verify both. Human question budget: at most 1, only if a true product behavior cannot be inferred from code or existing docs.`,
    },
    {
      key: "M2",
      size: "M",
      projectId: ctx.brickProject.id,
      title: "M2 Brick QA-style regression follow-up",
      description: `Medium ticket. Treat this as a QA feedback loop for ${brick}: a missing authorization/token path should produce the standard user-safe error body. Coordinate dev and QA/reviewer as needed. Human question budget: at most 1, only if the expected external contract is absent from code/tests/docs.`,
    },
    {
      key: "M3",
      size: "M",
      projectId: ctx.bnplProject.id,
      title: "M3 BNPL review-driven regression coverage",
      description: `Medium ticket. Simulate a reviewer asking for regression coverage around BNPL optional demographic defaults in ${bnpl}. The EM should assign or perform the work, review output, and avoid asking the user unless the code/doc context cannot establish expected behavior. Human question budget: at most 2.`,
    },
  ];
}

function renderReport(ctx, tasks, wakeResponses, initialRuns, finalSummaries, repoStatuses, quality) {
  const firstWaveIds = new Set(tasks.slice(0, 4).map((task) => task.issue.id));
  const firstWaveRuns = initialRuns.filter((run) => firstWaveIds.has(run.contextSnapshot?.issueId));
  const firstWaveRunning = firstWaveRuns.filter((run) => run.status === "running").length;
  const firstWaveQueued = firstWaveRuns.filter((run) => run.status === "queued").length;
  const lines = [
    "# Wide Claude EM Autonomy Audit",
    "",
    `- API: ${apiUrl}`,
    `- Company: ${ctx.company.name} (${ctx.company.id})`,
    `- Root: ${root}`,
    `- Adapter: claude_local`,
    `- EM max concurrent runs: 4`,
    `- First-wave sample after: ${initialSampleMs} ms`,
    `- Watch cap: ${watchMs} ms`,
    `- BNPL copy: ${ctx.bnplCopy.target} @ ${ctx.bnplCopy.head}`,
    `- Brick copy: ${ctx.brickCopy.target} @ ${ctx.brickCopy.head}`,
    "",
    "## EM Parallelization",
    "",
    `- First wave tickets: ${tasks.slice(0, 4).map((task) => task.issue.identifier).join(", ")}`,
    `- First wave running: ${firstWaveRunning}`,
    `- First wave queued: ${firstWaveQueued}`,
    `- Wake responses: ${wakeResponses.map((wake) => `${wake.issueKey}:${wake.status}`).join(", ")}`,
  ];
  for (const run of firstWaveRuns) {
    lines.push(`- Run ${run.id.slice(0, 8)} ${run.status}${run.queueReason ? ` (${run.queueReasonText || run.queueReason})` : ""}`);
  }

  lines.push("", "## Question And Execution Budgets");
  for (const summary of finalSummaries) {
    const humanBudget = summary.size === "S" ? 0 : summary.key === "M3" ? 2 : 1;
    const humanCount = summary.humanQuestions.length;
    const failedBudget = humanCount > humanBudget;
    const runStates = summary.runs.map((run) => `${run.status}${run.queueReason ? `/${run.queueReason}` : ""}${run.error ? `/error:${run.error.slice(0, 80)}` : ""}`).join(", ") || "none";
    lines.push(
      "",
      `### ${summary.key}: ${summary.title}`,
      "",
      `- Size: ${summary.size}`,
      `- Issue: ${summary.identifier ?? summary.issueId}`,
      `- Final status: ${summary.finalStatus}`,
      `- Issue tree size: ${summary.issueCount}`,
      `- Human questions: ${humanCount}/${humanBudget}${failedBudget ? " OVER BUDGET" : ""} (${summary.openHumanQuestions.length} open)`,
      `- Internal questions: ${summary.internalQuestions.length}`,
      `- Internal answers: ${summary.internalAnswers.length}`,
      `- Runs: ${summary.runs.length} (${runStates})`,
    );
  }

  lines.push("", "## Copied Repo Diffs");
  for (const status of repoStatuses) {
    lines.push("", `### ${status.repo}`, "", "```text", status.status, "", status.diffStat, "```");
  }

  lines.push("", "## Workspace Quality Checks");
  for (const item of quality) {
    lines.push(`- ${item.status.toUpperCase()}: ${item.repo} — ${item.detail.split("\n")[0]}`);
  }

  return lines.join("\n");
}

async function main() {
  await mkdir(root, { recursive: true });
  if (archiveExisting) {
    const count = await archiveExistingAuditCompanies();
    console.log(`Archived/checked ${count} previous audit companies.`);
  }
  const bnplCopy = await copyCleanGitRepo(sourceBnpl, path.join(root, "fs-bnpl-service"));
  const brickCopy = await copyCleanGitRepo(sourceBrick, path.join(root, "fs-brick-service"));
  const company = await api("/companies", {
    method: "POST",
    body: {
      name: `EM wide Claude audit ${new Date().toISOString()}`,
      description: "Wide live Claude audit for EM parallelization, S/M question budgets, and delegated execution.",
    },
  });

  const emPrompt = [
    "You are the Audit EM. Work only on the focused issue from Combyne context.",
    "For S tickets, do not ask the human. Answer ambiguity from repo context or make a documented reasonable assumption.",
    "For M tickets, ask at most one or two human questions only for true product decisions not inferable from context.",
    "Parallelize independent child work across BNPL, Brick, QA, and reviewer agents. Verify child completion before final closure.",
    "Keep each run concise: inspect only named files or nearby tests unless the issue explicitly says broader.",
  ].join("\n");
  const devPrompt = [
    "You are a focused implementation agent. Work only on the focused issue.",
    "For small ambiguity, assume the default stated in the issue and continue. Route uncertainty internally to EM; do not ask the human.",
    "Keep edits scoped to named files or immediate tests.",
  ].join("\n");
  const em = await createAgent(company.id, {
    name: "Wide Audit EM",
    role: "em",
    permissions: { canAssignTasks: true, taskAssignmentScope: "company", canCreateAgents: true },
    adapterConfig: claudeConfig(emPrompt),
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 4 } },
    capabilities: "Coordinates several S/M Buku engineering tickets in parallel and answers ambiguity from context.",
  });
  const bnplDev = await createAgent(company.id, {
    name: "Wide Audit BNPL Engineer",
    role: "engineer",
    reportsTo: em.id,
    adapterConfig: claudeConfig(devPrompt),
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 2 } },
    capabilities: "Implements focused fs-bnpl-service Java/Spring changes.",
  });
  const brickDev = await createAgent(company.id, {
    name: "Wide Audit Brick Engineer",
    role: "engineer",
    reportsTo: em.id,
    adapterConfig: claudeConfig(devPrompt),
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 2 } },
    capabilities: "Implements focused fs-brick-service Java/Spring changes.",
  });
  const qa = await createAgent(company.id, {
    name: "Wide Audit QA",
    role: "qa",
    reportsTo: em.id,
    adapterConfig: claudeConfig("You are QA. Produce structured Markdown feedback with summary, failures, evidence, expected/actual, and requested action. Never dump raw logs."),
    capabilities: "Runs focused QA and reports actionable feedback.",
  });
  const reviewer = await createAgent(company.id, {
    name: "Wide Audit Reviewer",
    role: "engineer",
    reportsTo: em.id,
    adapterConfig: claudeConfig("You are reviewer. Review focused diffs and post concise actionable review feedback. Do not ask the human."),
    capabilities: "Reviews focused Buku Java diffs.",
  });

  const bnplProject = await api(`/companies/${company.id}/projects`, {
    method: "POST",
    body: {
      name: "wide fs-bnpl-service copy",
      leadAgentId: em.id,
      workspace: { name: "BNPL wide audit copy", sourceType: "local_path", cwd: bnplCopy.target, isPrimary: true },
    },
  });
  const brickProject = await api(`/companies/${company.id}/projects`, {
    method: "POST",
    body: {
      name: "wide fs-brick-service copy",
      leadAgentId: em.id,
      workspace: { name: "Brick wide audit copy", sourceType: "local_path", cwd: brickCopy.target, isPrimary: true },
    },
  });

  const ctx = { company, em, bnplDev, brickDev, qa, reviewer, bnplProject, brickProject, bnplCopy, brickCopy };
  const tasks = [];
  for (const spec of taskDefinitions(ctx)) {
    const issue = await createIssue(company.id, {
      projectId: spec.projectId,
      title: spec.title,
      description: spec.description,
      status: "backlog",
      priority: spec.size === "S" ? "medium" : "high",
      assigneeAgentId: em.id,
    });
    tasks.push({ ...spec, issue });
  }

  const wakeResponses = [];
  for (const task of tasks.slice(0, 4)) {
    const response = await wake(em.id, task.issue.id, `wide_audit_${task.key.toLowerCase()}`);
    wakeResponses.push({ issueKey: task.key, status: response.status, runId: response.runId ?? response.id ?? null });
  }
  await sleep(initialSampleMs);
  const initialRuns = await listRuns(company.id);

  for (const task of tasks.slice(4)) {
    const response = await wake(em.id, task.issue.id, `wide_audit_${task.key.toLowerCase()}`);
    wakeResponses.push({ issueKey: task.key, status: response.status, runId: response.runId ?? response.id ?? null });
  }

  await waitForRuns(company.id, tasks.map((task) => task.issue.id), watchMs);
  const finalSummaries = [];
  for (const task of tasks) finalSummaries.push(await summarizeTask(company.id, task));
  const repoStatuses = [repoStatus(bnplCopy), repoStatus(brickCopy)];
  const quality = [qualityCheck(bnplCopy), qualityCheck(brickCopy)];
  const report = renderReport(ctx, tasks, wakeResponses, initialRuns, finalSummaries, repoStatuses, quality);
  const json = {
    company: ctx.company,
    agents: [ctx.em, ctx.bnplDev, ctx.brickDev, ctx.qa, ctx.reviewer].map(publicAgent),
    projects: [ctx.bnplProject, ctx.brickProject].map(publicProject),
    repoCopies: {
      bnpl: ctx.bnplCopy,
      brick: ctx.brickCopy,
    },
    tasks: tasks.map(publicTask),
    wakeResponses,
    initialRuns: initialRuns.map(publicRun),
    finalSummaries,
    repoStatuses,
    quality,
  };
  await writeFile(path.join(root, "wide-claude-audit-report.md"), report);
  await writeFile(path.join(root, "wide-claude-audit-report.json"), JSON.stringify(json, null, 2));
  console.log(report);
  console.log(`\nWrote ${path.join(root, "wide-claude-audit-report.md")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
