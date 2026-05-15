#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { envForJavaResolution, resolveJavaRuntime } from "./java-resolver.mjs";

const apiUrl = readArg("api-url", process.env.COMBYNE_API_URL ?? "http://127.0.0.1:3100/api").replace(/\/$/, "");
const adapterType = readArg("adapter", process.env.COMBYNE_AUDIT_ADAPTER ?? "claude_local");
if (adapterType !== "claude_local" && adapterType !== "codex_local") {
  throw new Error(`Unsupported audit adapter "${adapterType}". Use claude_local or codex_local.`);
}
const adapterSlug = adapterType === "codex_local" ? "codex" : "claude";
const reportBaseName = `wide-${adapterSlug}-audit-report`;
const root = readArg("root", path.join("/tmp", `combyne-em-autonomy-wide-${adapterSlug}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const worktreeRoot = readArg("worktree-root", `${root}-issue-worktrees`);
const sourceBnpl = readArg("bnpl", "/Users/krishsharma/Desktop/Lending_team/fs-bnpl-service");
const sourceBrick = readArg("brick", "/Users/krishsharma/Desktop/Lending_team/fs-brick-service");
const watchMs = Math.max(30_000, Number(readArg("watch-ms", "300000")) || 300_000);
const initialSampleMs = Math.max(5_000, Number(readArg("initial-sample-ms", "20000")) || 20_000);
const maxTurns = Math.max(1, Number(readArg("max-turns", "60")) || 60);
const timeoutSec = Math.max(60, Number(readArg("agent-timeout-sec", "600")) || 600);
const emConcurrency = Math.max(1, Math.min(10, Number(readArg("em-concurrency", "10")) || 10));
const archiveExisting = hasFlag("archive-existing");
const javaHome = readArg("java-home", process.env.COMBYNE_AUDIT_JAVA_HOME ?? null);

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
    env: opts.env,
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
  const attempts = 5;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}${pathname}`, {
        method,
        headers: headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(`${method} ${pathname} -> ${response.status}: ${text}`);
        if (response.status >= 500 && attempt < attempts) {
          lastError = error;
          await sleep(500 * attempt);
          continue;
        }
        throw error;
      }
      return json;
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) break;
      await sleep(500 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? `Failed ${method} ${pathname}`));
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

function codexConfig(promptTemplate) {
  return {
    dangerouslyBypassApprovalsAndSandbox: true,
    modelReasoningEffort: "low",
    timeoutSec,
    promptTemplate,
    search: false,
  };
}

function adapterConfig(promptTemplate) {
  return adapterType === "codex_local" ? codexConfig(promptTemplate) : claudeConfig(promptTemplate);
}

