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
import { notifyParentOnChildAgentComment } from "./issue-parent-notifications.js";
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

function looksLikeRawLogOrCodeLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(stdout|stderr|debug|trace|info|warn|error)\b[:\s]/i.test(trimmed)) return true;
  if (/^\[[^\]]+\]\s+(?:debug|info|warn|error|trace)\b/i.test(trimmed)) return true;
  if (/^at\s+\S+\s+\(/.test(trimmed)) return true;
  if (/^(?:import|export|const|let|var|function|class|interface|type|public|private|protected|return|throw|if|for|while|switch)\b/.test(trimmed)) {
    return true;
  }
  if (/^[{}()[\],;]+$/.test(trimmed)) return true;
  if (/[{};]\s*$/.test(trimmed) && !/^[-*]\s+/.test(trimmed)) return true;
  return false;
}

function sanitizeQaAgentNote(value: string | null | undefined) {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const kept = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !looksLikeRawLogOrCodeLine(line));
  const compact = kept.join("\n").trim();
  if (!compact) return null;
  return compact.length > 1200 ? `${compact.slice(0, 1199).trimEnd()}…` : compact;
}

function summarizeQaFeedbackForContext(body: string | null | undefined) {
  const lines = (body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .slice(0, 8);
  const summary = lines.join(" ").replace(/\s+/g, " ").trim();
  if (!summary) return null;
  return summary.length > 900 ? `${summary.slice(0, 899).trimEnd()}…` : summary;
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

type QaReportIssueContext = {
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
} | null;

function formatCountLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTimestamp(value: Date | string | null | undefined) {
  if (!value) return "Not recorded";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return "Not recorded";
  if (value < 1000) return `${value} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function statusLabel(status: string) {
  return status
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function reportOutcome(detail: QaRunDetail) {
  const failed = detail.results.filter((result) => result.status === "failed").length;
  const blocked = detail.results.filter((result) => result.status === "blocked").length;
  const passed = detail.results.filter((result) => result.status === "passed").length;
  const skipped = detail.results.filter((result) => result.status === "skipped").length;
  return {
    failed,
    blocked,
    passed,
    skipped,
    total: detail.results.length,
    failingOrBlocked: failed + blocked,
  };
}

function assertQaReportReady(detail: QaRunDetail) {
  if (detail.run.status === "queued" || detail.run.status === "running") {
    throw unprocessable(
      `QA report is not ready yet. Run status is ${detail.run.status}; export after QA records a final result.`,
    );
  }
}

function runToReport(detail: QaRunDetail, issue: QaReportIssueContext = null) {
  const failed = detail.results.filter((r) => isFailure(r.status));
  const counts = reportOutcome(detail);
  const lines: string[] = [];
  lines.push(`# QA Validation Report`);
  lines.push("");
  lines.push(`## ${detail.run.title}`);
  lines.push("");
  lines.push(`- Outcome: ${statusLabel(detail.run.status)}`);
  lines.push(`- Results: ${formatCountLabel(counts.total, "case")}`);
  lines.push(`- Passed: ${counts.passed}`);
  lines.push(`- Failed: ${counts.failed}`);
  lines.push(`- Blocked: ${counts.blocked}`);
  lines.push(`- Skipped: ${counts.skipped}`);
  lines.push(`- Platform: ${detail.run.platform}`);
  lines.push(`- Runner: ${detail.run.runnerType}`);
  if (issue) lines.push(`- Issue: ${issue.identifier ?? issue.title} - ${issue.title}`);
  if (detail.run.repo) lines.push(`- Repo: ${detail.run.repo}${detail.run.pullNumber ? `#${detail.run.pullNumber}` : ""}`);
  if (detail.run.headSha) lines.push(`- Head SHA: ${detail.run.headSha}`);
  if (detail.suite) lines.push(`- Suite: ${detail.suite.name}`);
  if (detail.environment) lines.push(`- Environment: ${detail.environment.name}${detail.environment.baseUrl ? ` (${detail.environment.baseUrl})` : ""}`);
  if (detail.device) lines.push(`- Device: ${detail.device.name} (${detail.device.apiLevel ?? "unknown API"})`);
  lines.push(`- Started: ${formatTimestamp(detail.run.startedAt)}`);
  lines.push(`- Finished: ${formatTimestamp(detail.run.finishedAt)}`);
  if (detail.run.summary) lines.push(`- Summary: ${detail.run.summary}`);
  lines.push("");

  lines.push(`## Result Details`);
  if (detail.results.length === 0) {
    lines.push("No test result rows were recorded for this run.");
  } else {
    lines.push("| Status | Case | Duration | Failure reason |");
    lines.push("| --- | --- | --- | --- |");
    for (const result of detail.results) {
      lines.push(`| ${statusLabel(result.status)} | ${result.title} | ${formatDuration(result.durationMs)} | ${result.failureReason ?? ""} |`);
    }
  }

  if (failed.length > 0) {
    lines.push("", "## Failures and Blockers");
    for (const [index, result] of failed.entries()) {
      lines.push(`### ${index + 1}. ${result.title}`);
      lines.push(`- Status: ${statusLabel(result.status)}`);
      lines.push(`- Expected: ${result.expectedResult ?? "Not recorded"}`);
      lines.push(`- Actual: ${result.actualResult ?? "Not recorded"}`);
      lines.push(`- Failure reason: ${result.failureReason ?? "Not recorded"}`);
    }
  }

  if (detail.artifacts.length > 0) {
    lines.push("", "## Artifacts");
    for (const artifact of detail.artifacts) {
      lines.push(`- ${artifact.type}: ${artifact.title}${artifact.summary ? ` - ${artifact.summary}` : ""}${artifact.url ? ` (${artifact.url})` : ""}`);
    }
  }

  if (detail.feedbackEvents.length > 0) {
    lines.push("", "## Feedback");
    for (const event of detail.feedbackEvents.slice(0, 5)) {
      lines.push(`- ${statusLabel(event.status)}: ${event.title}`);
    }
  }
  return lines.join("\n");
}

function normalizePdfText(value: string) {
  return value
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfText(value: string) {
  return normalizePdfText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapPdfText(value: string, width: number, fontSize: number) {
  const maxChars = Math.max(12, Math.floor(width / (fontSize * 0.52)));
  const words = normalizePdfText(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function statusColor(status: string): [number, number, number] {
  if (status === "passed" || status === "approved") return [0.08, 0.46, 0.24];
  if (status === "failed") return [0.72, 0.11, 0.11];
  if (status === "blocked" || status === "cancelled") return [0.69, 0.29, 0.03];
  if (status === "running") return [0.04, 0.39, 0.61];
  return [0.45, 0.45, 0.45];
}

function rgb(color: [number, number, number]) {
  return color.map((part) => part.toFixed(3)).join(" ");
}

function renderQaReportPdf(detail: QaRunDetail, issue: QaReportIssueContext = null) {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 44;
  const contentWidth = pageWidth - margin * 2;
  const pages: string[][] = [[]];
  let y = pageHeight - margin;

  const current = () => pages[pages.length - 1]!;
  const command = (line: string) => current().push(line);
  const newPage = () => {
    pages.push([]);
    y = pageHeight - margin;
  };
  const ensureSpace = (height: number) => {
    if (y - height < margin + 24) newPage();
  };
  const drawRect = (x: number, top: number, width: number, height: number, color: [number, number, number]) => {
    command(`q ${rgb(color)} rg ${x.toFixed(1)} ${(top - height).toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)} re f Q`);
  };
  const drawLine = (x1: number, y1: number, x2: number, y2: number, color: [number, number, number] = [0.86, 0.88, 0.9]) => {
    command(`q ${rgb(color)} RG 0.75 w ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S Q`);
  };
  const drawText = (
    text: string,
    x: number,
    baseline: number,
    options: { font?: "F1" | "F2" | "F3"; size?: number; color?: [number, number, number] } = {},
  ) => {
    const font = options.font ?? "F1";
    const size = options.size ?? 10;
    const color = options.color ?? [0.12, 0.14, 0.17];
    command(`q ${rgb(color)} rg BT /${font} ${size} Tf ${x.toFixed(1)} ${baseline.toFixed(1)} Td (${escapePdfText(text)}) Tj ET Q`);
  };
  const addWrapped = (
    text: string,
    options: {
      x?: number;
      width?: number;
      font?: "F1" | "F2" | "F3";
      size?: number;
      color?: [number, number, number];
      lineHeight?: number;
      bottomGap?: number;
    } = {},
  ) => {
    const x = options.x ?? margin;
    const width = options.width ?? contentWidth;
    const size = options.size ?? 10;
    const lineHeight = options.lineHeight ?? size + 4;
    const lines = wrapPdfText(text, width, size);
    ensureSpace(lines.length * lineHeight + (options.bottomGap ?? 0));
    for (const line of lines) {
      drawText(line, x, y, { font: options.font, size, color: options.color });
      y -= lineHeight;
    }
    y -= options.bottomGap ?? 0;
  };
  const addHeading = (text: string) => {
    ensureSpace(34);
    y -= 4;
    drawText(text, margin, y, { font: "F2", size: 14, color: [0.07, 0.09, 0.13] });
    y -= 10;
    drawLine(margin, y, pageWidth - margin, y);
    y -= 16;
  };
  const addKeyValue = (label: string, value: string, x: number, width: number) => {
    drawText(label, x, y, { font: "F2", size: 8, color: [0.39, 0.45, 0.52] });
    const valueLines = wrapPdfText(value || "Not recorded", width, 10).slice(0, 2);
    let localY = y - 14;
    for (const line of valueLines) {
      drawText(line, x, localY, { size: 10, color: [0.1, 0.12, 0.16] });
      localY -= 12;
    }
  };
  const addMetric = (label: string, value: string, x: number, width: number, color: [number, number, number]) => {
    drawRect(x, y, width, 48, [0.96, 0.97, 0.98]);
    command(`q ${rgb(color)} rg ${x.toFixed(1)} ${(y - 48).toFixed(1)} 4.0 48.0 re f Q`);
    drawText(label, x + 12, y - 16, { font: "F2", size: 8, color: [0.39, 0.45, 0.52] });
    drawText(value, x + 12, y - 34, { font: "F2", size: 15, color: [0.08, 0.1, 0.13] });
  };

  const counts = reportOutcome(detail);
  drawText("QA Validation Report", margin, y, { font: "F2", size: 22, color: [0.05, 0.07, 0.11] });
  const status = statusLabel(detail.run.status);
  const badgeWidth = Math.max(72, status.length * 7 + 24);
  drawRect(pageWidth - margin - badgeWidth, y + 8, badgeWidth, 24, statusColor(detail.run.status));
  drawText(status, pageWidth - margin - badgeWidth + 12, y - 8, { font: "F2", size: 10, color: [1, 1, 1] });
  y -= 30;
  addWrapped(detail.run.title, { font: "F2", size: 15, lineHeight: 18, bottomGap: 8 });
  if (issue) addWrapped(`${issue.identifier ?? "Issue"} - ${issue.title}`, { size: 10, color: [0.33, 0.39, 0.46], bottomGap: 10 });

  ensureSpace(58);
  const metricGap = 10;
  const metricWidth = (contentWidth - metricGap * 3) / 4;
  addMetric("Outcome", status, margin, metricWidth, statusColor(detail.run.status));
  addMetric("Total cases", String(counts.total), margin + (metricWidth + metricGap), metricWidth, [0.12, 0.29, 0.57]);
  addMetric("Failed/blocked", String(counts.failingOrBlocked), margin + (metricWidth + metricGap) * 2, metricWidth, statusColor(counts.failingOrBlocked > 0 ? "failed" : "passed"));
  addMetric("Passed", String(counts.passed), margin + (metricWidth + metricGap) * 3, metricWidth, [0.08, 0.46, 0.24]);
  y -= 66;

  addHeading("Run Context");
  const leftWidth = (contentWidth - 22) / 2;
  const rightX = margin + leftWidth + 22;
  ensureSpace(86);
  addKeyValue("Platform", detail.run.platform, margin, leftWidth);
  addKeyValue("Runner", detail.run.runnerType, rightX, leftWidth);
  y -= 42;
  addKeyValue("Suite", detail.suite?.name ?? "Not recorded", margin, leftWidth);
  addKeyValue("Service", detail.run.service ?? "Not recorded", rightX, leftWidth);
  y -= 42;
  addKeyValue("Started", formatTimestamp(detail.run.startedAt), margin, leftWidth);
  addKeyValue("Finished", formatTimestamp(detail.run.finishedAt), rightX, leftWidth);
  y -= 32;
  if (detail.run.repo || detail.run.headSha || detail.environment || detail.device) {
    addWrapped(
      [
        detail.run.repo ? `Repo: ${detail.run.repo}${detail.run.pullNumber ? ` #${detail.run.pullNumber}` : ""}` : null,
        detail.run.headSha ? `Head SHA: ${detail.run.headSha}` : null,
        detail.environment ? `Environment: ${detail.environment.name}${detail.environment.baseUrl ? ` (${detail.environment.baseUrl})` : ""}` : null,
        detail.device ? `Device: ${detail.device.name} API ${detail.device.apiLevel ?? "unknown"}` : null,
      ].filter(Boolean).join("  |  "),
      { size: 9, color: [0.33, 0.39, 0.46], bottomGap: 8 },
    );
  }

  if (detail.run.summary) {
    addHeading("Summary");
    addWrapped(detail.run.summary, { size: 10, lineHeight: 14, bottomGap: 8 });
  }

  addHeading("Result Details");
  if (detail.results.length === 0) {
    addWrapped("No test result rows were recorded for this run.", { size: 10 });
  } else {
    ensureSpace(24);
    drawRect(margin, y + 10, contentWidth, 22, [0.93, 0.95, 0.97]);
    drawText("Status", margin + 8, y - 4, { font: "F2", size: 8, color: [0.35, 0.41, 0.48] });
    drawText("Case", margin + 78, y - 4, { font: "F2", size: 8, color: [0.35, 0.41, 0.48] });
    drawText("Duration", pageWidth - margin - 78, y - 4, { font: "F2", size: 8, color: [0.35, 0.41, 0.48] });
    y -= 24;
    for (const [index, result] of detail.results.entries()) {
      const titleLines = wrapPdfText(result.title, contentWidth - 180, 9);
      const reasonLines = result.failureReason ? wrapPdfText(result.failureReason, contentWidth - 180, 8).slice(0, 3) : [];
      const rowHeight = Math.max(30, titleLines.length * 11 + reasonLines.length * 10 + 12);
      ensureSpace(rowHeight + 4);
      if (index % 2 === 0) drawRect(margin, y + 6, contentWidth, rowHeight, [0.985, 0.988, 0.992]);
      drawText(statusLabel(result.status), margin + 8, y - 10, { font: "F2", size: 8, color: statusColor(result.status) });
      let rowY = y - 10;
      for (const line of titleLines) {
        drawText(line, margin + 78, rowY, { font: "F2", size: 9, color: [0.1, 0.12, 0.16] });
        rowY -= 11;
      }
      for (const line of reasonLines) {
        drawText(line, margin + 78, rowY, { size: 8, color: [0.55, 0.12, 0.12] });
        rowY -= 10;
      }
      drawText(formatDuration(result.durationMs), pageWidth - margin - 78, y - 10, { size: 8, color: [0.35, 0.41, 0.48] });
      y -= rowHeight;
    }
    y -= 6;
  }

  const failed = detail.results.filter((result) => isFailure(result.status));
  if (failed.length > 0) {
    addHeading("Failures and Blockers");
    for (const [index, result] of failed.entries()) {
      addWrapped(`${index + 1}. ${result.title}`, { font: "F2", size: 11, lineHeight: 15, bottomGap: 2 });
      addWrapped(`Expected: ${result.expectedResult?.trim() || "Not recorded"}`, { size: 9, lineHeight: 12 });
      addWrapped(`Actual: ${result.actualResult?.trim() || "Not recorded"}`, { size: 9, lineHeight: 12 });
      addWrapped(`Failure reason: ${result.failureReason?.trim() || "Not recorded"}`, { size: 9, lineHeight: 12, color: [0.6, 0.12, 0.12], bottomGap: 8 });
    }
  }

  if (detail.artifacts.length > 0) {
    addHeading("Evidence");
    for (const artifact of detail.artifacts.slice(0, 12)) {
      addWrapped(`${artifact.type}: ${artifact.title}${artifact.summary ? ` - ${artifact.summary}` : ""}${artifact.url ? ` (${artifact.url})` : ""}`, {
        size: 9,
        lineHeight: 12,
        bottomGap: 3,
      });
    }
  }

  if (detail.feedbackEvents.length > 0) {
    addHeading("Feedback");
    for (const event of detail.feedbackEvents.slice(0, 8)) {
      addWrapped(`${statusLabel(event.status)}: ${event.title}`, { size: 9, lineHeight: 12, bottomGap: 3 });
    }
  }

  const generatedAt = `Generated ${formatTimestamp(new Date())}`;
  for (const [index, page] of pages.entries()) {
    page.push(`q 0.45 0.48 0.53 rg BT /F1 8 Tf ${margin.toFixed(1)} 24.0 Td (${escapePdfText(generatedAt)}) Tj ET Q`);
    page.push(`q 0.45 0.48 0.53 rg BT /F1 8 Tf ${(pageWidth - margin - 52).toFixed(1)} 24.0 Td (${escapePdfText(`Page ${index + 1} of ${pages.length}`)}) Tj ET Q`);
  }

  const objects: string[] = [];
  const addObject = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = addObject("placeholder");
  const pagesId = addObject("placeholder");
  const fontRegularId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBoldId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const fontItalicId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>");
  const pageIds: number[] = [];
  for (const page of pages) {
    const stream = page.join("\n");
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontItalicId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const startXref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Root ${catalogId} 0 R /Size ${objects.length + 1} >>\nstartxref\n${startXref}\n%%EOF`;
  return pdf;
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
    const targetAgent = targetAgentId
      ? await db
          .select({ id: agents.id, name: agents.name, role: agents.role })
          .from(agents)
          .where(eq(agents.id, targetAgentId))
          .then((rows) => rows[0] ?? null)
      : null;
    const title = input.title ?? `QA feedback: ${detail.run.title}`;
    const body = buildFeedbackBody(detail, {
      agentBody: input.body ?? null,
      targetAgentName: targetAgent?.name ?? null,
    });
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
    const requiresApproval = input.requiresApproval === true;

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
      requiresApproval,
      developerVisible:
        existing?.status === "approved_for_dev" ||
        existing?.status === "sent_to_dev" ||
        !requiresApproval,
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
      if (requiresApproval) return updated;
      return dispatchQaFeedbackToDeveloper(updated, {
        actorType: actor.userId ? "user" : actor.agentId ? "agent" : "system",
        actorId: actor.userId ?? actor.agentId ?? "qa-feedback",
      });
    }

    const inserted = await db
      .insert(qaFeedbackEvents)
      .values({
        companyId: detail.run.companyId,
        runId,
        issueId: detail.run.issueId,
        fromQaAgentId: detail.run.qaAgentId ?? actor.agentId ?? null,
        toAgentId: targetAgentId,
        title,
        body,
        status: requiresApproval ? "pending_qa_approval" : "queued",
        severity: input.severity ?? (failed.some((r) => r.status === "blocked") ? "high" : "medium"),
        dedupeHash: hash,
        artifactRefs,
        metadata,
      })
      .returning()
      .then((rows) => rows[0]);
    if (requiresApproval) return inserted;
    return dispatchQaFeedbackToDeveloper(inserted, {
      actorType: actor.userId ? "user" : actor.agentId ? "agent" : "system",
      actorId: actor.userId ?? actor.agentId ?? "qa-feedback",
    });
  }

  async function getFeedback(feedbackId: string) {
    return db.select().from(qaFeedbackEvents).where(eq(qaFeedbackEvents.id, feedbackId)).then((rows) => rows[0] ?? null);
  }

  async function dispatchQaFeedbackToDeveloper(
    feedback: typeof qaFeedbackEvents.$inferSelect,
    input: {
      actorType: "user" | "agent" | "system";
      actorId: string | null;
      note?: string | null;
      approved?: boolean;
    },
  ) {
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
        createdByUserId: input.actorType === "user" ? input.actorId : null,
      });
      bugIssueId = bug.id;
    }

    let commentId: string | null = null;
    let commentBody: string | null = null;
    if (feedback.issueId) {
      commentBody = `${feedback.body}\n\n_${input.approved ? "QA approved for developer handoff." : "QA feedback sent to developer."}_${input.note ? `\n\nApproval note: ${input.note}` : ""}`;
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId: feedback.companyId,
          issueId: feedback.issueId,
          authorAgentId: input.actorType === "agent" ? input.actorId : feedback.fromQaAgentId,
          authorUserId: input.actorType === "user" ? input.actorId : null,
          body: commentBody,
          kind: "system",
        })
        .returning({ id: issueComments.id });
      commentId = comment?.id ?? null;
      if (issue?.parentId && commentId) {
        await notifyParentOnChildAgentComment(db, {
          child: issue,
          commentId,
          commentBody,
          actorAgentId: feedback.fromQaAgentId ?? (input.actorType === "agent" ? input.actorId : null),
          actor: {
            actorType: input.actorType,
            actorId: input.actorId,
          },
        });
      }
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
          payload: {
            qaFeedbackEventId: feedback.id,
            qaRunId: feedback.runId,
            issueId: feedback.issueId,
            commentId,
            qaFeedbackSummary: summarizeQaFeedbackForContext(feedback.body),
            recommendedNextAction: "Fix the QA feedback, update verification, and rerun QA before handing back.",
          },
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          contextSnapshot: {
            issueId: feedback.issueId,
            taskId: feedback.issueId,
            commentId,
            wakeCommentId: commentId,
            wakeReason: "qa_feedback",
            qaFeedbackEventId: feedback.id,
            qaRunId: feedback.runId,
            qaFeedbackSummary: summarizeQaFeedbackForContext(feedback.body),
            recommendedNextAction: "Fix the QA feedback, update verification, and rerun QA before handing back.",
          },
        });
      }
    }

    const sentAt = now();
    const [updated] = await db
      .update(qaFeedbackEvents)
      .set({
        status: input.approved ? "approved_for_dev" : "sent_to_dev",
        sentAt,
        createsBugIssue: Boolean(bugIssueId),
        bugIssueId,
        metadata: {
          ...metadata,
          developerVisible: true,
          approvedByUserId: input.approved && input.actorType === "user" ? input.actorId : null,
          approvedAt: input.approved ? sentAt.toISOString() : null,
          approvalNote: input.note ?? null,
          sentByActorType: input.actorType,
          sentByActorId: input.actorId,
          sentAt: sentAt.toISOString(),
          handoffCommentId: commentId,
          linkedIssueTitle: issue?.title ?? null,
          runTitle: detail?.run.title ?? metadata.runTitle ?? null,
        },
        updatedAt: now(),
      })
      .where(eq(qaFeedbackEvents.id, feedback.id))
      .returning();
    return updated;
  }

  async function approveFeedbackForDevelopers(feedbackId: string, input: { userId?: string | null; note?: string | null }) {
    const feedback = await getFeedback(feedbackId);
    if (!feedback) throw notFound("QA feedback not found");
    return dispatchQaFeedbackToDeveloper(feedback, {
      actorType: "user",
      actorId: input.userId ?? "board",
      note: input.note,
      approved: true,
    });
  }

  function buildFeedbackBody(
    detail: QaRunDetail,
    input: { agentBody?: string | null; targetAgentName?: string | null } = {},
  ) {
    const failed = detail.results.filter((result) => isFailure(result.status));
    const sanitizedNote = sanitizeQaAgentNote(input.agentBody);
    const strippedRawNote = Boolean(input.agentBody?.trim()) && !sanitizedNote;
    const lines = [`## QA feedback: ${detail.run.title}`, ""];
    lines.push("### Summary");
    lines.push(`- Result: ${failed.length} failing/blocking case${failed.length === 1 ? "" : "s"} from ${detail.results.length} result${detail.results.length === 1 ? "" : "s"}.`);
    lines.push(`- Runner: \`${detail.run.runnerType}\``);
    lines.push(`- Platform: \`${detail.run.platform}\``);
    if (input.targetAgentName) lines.push(`- Suspected owner: ${input.targetAgentName}`);
    lines.push("- Requested action: Fix the failures below, update or add coverage, and rerun QA before handing back.");
    if (detail.run.repo) lines.push(`- Repo: \`${detail.run.repo}\`${detail.run.pullNumber ? ` PR #${detail.run.pullNumber}` : ""}`);
    if (detail.run.headSha) lines.push(`- Head SHA: \`${detail.run.headSha}\``);

    lines.push("", "### Failures");
    if (failed.length === 0) {
      lines.push("- QA reported feedback without a failing result row. Use the QA note and run artifacts as the source of truth.");
    }
    for (const [index, result] of failed.entries()) {
      lines.push(`#### ${index + 1}. ${result.title}`);
      lines.push(`- Status: \`${result.status}\``);
      lines.push(`- Expected: ${result.expectedResult?.trim() || "Not recorded"}`);
      lines.push(`- Actual: ${result.actualResult?.trim() || "Not recorded"}`);
      lines.push(`- Failure reason: ${result.failureReason?.trim() || "Not recorded"}`);
    }
    if (sanitizedNote) {
      lines.push("", "### QA note");
      lines.push(sanitizedNote);
    } else if (strippedRawNote) {
      lines.push("", "### QA note");
      lines.push("QA supplied raw log/code output; it stays on the run/artifacts and is not copied into this handoff.");
    }
    if (detail.artifacts.length > 0) {
      lines.push("", "### Evidence");
      for (const artifact of detail.artifacts.slice(0, 10)) {
        lines.push(`- ${artifact.type}: ${artifact.title}${artifact.summary ? ` — ${artifact.summary}` : ""}${artifact.url ? ` (${artifact.url})` : ""}`);
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
      assertQaReportReady(detail);
      const issueContext = detail.run.issueId
        ? await db
            .select({
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              priority: issues.priority,
            })
            .from(issues)
            .where(eq(issues.id, detail.run.issueId))
            .then((rows) => rows[0] ?? null)
        : null;
      const report = runToReport(detail, issueContext);
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
          content: renderQaReportPdf(detail, issueContext),
        };
      }
      const jiraRow = await integrations.getByProvider(detail.run.companyId, "jira");
      if (!jiraRow || jiraRow.enabled !== "true") throw notFound("Jira integration is not configured or is disabled");
      const jira = createJiraClient(jiraRow.config as unknown as JiraConfig);
      const jiraIssue = await jira.createIssue(`QA Report: ${detail.run.title}`, report, input.jiraIssueType ?? "Task");
      return { format: "jira" as const, jiraIssue };
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