async function createAgent(companyId, data) {
  return api(`/companies/${companyId}/agents`, {
    method: "POST",
    body: {
      adapterType,
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: data.role === "em" ? emConcurrency : 3 } },
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

async function listExecutionWorkspaces(companyId, issueId) {
  const suffix = issueId ? `?issueId=${encodeURIComponent(issueId)}` : "";
  return api(`/companies/${companyId}/execution-workspaces${suffix}`);
}

async function wake(agentId, issueId, reason) {
  return api(`/agents/${agentId}/wakeup`, {
    method: "POST",
    body: {
      source: "automation",
      triggerDetail: "system",
      reason,
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, taskKey: issueId, wakeReason: reason, source: `wide_${adapterSlug}_audit` },
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

async function summarizeTask(ctx, task) {
  const companyId = ctx.company.id;
  const allIssues = await listIssues(companyId);
  const issuesInTree = [
    allIssues.find((issue) => issue.id === task.issue.id) ?? task.issue,
    ...descendantsFor(task.issue.id, allIssues),
  ];
  const issueIds = new Set(issuesInTree.map((issue) => issue.id));
  const comments = (await Promise.all(
    [...issueIds].map(async (id) => (await listComments(id)).map((comment) => ({ ...comment, issueId: comment.issueId ?? id }))),
  )).flat();
  const runs = (await listRuns(companyId)).filter((run) => runBelongsToIssue(run, issueIds));
  const topIssue = allIssues.find((issue) => issue.id === task.issue.id) ?? task.issue;
  const outputQuality = await Promise.all(
    issuesInTree.map((issue) =>
      issueOutputQuality(
        ctx,
        issue,
        comments.filter((comment) => comment.issueId === issue.id),
      ),
    ),
  );
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
    outputQuality,
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

async function issueTreeIds(companyId, rootIssueIds) {
  const allIssues = await listIssues(companyId);
  const idSet = new Set(rootIssueIds);
  for (const rootIssueId of rootIssueIds) {
    for (const child of descendantsFor(rootIssueId, allIssues)) idSet.add(child.id);
  }
  return idSet;
}

async function waitForRuns(companyId, rootIssueIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let relevant = [];
  let idleSamples = 0;
  while (Date.now() < deadline) {
    const idSet = await issueTreeIds(companyId, rootIssueIds);
    relevant = (await listRuns(companyId)).filter((run) => runBelongsToIssue(run, idSet));
    const live = relevant.filter((run) => run.status === "queued" || run.status === "running");
    if (relevant.length >= rootIssueIds.length && live.length === 0) {
      idleSamples += 1;
      if (idleSamples >= 3) break;
    } else {
      idleSamples = 0;
    }
    await sleep(5_000);
  }
  return relevant;
}

function repoStatus(copy) {
  const branch = run("git", ["-C", copy.target, "branch", "--show-current"], { capture: true }).trim();
  const status = run("git", ["-C", copy.target, "status", "--short"], { capture: true }).trim();
  const baseStat = run("git", ["-C", copy.target, "diff", "--stat", `${copy.head}..HEAD`], { capture: true }).trim();
  const baseFiles = run("git", ["-C", copy.target, "diff", "--name-only", `${copy.head}..HEAD`], { capture: true }).trim();
  const worktreeStat = run("git", ["-C", copy.target, "diff", "--stat"], { capture: true }).trim();
  return {
    repo: copy.target,
    baseHead: copy.head,
    branch: branch || "(detached)",
    status: status || "(clean)",
    diffStat: baseStat || "(no committed diff from base to HEAD)",
    diffFiles: baseFiles || "(no committed files changed from base to HEAD)",
    worktreeDiffStat: worktreeStat || "(no uncommitted diff)",
  };
}

function repoCopyForIssue(ctx, issue) {
  if (issue.projectId === ctx.bnplProject.id) return ctx.bnplCopy;
  if (issue.projectId === ctx.brickProject.id) return ctx.brickCopy;
  return null;
}

function gitOutputOrEmpty(args, cwd) {
  if (!cwd || !existsSync(cwd)) return "";
  try {
    return run("git", ["-C", cwd, ...args], { capture: true }).trim();
  } catch {
    return "";
  }
}

function statusFiles(statusText) {
  return statusText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(2).trim())
    .flatMap((file) => file.includes(" -> ") ? file.split(" -> ").map((part) => part.trim()) : [file])
    .filter(Boolean);
}

function textForComments(comments) {
  return comments
    .map((comment) => [comment.body, comment.content, comment.message, comment.text].find((value) => typeof value === "string") ?? "")
    .join("\n");
}

function extractClaimedFiles(text) {
  const matches = text.match(/\b(?:src|test|app|server|ui|packages|scripts|doc)\/[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._@+-]+)*\.[A-Za-z0-9]+/g) ?? [];
  return [...new Set(matches)];
}

function fileSetsIntersect(claimedFiles, changedFiles) {
  if (claimedFiles.length === 0 || changedFiles.length === 0) return false;
  return claimedFiles.some((claimed) =>
    changedFiles.some((changed) => changed === claimed || changed.endsWith(`/${claimed}`) || claimed.endsWith(`/${changed}`)),
  );
}

function workspaceDiffSummary(workspace, copy) {
  const cwd = workspace?.cwd ?? workspace?.workspacePath ?? null;
  const baseRef = workspace?.baseRef || copy?.head || "HEAD";
  if (!cwd || !existsSync(cwd)) {
    return {
      status: "(workspace path missing)",
      committedDiffStat: "",
      committedFiles: [],
      uncommittedDiffStat: "",
      uncommittedFiles: [],
      branch: workspace?.branchName ?? null,
      baseRef,
    };
  }
  const branch = gitOutputOrEmpty(["branch", "--show-current"], cwd) || workspace?.branchName || "(detached)";
  const status = gitOutputOrEmpty(["status", "--short"], cwd);
  const committedDiffStat = gitOutputOrEmpty(["diff", "--stat", `${baseRef}..HEAD`], cwd);
  const committedFiles = gitOutputOrEmpty(["diff", "--name-only", `${baseRef}..HEAD`], cwd)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uncommittedDiffStat = gitOutputOrEmpty(["diff", "--stat"], cwd);
  const uncommittedFiles = [
    ...gitOutputOrEmpty(["diff", "--name-only"], cwd).split("\n").map((line) => line.trim()).filter(Boolean),
    ...statusFiles(status),
  ];
  return {
    status: status || "(clean)",
    committedDiffStat,
    committedFiles: [...new Set(committedFiles)],
    uncommittedDiffStat,
    uncommittedFiles: [...new Set(uncommittedFiles)],
    branch,
    baseRef,
  };
}

async function issueOutputQuality(ctx, issue, comments) {
  const workspaces = await listExecutionWorkspaces(ctx.company.id, issue.id).catch(() => []);
  const workspace = workspaces[0] ?? null;
  const copy = repoCopyForIssue(ctx, issue);
  const diff = workspace ? workspaceDiffSummary(workspace, copy) : null;
  const changedFiles = diff ? [...new Set([...diff.committedFiles, ...diff.uncommittedFiles])] : [];
  const text = `${issue.title ?? ""}\n${issue.description ?? ""}\n${textForComments(comments)}`;
  const claimedFiles = extractClaimedFiles(text);
  const claimsCodeChange = /\b(changed|modified|updated|added|implemented|fixed|created|patched|refactored|test(?:ed|s)?|diff|commit)\b/i.test(text);
  const noCodeRationale = /\b(no code change|no changes required|already safe|already handled|not required|verified only|no-op|no code needed)\b/i.test(text);
  const hasDiff = changedFiles.length > 0 || Boolean(diff?.committedDiffStat || diff?.uncommittedDiffStat);
  const claimsMatchDiff = fileSetsIntersect(claimedFiles, changedFiles);
  const outputQualityStatus = (() => {
    if (!workspace) return "no_execution_workspace";
    if (hasDiff && (claimedFiles.length === 0 || claimsMatchDiff)) return "diff_present";
    if (hasDiff && claimedFiles.length > 0 && !claimsMatchDiff) return "diff_present_claimed_files_unmatched";
    if (claimsCodeChange && !hasDiff) return "claimed_change_without_diff";
    if (issue.status === "done" && noCodeRationale) return "done_no_code_rationale";
    if (issue.status === "done") return "done_without_diff_or_rationale";
    return "no_diff_observed";
  })();

  return {
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
    projectId: issue.projectId ?? null,
    executionWorkspaceId: workspace?.id ?? issue.executionWorkspaceId ?? null,
    workspacePath: workspace?.cwd ?? null,
    branchName: workspace?.branchName ?? null,
    baseRef: diff?.baseRef ?? workspace?.baseRef ?? copy?.head ?? null,
    diffStat: [
      diff?.committedDiffStat ? `Committed:\n${diff.committedDiffStat}` : "",
      diff?.uncommittedDiffStat ? `Uncommitted:\n${diff.uncommittedDiffStat}` : "",
    ].filter(Boolean).join("\n\n") || "(no diff)",
    changedFiles,
    claimedFiles,
    claimsCodeChange,
    noCodeRationale,
    outputQualityStatus,
    worktreeStatus: diff?.status ?? "(no workspace)",
  };
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
  const java = resolveJavaRuntime({ cwd: copy.target, javaHome });
  if (java.status === "setup_missing") {
    return {
      repo: copy.target,
      status: "setup_missing",
      detail: java.guidance,
      java,
    };
  }
  try {
    const output = run("./gradlew", ["tasks", "--all", "--no-daemon"], {
      cwd: copy.target,
      capture: true,
      env: envForJavaResolution(java),
    });
    return { repo: copy.target, status: "pass", detail: output.slice(0, 1000), java };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/Unsupported class file major version/i.test(detail)) {
      return {
        repo: copy.target,
        status: "setup_missing",
        detail: `Gradle/JDK toolchain mismatch. ${java.guidance ?? "Set --java-home or COMBYNE_AUDIT_JAVA_HOME to a compatible JDK."}`,
        java,
      };
    }
    return { repo: copy.target, status: "fail", detail, java };
  }
}

function isolatedWorkspacePolicy(worktreeParentDir = null) {
  return {
    enabled: true,
    defaultMode: "isolated_workspace",
    allowIssueOverride: true,
    workspaceStrategy: {
      type: "git_worktree",
      branchTemplate: "{{issue.identifier}}-{{slug}}",
      ...(worktreeParentDir ? { worktreeParentDir } : {}),
    },
  };
}

async function archiveExistingAuditCompanies() {
  const companies = await api("/companies");
  const candidates = companies.filter((company) =>
    String(company.name).startsWith("EM autonomy audit") ||
    String(company.name).startsWith("EM wide Claude audit") ||
    String(company.name).startsWith("EM wide Codex audit")
  );
  for (const company of candidates) {
    if (company.status === "archived") continue;
    await api(`/companies/${company.id}/archive`, { method: "POST" });
  }
  return candidates.length;
}

function taskDefinitions(ctx) {
  const workspaceOnly = "Use only the execution workspace cwd supplied by Combyne for this issue; do not edit the primary project checkout or any absolute source path.";
  return [
    {
      key: "S1",
      size: "S",
      projectId: ctx.bnplProject.id,
      title: "S1 BNPL null-safe spouse-income default",
      description: `Small autonomous ticket. ${workspaceOnly} In the focused BNPL workspace, inspect only the DTO/model path around src/main/java/com/bukuwarung/fsbnplservice/model/Demographic.java and nearby tests. Make the smallest reasonable null-safe default/guard for missing spouse income or equivalent spouse demographic ambiguity. If the exact product choice is unclear, assume missing optional spouse-income style fields default to zero/not-present and continue. Human question budget: 0. Delegate to BNPL engineer if useful, then verify and close or summarize blocker.`,
    },
    {
      key: "S2",
      size: "S",
      projectId: ctx.brickProject.id,
      title: "S2 Brick missing-token message mapping",
      description: `Small autonomous ticket. ${workspaceOnly} In the focused Brick workspace, inspect src/main/java/com/bukuwarung/fsbrickservice/util/BrickErrorMapping.java. Add or verify a readable mapping for a missing/blank token style error using the existing login/authorization fallback. If wording is ambiguous, use the existing Unauthorized style message. Human question budget: 0. Keep changes tiny and add/update a nearby lightweight test only if one already exists.`,
    },
    {
      key: "S3",
      size: "S",
      projectId: ctx.bnplProject.id,
      title: "S3 BNPL bank-validation boolean default",
      description: `Small autonomous ticket. ${workspaceOnly} In the focused BNPL workspace, inspect src/main/java/com/bukuwarung/fsbnplservice/dto/BankValidationRequestDto.java and usages. Make the smallest safe handling improvement so missing is_payment_in is treated as false/defensive default where consumed, or document no code change if already safe. If ambiguous, assume false. Human question budget: 0.`,
    },
    {
      key: "S4",
      size: "S",
      projectId: ctx.brickProject.id,
      title: "S4 Brick request-status constant cleanup",
      description: `Small autonomous ticket. ${workspaceOnly} In the focused Brick workspace, inspect src/main/java/com/bukuwarung/fsbrickservice/constants/RequestStatusCodeConstants.java and usages. Add a missing common failure constant only if the code already uses that status pattern, otherwise leave a short implementation comment. If ambiguous, do not ask the user; choose the least invasive constant-only change. Human question budget: 0.`,
    },
    {
      key: "S5",
      size: "S",
      projectId: ctx.bnplProject.id,
      title: "S5 BNPL BMU V2 deeplink TODO cleanup",
      description: `Small autonomous ticket. ${workspaceOnly} In the focused BNPL workspace, inspect src/main/java/com/bukuwarung/fsbnplservice/util/DeepLinkUtility.java and src/test/java/com/bukuwarung/fsbnplservice/util/DeepLinkUtilityTest.java. Replace the stale TODO in generateBnplV2PushNotificationDeepLink with a concrete low-risk implementation note or named constant, and add/adjust a regression test that captures the current BNPL landing-page deeplink behavior. If product intent is ambiguous, assume the existing landing-page behavior remains correct and continue. Human question budget: 0.`,
    },
    {
      key: "S6",
      size: "S",
      projectId: ctx.brickProject.id,
      title: "S6 Brick bearer-token normalization",
      description: `Small autonomous ticket. ${workspaceOnly} In the focused Brick workspace, inspect src/main/java/com/bukuwarung/fsbrickservice/util/Utility.java and nearby tests. Make getBearerToken tolerate leading/trailing spaces and lowercase bearer prefixes without changing valid-token behavior. Add or update a focused unit test if a Utility test exists; otherwise add the smallest local test. Human question budget: 0.`,
    },
    {
      key: "S7",
      size: "S",
      projectId: ctx.brickProject.id,
      title: "S7 Brick residence status blank handling",
      description: `Small autonomous ticket. ${workspaceOnly} In the focused Brick workspace, inspect src/main/java/com/bukuwarung/fsbrickservice/enums/GtResidenceStatusEnum.java and its tests. Make blank or whitespace-only descriptions resolve consistently to LAINNYA, matching the existing empty-string behavior. Do not ask the user; this is a defensive normalization task. Human question budget: 0.`,
    },
    {
      key: "M1",
      size: "M",
      projectId: ctx.bnplProject.id,
      title: "M1 Cross-repo nullable validation consistency",
      description: `Medium coordination ticket. ${workspaceOnly} Coordinate one BNPL child and one Brick child in parallel across the focused BNPL and Brick project workspaces. Goal: align nullable validation defaults for low-risk optional request fields and add a brief note/test where appropriate. The EM should parallelize across BNPL and Brick engineers, then verify both. Human question budget: at most 1, only if a true product behavior cannot be inferred from code or existing docs.`,
    },
    {
      key: "M2",
      size: "M",
      projectId: ctx.brickProject.id,
      title: "M2 Brick QA-style regression follow-up",
      description: `Medium ticket. ${workspaceOnly} Treat this as a QA feedback loop in the focused Brick workspace: a missing authorization/token path should produce the standard user-safe error body. Coordinate dev and QA/reviewer as needed. Human question budget: at most 1, only if the expected external contract is absent from code/tests/docs.`,
    },
    {
      key: "M3",
      size: "M",
      projectId: ctx.bnplProject.id,
      title: "M3 BNPL review-driven regression coverage",
      description: `Medium ticket. ${workspaceOnly} Simulate a reviewer asking for regression coverage around BNPL optional demographic defaults in the focused BNPL workspace. The EM should assign or perform the work, review output, and avoid asking the user unless the code/doc context cannot establish expected behavior. Human question budget: at most 2.`,
    },
  ];
}

function renderReport(ctx, tasks, wakeResponses, initialRuns, finalSummaries, repoStatuses, quality) {
  const firstWaveIds = new Set(tasks.map((task) => task.issue.id));
  const firstWaveRuns = initialRuns.filter((run) => firstWaveIds.has(run.contextSnapshot?.issueId));
  const firstWaveRunning = firstWaveRuns.filter((run) => run.status === "running").length;
  const firstWaveQueued = firstWaveRuns.filter((run) => run.status === "queued").length;
  const lines = [
    `# Wide ${adapterSlug === "codex" ? "Codex" : "Claude"} EM Autonomy Audit`,
    "",
    `- API: ${apiUrl}`,
    `- Company: ${ctx.company.name} (${ctx.company.id})`,
    `- Root: ${root}`,
    `- Issue worktree root: ${worktreeRoot}`,
    `- Adapter: ${adapterType}`,
    `- Isolated workspaces: enabled for audit projects`,
    `- EM max concurrent runs: ${emConcurrency}`,
    `- Top-level ticket sample after: ${initialSampleMs} ms`,
    `- Watch cap: ${watchMs} ms`,
    `- BNPL copy: ${ctx.bnplCopy.target} @ ${ctx.bnplCopy.head}`,
    `- Brick copy: ${ctx.brickCopy.target} @ ${ctx.brickCopy.head}`,
    "",
    "## EM Parallelization",
    "",
    `- Top-level tickets: ${tasks.map((task) => task.issue.identifier).join(", ")}`,
    `- Top-level running at sample: ${firstWaveRunning}`,
    `- Top-level queued at sample: ${firstWaveQueued}`,
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
    lines.push("- Output quality:");
    for (const item of summary.outputQuality) {
      const fileSummary = item.changedFiles.length > 0 ? item.changedFiles.slice(0, 8).join(", ") : "none";
      lines.push(
        `  - ${item.identifier ?? item.issueId}: ${item.outputQualityStatus}; workspace=${item.workspacePath ?? "none"}; branch=${item.branchName ?? "none"}; files=${fileSummary}`,
      );
    }
  }

  lines.push("", "## Issue Worktree Outputs");
  for (const summary of finalSummaries) {
    for (const item of summary.outputQuality) {
      lines.push(
        "",
        `### ${summary.key} / ${item.identifier ?? item.issueId}: ${item.title}`,
        "",
        `- Status: ${item.status}`,
        `- Output quality: ${item.outputQualityStatus}`,
        `- Execution workspace: ${item.executionWorkspaceId ?? "none"}`,
        `- Workspace path: ${item.workspacePath ?? "none"}`,
        `- Branch: ${item.branchName ?? "none"}`,
        `- Base ref: ${item.baseRef ?? "unknown"}`,
        `- Changed files: ${item.changedFiles.length > 0 ? item.changedFiles.join(", ") : "none"}`,
        `- Claimed files: ${item.claimedFiles.length > 0 ? item.claimedFiles.join(", ") : "none"}`,
        "",
        "```text",
        `Worktree status: ${item.worktreeStatus}`,
        "",
        item.diffStat,
        "```",
      );
    }
  }

  lines.push("", "## Copied Repo Diffs");
  for (const status of repoStatuses) {
    lines.push(
      "",
      `### ${status.repo}`,
      "",
      "```text",
      `Branch: ${status.branch}`,
      `Base: ${status.baseHead}`,
      "",
      "Worktree status:",
      status.status,
      "",
      "Committed diff from base to HEAD:",
      status.diffStat,
      "",
      "Committed files:",
      status.diffFiles,
      "",
      "Uncommitted diff:",
      status.worktreeDiffStat,
      "```",
    );
  }

  lines.push("", "## Workspace Quality Checks");
  for (const item of quality) {
    lines.push(`- ${item.status.toUpperCase()}: ${item.repo} — ${item.detail.split("\n")[0]}`);
  }

  return lines.join("\n");
}

async function main() {
  await mkdir(root, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  if (archiveExisting) {
    const count = await archiveExistingAuditCompanies();
    console.log(`Archived/checked ${count} previous audit companies.`);
  }
  const experimentalSettings = await api("/instance/settings/experimental", {
    method: "PATCH",
    body: { enableIsolatedWorkspaces: true },
  });
  const bnplCopy = await copyCleanGitRepo(sourceBnpl, path.join(root, "fs-bnpl-service"));
  const brickCopy = await copyCleanGitRepo(sourceBrick, path.join(root, "fs-brick-service"));
  const company = await api("/companies", {
    method: "POST",
    body: {
      name: `EM wide ${adapterSlug === "codex" ? "Codex" : "Claude"} audit ${new Date().toISOString()}`,
      description: `Wide live ${adapterType} audit for EM parallelization, S/M question budgets, delegated execution, and isolated worktree output integrity.`,
    },
  });

  const emPrompt = [
    "You are the Audit EM. Work only on the focused issue from Combyne context.",
    "For S tickets, do not ask the human. Answer ambiguity from repo context or make a documented reasonable assumption.",
    "For M tickets, create delegated child issues immediately using the Combyne API/delegation endpoint before trying to close the parent. Ask at most one or two human questions only for true product decisions not inferable from context.",
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
    adapterConfig: adapterConfig(emPrompt),
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: emConcurrency } },
    capabilities: "Coordinates several S/M Buku engineering tickets in parallel and answers ambiguity from context.",
  });
  const bnplDev = await createAgent(company.id, {
    name: "Wide Audit BNPL Engineer",
    role: "engineer",
    reportsTo: em.id,
    adapterConfig: adapterConfig(devPrompt),
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 2 } },
    capabilities: "Implements focused fs-bnpl-service Java/Spring changes.",
  });
  const brickDev = await createAgent(company.id, {
    name: "Wide Audit Brick Engineer",
    role: "engineer",
    reportsTo: em.id,
    adapterConfig: adapterConfig(devPrompt),
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 2 } },
    capabilities: "Implements focused fs-brick-service Java/Spring changes.",
  });
  const qa = await createAgent(company.id, {
    name: "Wide Audit QA",
    role: "qa",
    reportsTo: em.id,
    adapterConfig: adapterConfig("You are QA. Produce structured Markdown feedback with summary, failures, evidence, expected/actual, and requested action. Never dump raw logs."),
    capabilities: "Runs focused QA and reports actionable feedback.",
  });
  const reviewer = await createAgent(company.id, {
    name: "Wide Audit Reviewer",
    role: "engineer",
    reportsTo: em.id,
    adapterConfig: adapterConfig("You are reviewer. Review focused diffs and post concise actionable review feedback. Do not ask the human."),
    capabilities: "Reviews focused Buku Java diffs.",
  });

  const bnplProject = await api(`/companies/${company.id}/projects`, {
    method: "POST",
    body: {
      name: "wide fs-bnpl-service copy",
      leadAgentId: em.id,
      executionWorkspacePolicy: isolatedWorkspacePolicy(path.join(worktreeRoot, "bnpl")),
      workspace: { name: "BNPL wide audit copy", sourceType: "local_path", cwd: bnplCopy.target, repoRef: bnplCopy.head, isPrimary: true },
    },
  });
  const brickProject = await api(`/companies/${company.id}/projects`, {
    method: "POST",
    body: {
      name: "wide fs-brick-service copy",
      leadAgentId: em.id,
      executionWorkspacePolicy: isolatedWorkspacePolicy(path.join(worktreeRoot, "brick")),
      workspace: { name: "Brick wide audit copy", sourceType: "local_path", cwd: brickCopy.target, repoRef: brickCopy.head, isPrimary: true },
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
      complexity: spec.size === "S" ? "small" : "medium",
      priority: spec.size === "S" ? "medium" : "high",
      assigneeAgentId: em.id,
    });
    tasks.push({ ...spec, issue });
  }

  const wakeResponses = [];
  for (const task of tasks) {
    const response = await wake(em.id, task.issue.id, `wide_audit_${task.key.toLowerCase()}`);
    wakeResponses.push({ issueKey: task.key, status: response.status, runId: response.runId ?? response.id ?? null });
  }
  await sleep(initialSampleMs);
  const initialRuns = await listRuns(company.id);

  await waitForRuns(company.id, tasks.map((task) => task.issue.id), watchMs);
  const finalSummaries = [];
  for (const task of tasks) finalSummaries.push(await summarizeTask(ctx, task));
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
    worktreeRoot,
    tasks: tasks.map(publicTask),
    wakeResponses,
    experimentalSettings,
    initialRuns: initialRuns.map(publicRun),
    finalSummaries,
    repoStatuses,
    quality,
  };
  await writeFile(path.join(root, `${reportBaseName}.md`), report);
  await writeFile(path.join(root, `${reportBaseName}.json`), JSON.stringify(json, null, 2));
  console.log(report);
  console.log(`\nWrote ${path.join(root, `${reportBaseName}.md`)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });
}

export {
  isolatedWorkspacePolicy,
  renderReport,
  workspaceDiffSummary,
};
