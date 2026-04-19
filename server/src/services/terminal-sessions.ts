import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import {
  agentTerminalSessions,
  agents as agentsTable,
  companies as companiesTable,
} from "@combyne/db";
import { buildCombyneEnv } from "@combyne/adapter-utils/server-utils";
import { createLocalAgentJwt, ensureLocalAgentJwtSecretAtRuntime } from "../agent-auth-jwt.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { loadAssignedIssueQueue } from "./agent-queue.js";
import { loadRecentMemory, summarizeTerminalSessionAndPersist } from "./agent-memory.js";
import { getPendingHandoffBrief } from "./agent-handoff.js";
import { appendTranscriptEntry } from "./agent-transcripts.js";
import { loadCompanyProjectOverview } from "./agent-company-context.js";

const require = createRequire(import.meta.url);

// @lydell/node-pty provides prebuilt binaries so no node-gyp compile needed.
type PtyProcess = {
  pid: number;
  cols: number;
  rows: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      encoding?: string | null;
    },
  ): PtyProcess;
}

let cachedPty: NodePtyModule | null = null;
function loadPty(): NodePtyModule {
  if (cachedPty) return cachedPty;
  try {
    cachedPty = require("@lydell/node-pty") as NodePtyModule;
  } catch (err) {
    throw new Error(
      `Failed to load @lydell/node-pty: ${err instanceof Error ? err.message : String(err)}. ` +
        `Run 'pnpm install' in the repo root.`,
    );
  }
  return cachedPty;
}

export type TerminalMode = "cli" | "shell";

export interface TerminalSessionInfo {
  id: string;
  companyId: string;
  agentId: string;
  mode: TerminalMode;
  command: string;
  cwd: string;
  status: "running" | "closed" | "crashed";
  exitCode: number | null;
  startedAt: string;
}

interface WsLike {
  send(data: string | Buffer): void;
  readyState: number;
}

interface TerminalSession {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string;
  openedByUserId: string | null;
  mode: TerminalMode;
  command: string;
  cwd: string;
  pty: PtyProcess;
  buffer: string;
  writers: Set<WsLike>;
  lastActivityAt: number;
  closed: boolean;
  startedAt: string;
  logPath: string | null;
  logStream?: import("node:fs").WriteStream;
  // Ticketing: one session Issue per terminal session, one Comment per prompt turn.
  sessionIssueId: string | null;
  // Per-session stdin buffer used to detect "user committed a prompt line".
  // We only record trimmed lines on Enter; empty lines and /slash-commands are skipped.
  pendingInputLine: string;
  // Monotonic sequence for agent_transcripts rows written against this session.
  // Shared between user (stdin) turns and assistant (stdout flush) turns so
  // replaying the transcript reconstructs the conversation order.
  transcriptSeq: number;
  // Rolling stdout buffer flushed to a transcript row on ~idle or when it
  // grows large. Terminal output is naturally chunked into many tiny writes,
  // so we coalesce to avoid one DB row per byte.
  pendingOutputChunk: string;
  pendingOutputTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_BUFFER_BYTES = 256 * 1024;

// Idle timeout for an unattached terminal session (no WS writers) before the
// reaper kills it. Chris flagged the old 5-minute default as too short for
// real work — a human reading code or thinking between prompts would lose
// their session. The primary env var is COMBYNE_TERMINAL_IDLE_MS (ms);
// we still honour the legacy COMBYNE_TERMINAL_IDLE_GRACE_MS if set.
function resolveIdleGraceMs(): number {
  const primary = process.env.COMBYNE_TERMINAL_IDLE_MS?.trim();
  if (primary && !Number.isNaN(Number(primary))) {
    const n = Number(primary);
    if (n > 0) return n;
  }
  const legacy = process.env.COMBYNE_TERMINAL_IDLE_GRACE_MS?.trim();
  if (legacy && !Number.isNaN(Number(legacy))) {
    const n = Number(legacy);
    if (n > 0) return n;
  }
  return 30 * 60_000; // 30 minutes — room for a coffee + a long read of the output
}

const IDLE_GRACE_MS = resolveIdleGraceMs();

const sessionsByAgent = new Map<string, TerminalSession>(); // key: `${companyId}:${agentId}`
const sessionsById = new Map<string, TerminalSession>();

function agentKey(companyId: string, agentId: string) {
  return `${companyId}:${agentId}`;
}

function defaultCliCommand(adapterType: string): string | null {
  switch (adapterType) {
    case "claude_local":
      return "claude";
    case "codex_local":
      return "codex";
    case "cursor_local":
      return "cursor-agent";
    case "opencode_local":
      return "opencode";
    case "gemini_local":
      return "gemini";
    default:
      return null;
  }
}

// Mirrors claude-local / codex-local skill discovery so interactive terminal
// sessions have the same Combyne skills available as heartbeat runs.
const __thisFile = fileURLToPath(import.meta.url);
const __thisDir = path.dirname(__thisFile);
const COMBYNE_SKILLS_CANDIDATES = [
  path.resolve(__thisDir, "../../../../skills"), // dev: server/src/services -> repo/skills
  path.resolve(__thisDir, "../../../skills"),
  path.resolve(__thisDir, "../../skills"),
];

async function resolveCombyneSkillsDir(): Promise<string | null> {
  if (process.env.COMBYNE_SKILLS_DIR) {
    const ok = await fs
      .stat(process.env.COMBYNE_SKILLS_DIR)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (ok) return process.env.COMBYNE_SKILLS_DIR;
  }
  for (const candidate of COMBYNE_SKILLS_CANDIDATES) {
    const ok = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (ok) return candidate;
  }
  return null;
}

// Create a tmpdir with `.claude/skills/` symlinks — same shape buildSkillsDir
// produces in `packages/adapters/claude-local/src/server/execute.ts`.
async function buildClaudeSkillsDir(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "combyne-terminal-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const skillsDir = await resolveCombyneSkillsDir();
  if (!skillsDir) return tmp;
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.symlink(path.join(skillsDir, entry.name), path.join(target, entry.name));
    } catch {
      // ignore (e.g. already exists)
    }
  }
  return tmp;
}

function codexHomeDir(): string {
  const fromEnv = process.env.CODEX_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".codex");
}

// Symlink Combyne skills into ~/.codex/skills so `codex` discovers them — same
// contract as `ensureCodexSkillsInjected` in packages/adapters/codex-local.
async function ensureCodexSkillsInjected() {
  const skillsDir = await resolveCombyneSkillsDir();
  if (!skillsDir) return;
  const skillsHome = path.join(codexHomeDir(), "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(skillsHome, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) continue;
    try {
      await fs.symlink(path.join(skillsDir, entry.name), target);
    } catch (err) {
      logger.warn({ err, target }, "failed to inject codex skill");
    }
  }
}

function asStringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolField(value: unknown): boolean {
  return value === true;
}

/**
 * Build the Markdown block a terminal session injects as additional system
 * context. Gives the agent a bird's-eye view of the company, its current
 * assigned queue, any pending handoff brief, and the recent memory summary —
 * the same pieces heartbeat runs already get, so the interactive terminal
 * isn't a "raw Claude session" as Chris put it.
 *
 * Returns null if there's nothing meaningful to inject.
 */
export async function buildTerminalContextPreamble(
  db: Db,
  agent: { id: string; companyId: string; name: string; adapterType: string },
  opts: { reuseIssueId?: string | null } = {},
): Promise<{ body: string; title: string } | null> {
  const segments: string[] = [];

  // Company identity
  try {
    const company = await db
      .select({ id: companiesTable.id, name: companiesTable.name })
      .from(companiesTable)
      .where(eq(companiesTable.id, agent.companyId))
      .then((rows) => rows[0] ?? null);
    if (company) {
      segments.push(
        `# Combyne context\n\n` +
          `You are **${agent.name}** (${agent.adapterType}) working for **${company.name}** (${company.id}). ` +
          `This terminal session is a live REPL — anything you change on disk stays on disk, and any prompt line you type is recorded as a comment on the session issue.`,
      );
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "terminal preamble: failed to read company");
  }

  // Current assigned queue
  try {
    const queue = await loadAssignedIssueQueue(db, {
      companyId: agent.companyId,
      agentId: agent.id,
    });
    if (queue.items.length > 0) {
      segments.push(`# Your current task queue\n\n${queue.body}`);
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "terminal preamble: failed to load queue");
  }

  // Combyne-managed projects — fixes the "agent says project not found"
  // bug where the REPL only saw its on-disk workspace and was blind to
  // projects/workspaces created through the UI.
  try {
    const overview = await loadCompanyProjectOverview(db, agent.companyId);
    if (overview.body.length > 0) {
      segments.push(`# Company projects\n\n${overview.body}`);
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "terminal preamble: failed to load projects");
  }

  // Pending handoff brief (if any)
  try {
    const handoff = await getPendingHandoffBrief(db, agent.id, opts.reuseIssueId ?? null);
    if (handoff?.brief) {
      segments.push(`# Pending handoff brief\n\n${handoff.brief}`);
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "terminal preamble: failed to load handoff");
  }

  // Recent memory
  try {
    const memory = await loadRecentMemory(db, {
      companyId: agent.companyId,
      agentId: agent.id,
      limit: 6,
    });
    if (memory.length > 0) {
      const memoryBody = memory
        .map((row) => `## ${row.title ?? `${row.scope}/${row.kind}`}\n${row.body}`)
        .join("\n\n");
      const capped = memoryBody.length > 12000 ? `${memoryBody.slice(0, 12000)}\n…(truncated)` : memoryBody;
      segments.push(`# Recent memory\n\n${capped}`);
    }
  } catch (err) {
    logger.debug({ err, agentId: agent.id }, "terminal preamble: failed to load memory");
  }

  if (segments.length === 0) return null;
  return {
    title: "Combyne terminal context",
    body: segments.join("\n\n---\n\n"),
  };
}

// Resolve the command + args for an interactive CLI launch based on the
// agent's stored adapterConfig. Parallels the (non-interactive) `execute.ts`
// code paths but omits --print / exec flags so the REPL runs.
async function buildCliLaunch(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
  opts?: {
    resumeClaudeSessionId?: string | null;
    contextPreamble?: { body: string; title: string } | null;
  },
): Promise<{ command: string; args: string[]; extraEnv: Record<string, string>; notes: string[] } | null> {
  const notes: string[] = [];
  const extraEnv: Record<string, string> = {};

  if (adapterType === "claude_local") {
    const command = asStringField(adapterConfig.command) || "claude";
    const args: string[] = [];
    const model = asStringField(adapterConfig.model);
    const effort = asStringField(adapterConfig.effort);
    const chrome = asBoolField(adapterConfig.chrome);
    const resume = opts?.resumeClaudeSessionId ?? null;
    if (resume) {
      args.push("--resume", resume);
      notes.push(`--resume ${resume} (continuing prior Claude session)`);
    }
    // Always skip permissions in the interactive terminal so the user isn't
    // interrupted by approval prompts for every tool call — they're driving
    // their own REPL, not a headless heartbeat run.
    args.push("--dangerously-skip-permissions");
    notes.push("--dangerously-skip-permissions (forced for interactive terminal)");
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);

    // Inject combyne skills so /<skill> and the skill handlers are available.
    const skillsDir = await buildClaudeSkillsDir();
    args.push("--add-dir", skillsDir);
    notes.push(`--add-dir ${skillsDir}`);

    // Persona: append-system-prompt-file if the agent was configured with one,
    // concatenated with the Combyne context preamble so the terminal Claude
    // session boots up knowing the company, its queue, any pending handoff,
    // and its memory summary — instead of looking like a raw REPL.
    const instructionsFilePath = asStringField(adapterConfig.instructionsFilePath);
    let instructionsRaw = "";
    if (instructionsFilePath) {
      try {
        instructionsRaw = await fs.readFile(instructionsFilePath, "utf-8");
      } catch (err) {
        logger.warn({ err, instructionsFilePath }, "terminal: failed to load agent instructions");
      }
    }
    const preambleBody = opts?.contextPreamble?.body ?? "";
    const pathDirective = instructionsFilePath
      ? `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${path.dirname(instructionsFilePath)}/.`
      : "";
    const combinedSegments = [
      instructionsRaw ? `${instructionsRaw}${pathDirective}` : "",
      preambleBody,
    ].filter((s) => s.length > 0);
    if (combinedSegments.length > 0) {
      const combined = path.join(skillsDir, "agent-instructions.md");
      await fs.writeFile(combined, combinedSegments.join("\n\n---\n\n"), "utf-8");
      args.push("--append-system-prompt-file", combined);
      notes.push(`--append-system-prompt-file ${combined}`);
      if (preambleBody.length > 0) {
        notes.push(`combyne context preamble injected (${preambleBody.length} chars)`);
      }
    }
    return { command, args, extraEnv, notes };
  }

  if (adapterType === "codex_local") {
    const command = asStringField(adapterConfig.command) || "codex";
    const args: string[] = [];
    const model = asStringField(adapterConfig.model);
    const effort = asStringField(adapterConfig.modelReasoningEffort) || asStringField(adapterConfig.reasoningEffort);
    const search = asBoolField(adapterConfig.search);
    // Same rationale as claude above — force approval/sandbox bypass so the
    // interactive REPL doesn't halt on every shell call.
    args.push("--dangerously-bypass-approvals-and-sandbox");
    notes.push("--dangerously-bypass-approvals-and-sandbox (forced for interactive terminal)");
    if (search) args.push("--search");
    if (model) args.push("--model", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    await ensureCodexSkillsInjected();
    notes.push(`skills injected into ${path.join(codexHomeDir(), "skills")}`);
    return { command, args, extraEnv, notes };
  }

  if (adapterType === "cursor_local") {
    const command = asStringField(adapterConfig.command) || "cursor-agent";
    return { command, args: [], extraEnv, notes };
  }

  if (adapterType === "opencode_local") {
    const command = asStringField(adapterConfig.command) || "opencode";
    return { command, args: [], extraEnv, notes };
  }

  if (adapterType === "gemini_local") {
    const command = asStringField(adapterConfig.command) || "gemini";
    return { command, args: [], extraEnv, notes };
  }

  const fallback = defaultCliCommand(adapterType);
  if (!fallback) return null;
  return { command: fallback, args: [], extraEnv, notes };
}

function resolveShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/bash";
}

async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
}

async function resolveAgentRow(db: Db, companyId: string, agentId: string) {
  const row = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row;
}

function buildPtyEnv(agent: { id: string; companyId: string; adapterType: string }): Record<string, string> {
  const combyneEnv = buildCombyneEnv(agent);
  // Self-heal the JWT secret — same rationale as heartbeat: keeps terminal
  // sessions functional when the server didn't get to run the local-trusted
  // bootstrap (unusual boot paths, missing env).
  try {
    ensureLocalAgentJwtSecretAtRuntime();
  } catch (err) {
    logger.warn({ err, agentId: agent.id }, "terminal: failed to ensure JWT secret");
  }
  const authToken = createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, `terminal-${Date.now()}`);
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v;
  }
  // Strip claude-code nesting guards so spawned `claude` doesn't refuse to start.
  delete baseEnv.CLAUDECODE;
  delete baseEnv.CLAUDE_CODE_ENTRYPOINT;
  delete baseEnv.CLAUDE_CODE_SESSION;
  delete baseEnv.CLAUDE_CODE_PARENT_SESSION;
  const merged = { ...baseEnv, ...combyneEnv };
  if (authToken) merged.COMBYNE_API_KEY = authToken;
  merged.TERM = merged.TERM ?? "xterm-256color";
  merged.COLORTERM = merged.COLORTERM ?? "truecolor";
  return merged;
}

export async function createTerminalSession(
  db: Db,
  opts: {
    companyId: string;
    agentId: string;
    mode: TerminalMode;
    cols: number;
    rows: number;
    openedBy?: string | null;
    reuseIssueId?: string | null;
    resumeClaudeSessionId?: string | null;
  },
): Promise<TerminalSession> {
  const agent = await resolveAgentRow(db, opts.companyId, opts.agentId);
  if (!agent) throw new Error("agent not found");

  const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
  await ensureDir(cwd);

  let command: string;
  let args: string[];
  let extraEnv: Record<string, string> = {};
  const launchNotes: string[] = [];

  // Assemble the Combyne-awareness preamble before we spawn the CLI so
  // claude's --append-system-prompt-file can include it from turn zero.
  let contextPreamble: { body: string; title: string } | null = null;
  try {
    contextPreamble = await buildTerminalContextPreamble(
      db,
      {
        id: agent.id,
        companyId: agent.companyId,
        name: (agent as { name?: string }).name ?? agent.id,
        adapterType: agent.adapterType,
      },
      { reuseIssueId: opts.reuseIssueId ?? null },
    );
  } catch (err) {
    logger.warn({ err, agentId: agent.id }, "terminal: failed to build context preamble");
  }

  if (opts.mode === "cli") {
    const adapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const cli = await buildCliLaunch(agent.adapterType, adapterConfig, {
      resumeClaudeSessionId: opts.resumeClaudeSessionId ?? null,
      contextPreamble,
    });
    if (!cli) {
      // Unknown adapter — fall back to shell with a banner line.
      command = resolveShell();
      args = [];
      launchNotes.push(`No interactive CLI wired for adapter '${agent.adapterType}' — falling back to shell.`);
    } else {
      command = cli.command;
      args = cli.args;
      extraEnv = cli.extraEnv;
      launchNotes.push(...cli.notes);
    }
  } else {
    command = resolveShell();
    args = [];
  }

  const env = { ...buildPtyEnv(agent), ...extraEnv };
  const pty = loadPty().spawn(command, args, {
    name: "xterm-256color",
    cols: opts.cols || 100,
    rows: opts.rows || 30,
    cwd,
    env,
  });

  const id = randomUUID();
  const startedAt = new Date().toISOString();

  // Audit log path
  const logDir = path.resolve(os.homedir(), ".combyne", "logs", "terminal-sessions");
  await ensureDir(logDir);
  const logPath = path.join(logDir, `${id}.log`);
  const { createWriteStream } = await import("node:fs");
  const logStream = createWriteStream(logPath, { flags: "a" });
  logStream.write(`# session=${id} agent=${agent.id} company=${agent.companyId} mode=${opts.mode}\n`);
  logStream.write(`# command=${command} ${args.join(" ")}\n`);
  logStream.write(`# cwd=${cwd}\n`);
  logStream.write(`# startedAt=${startedAt}\n`);
  for (const note of launchNotes) logStream.write(`# note=${note}\n`);

  const session: TerminalSession = {
    id,
    companyId: agent.companyId,
    agentId: agent.id,
    agentName: (agent as { name?: string }).name ?? agent.id,
    openedByUserId: opts.openedBy ?? null,
    mode: opts.mode,
    command: `${command} ${args.join(" ")}`.trim(),
    cwd,
    pty,
    buffer: "",
    writers: new Set(),
    lastActivityAt: Date.now(),
    closed: false,
    startedAt,
    logPath,
    logStream,
    sessionIssueId: null,
    pendingInputLine: "",
    transcriptSeq: 1,
    pendingOutputChunk: "",
    pendingOutputTimer: null,
  };

  // Create a ticketing "session Issue" so the terminal shows up in the same
  // Issues list heartbeat runs use, and so each prompt turn can be appended as
  // a comment for audit. Non-fatal if it fails — the PTY still runs.
  // On Continue, `reuseIssueId` points at the existing session issue so we
  // keep a single audit trail across resumes.
  void (async () => {
    try {
      const svc = issueService(db);
      if (opts.reuseIssueId) {
        session.sessionIssueId = opts.reuseIssueId;
        const resumeNote = opts.resumeClaudeSessionId
          ? ` (resumed via \`claude --resume ${opts.resumeClaudeSessionId}\`)`
          : "";
        await svc.addComment(
          opts.reuseIssueId,
          `Terminal session continued${resumeNote} at ${startedAt}. New PTY session id \`${id}\`.`,
          { userId: opts.openedBy ?? undefined },
        );
        await svc.update(opts.reuseIssueId, { status: "in_progress" });
        logger.info(
          { sessionId: id, issueId: opts.reuseIssueId, agentId: agent.id },
          "terminal: session continued against existing issue",
        );
        return;
      }
      const niceDate = new Date(startedAt).toLocaleString();
      const issue = await svc.create(agent.companyId, {
        title: `Interactive terminal — ${session.agentName} — ${niceDate}`,
        description:
          `Interactive ${opts.mode === "cli" ? "CLI" : "shell"} terminal session opened against **${session.agentName}**.\n\n` +
          `- **Mode:** \`${opts.mode}\`\n` +
          `- **Command:** \`${session.command}\`\n` +
          `- **Workspace:** \`${cwd}\`\n` +
          `- **Session id:** \`${id}\`\n\n` +
          `Each natural-language prompt typed into this terminal is appended to this issue as a comment. ` +
          `Slash commands and empty lines are skipped. Tool calls made by the CLI still flow through Combyne's normal RBAC/middleware via the agent's \`COMBYNE_API_KEY\`.`,
        status: "in_progress",
        assigneeAgentId: agent.id,
        createdByUserId: opts.openedBy ?? null,
        originKind: "terminal_session",
        originId: id,
      });
      session.sessionIssueId = issue?.id ?? null;
      logger.info(
        { sessionId: id, issueId: session.sessionIssueId, agentId: agent.id },
        "terminal: session issue created",
      );
      // Surface the Combyne-awareness preamble on the session issue so the
      // user can see what context the agent was given. For claude this is
      // already injected via --append-system-prompt-file; for other CLIs
      // (codex/cursor/opencode) this comment is the only visible handle.
      if (session.sessionIssueId && contextPreamble?.body) {
        try {
          await svc.addComment(
            session.sessionIssueId,
            `**Combyne context loaded** (${contextPreamble.body.length} chars):\n\n<details><summary>Show preamble</summary>\n\n${contextPreamble.body}\n\n</details>`,
            { userId: opts.openedBy ?? undefined },
          );
        } catch (err) {
          logger.debug({ err, sessionId: id }, "terminal: failed to post preamble comment");
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId: id }, "terminal: failed to create session issue");
    }
  })();

  pty.onData((data) => {
    session.lastActivityAt = Date.now();
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER_BYTES) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_BYTES);
    }
    session.logStream?.write(data);
    // Coalesce stdout into transcript rows so we persist the conversation
    // for replay / memory summarization without one row per byte.
    bufferTranscriptOutput(session, data);
    const payload = Buffer.from(data, "utf8");
    for (const w of session.writers) {
      try {
        if (w.readyState === 1) w.send(payload);
      } catch (err) {
        logger.warn({ err, sessionId: id }, "terminal ws send failed");
      }
    }
  });

  pty.onExit(async ({ exitCode, signal }) => {
    session.closed = true;
    flushTranscriptOutput(session, "pty_exit");
    session.logStream?.end(`\n# exitCode=${exitCode} signal=${signal ?? ""}\n`);
    for (const w of session.writers) {
      try {
        if (w.readyState === 1) w.send(JSON.stringify({ type: "exit", code: exitCode, signal }));
      } catch {
        // ignore
      }
    }
    sessionsByAgent.delete(agentKey(session.companyId, session.agentId));
    sessionsById.delete(session.id);
    try {
      await db
        .update(agentTerminalSessions)
        .set({
          status: exitCode === 0 ? "closed" : "crashed",
          exitCode,
          endedAt: new Date(),
        })
        .where(eq(agentTerminalSessions.id, session.id));
    } catch (err) {
      logger.warn({ err, sessionId: id }, "failed to update terminal session on exit");
    }
  });

  sessionsByAgent.set(agentKey(session.companyId, session.agentId), session);
  sessionsById.set(id, session);
  dbBySession.set(session, db);

  try {
    await db.insert(agentTerminalSessions).values({
      id,
      companyId: agent.companyId,
      agentId: agent.id,
      mode: opts.mode,
      command: session.command,
      cwd,
      status: "running",
      logRef: logPath,
      openedBy: opts.openedBy ?? null,
    });
  } catch (err) {
    logger.warn({ err, sessionId: id }, "failed to insert terminal session row");
  }

  return session;
}

export function getActiveSessionForAgent(companyId: string, agentId: string): TerminalSession | null {
  return sessionsByAgent.get(agentKey(companyId, agentId)) ?? null;
}

export function getSessionById(id: string): TerminalSession | null {
  return sessionsById.get(id) ?? null;
}

export function attachWriter(session: TerminalSession, ws: WsLike) {
  session.writers.add(ws);
  // Replay backlog for reconnects.
  if (session.buffer.length > 0) {
    try {
      ws.send(Buffer.from(session.buffer, "utf8"));
    } catch {
      // ignore
    }
  }
}

export function detachWriter(session: TerminalSession, ws: WsLike) {
  session.writers.delete(ws);
}

export function writeStdin(session: TerminalSession, data: string) {
  if (session.closed) return;
  session.pty.write(data);
  session.logStream?.write(`<stdin>${data}</stdin>`);
  // Feed bytes into the per-session prompt buffer so we can ticket each turn.
  feedPromptBuffer(session, data);
}

// Set by createTerminalSession's db closure so the prompt-commit hook can call
// back into issueService without every call site threading a Db around.
const dbBySession = new WeakMap<TerminalSession, Db>();

// Track bytes the user is typing. When a line is committed (Enter), decide
// whether to record it as a prompt turn on the session issue.
function feedPromptBuffer(session: TerminalSession, data: string) {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!;
    const code = ch.charCodeAt(0);

    // Enter / Return → commit line
    if (ch === "\r" || ch === "\n") {
      const line = session.pendingInputLine;
      session.pendingInputLine = "";
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("/")) continue; // slash command — REPL internal, skip
      recordPromptTurn(session, trimmed);
      continue;
    }

    // Backspace / delete
    if (code === 0x7f || code === 0x08) {
      if (session.pendingInputLine.length > 0) {
        session.pendingInputLine = session.pendingInputLine.slice(0, -1);
      }
      continue;
    }

    // Ctrl-C / Ctrl-D / Ctrl-U etc. → clear the pending line, don't ticket it
    if (code === 0x03 || code === 0x04 || code === 0x15) {
      session.pendingInputLine = "";
      continue;
    }

    // ESC sequence (arrow keys, function keys, xterm bracketed paste markers,
    // OSC color-query responses, etc.). Fast-forward through the whole sequence
    // without feeding it into the pending line — otherwise terminal control
    // traffic corrupts our prompt buffer.
    if (code === 0x1b) {
      const next = data[i + 1];
      if (next === undefined) continue;
      i++;
      if (next === "[") {
        // CSI: ESC [ params ... final-byte (0x40-0x7E)
        while (i + 1 < data.length) {
          const b = data[++i]!.charCodeAt(0);
          if (b >= 0x40 && b <= 0x7e) break;
        }
        continue;
      }
      if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
        // String sequence (OSC / DCS / SOS / PM / APC): terminated by BEL (0x07)
        // or ST (ESC \\). Consume everything up to and including the terminator.
        while (i + 1 < data.length) {
          const b = data[++i]!.charCodeAt(0);
          if (b === 0x07) break;
          if (b === 0x1b) {
            if (i + 1 < data.length) i++; // swallow the trailing byte of ST
            break;
          }
        }
        continue;
      }
      // Two-byte ESC sequence (ESC =, ESC >, ESC M, etc.) — already consumed `next`.
      continue;
    }

    // Ignore other control bytes
    if (code < 0x20) continue;

    session.pendingInputLine += ch;

    // Hard cap so a runaway paste without newline doesn't consume memory.
    if (session.pendingInputLine.length > 8192) {
      session.pendingInputLine = session.pendingInputLine.slice(-8192);
    }
  }
}

function recordPromptTurn(session: TerminalSession, prompt: string) {
  const db = dbBySession.get(session);
  if (!db) return;
  const issueId = session.sessionIssueId;
  if (!issueId) return; // session issue not ready yet — drop, best-effort

  const body =
    `**Terminal prompt** (${new Date().toISOString()}):\n\n` +
    "```text\n" +
    prompt +
    "\n```";

  void (async () => {
    try {
      await issueService(db).addComment(issueId, body, {
        userId: session.openedByUserId ?? undefined,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId: session.id, issueId },
        "terminal: failed to record prompt turn as comment",
      );
    }
  })();

  // Also write a `user`-role transcript row so the agent's memory/handoff
  // pipelines pick up terminal interactions alongside heartbeat runs. Flush
  // any pending assistant output first so the ordering (user → assistant)
  // in agent_transcripts.seq matches reality.
  flushTranscriptOutput(session, "pre_user_turn");
  const seq = session.transcriptSeq++;
  void (async () => {
    try {
      await appendTranscriptEntry(db, {
        companyId: session.companyId,
        agentId: session.agentId,
        terminalSessionId: session.id,
        issueId,
        seq,
        role: "user",
        contentKind: "terminal.prompt",
        content: { message: prompt },
      });
    } catch (err) {
      logger.debug(
        { err, sessionId: session.id, issueId },
        "terminal: failed to write prompt transcript",
      );
    }
  })();
}

// Strip ANSI escape sequences + carriage returns so the persisted transcript
// text is readable when replayed. We keep raw bytes in the live buffer for WS
// writers — this only affects what's stored in agent_transcripts.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function cleanForTranscript(raw: string): string {
  const withoutAnsi = raw.replace(ANSI_PATTERN, "");
  return withoutAnsi.replace(/\r\n?/g, "\n");
}

const TRANSCRIPT_FLUSH_IDLE_MS = 1_500;
const TRANSCRIPT_FLUSH_MAX_BYTES = 8 * 1024;

function bufferTranscriptOutput(session: TerminalSession, chunk: string) {
  session.pendingOutputChunk += chunk;
  if (session.pendingOutputChunk.length >= TRANSCRIPT_FLUSH_MAX_BYTES) {
    flushTranscriptOutput(session, "size");
    return;
  }
  if (session.pendingOutputTimer) return;
  session.pendingOutputTimer = setTimeout(() => {
    session.pendingOutputTimer = null;
    flushTranscriptOutput(session, "idle");
  }, TRANSCRIPT_FLUSH_IDLE_MS).unref?.() as ReturnType<typeof setTimeout>;
}

function flushTranscriptOutput(session: TerminalSession, _reason: string) {
  if (session.pendingOutputTimer) {
    clearTimeout(session.pendingOutputTimer);
    session.pendingOutputTimer = null;
  }
  const raw = session.pendingOutputChunk;
  if (!raw) return;
  session.pendingOutputChunk = "";
  const cleaned = cleanForTranscript(raw).trim();
  if (!cleaned) return;
  const db = dbBySession.get(session);
  if (!db) return;
  const issueId = session.sessionIssueId;
  const seq = session.transcriptSeq++;
  void (async () => {
    try {
      await appendTranscriptEntry(db, {
        companyId: session.companyId,
        agentId: session.agentId,
        terminalSessionId: session.id,
        issueId: issueId ?? null,
        seq,
        role: "assistant",
        contentKind: "terminal.output",
        content: { message: cleaned.slice(0, 16_000) },
      });
    } catch (err) {
      logger.debug(
        { err, sessionId: session.id },
        "terminal: failed to write output transcript",
      );
    }
  })();
}

export function resizeSession(session: TerminalSession, cols: number, rows: number) {
  if (session.closed) return;
  try {
    session.pty.resize(Math.max(1, cols), Math.max(1, rows));
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "pty resize failed");
  }
}

export async function closeSession(db: Db, session: TerminalSession, reason = "closed") {
  if (session.closed) return;
  try {
    session.pty.kill();
  } catch {
    // ignore
  }
  session.closed = true;
  flushTranscriptOutput(session, `close_${reason}`);
  // Roll terminal conversation into agent_memory so the next heartbeat wake
  // sees a memory preamble that includes what just happened in the REPL.
  // Fire-and-forget; failures are logged inside the summarizer and must not
  // block the close path.
  void summarizeTerminalSessionAndPersist(db, {
    terminalSessionId: session.id,
    companyId: session.companyId,
    agentId: session.agentId,
    issueId: session.sessionIssueId,
  });
  session.logStream?.end(`\n# closed reason=${reason}\n`);
  sessionsByAgent.delete(agentKey(session.companyId, session.agentId));
  sessionsById.delete(session.id);
  try {
    await db
      .update(agentTerminalSessions)
      .set({ status: "closed", endedAt: new Date() })
      .where(and(eq(agentTerminalSessions.id, session.id), isNull(agentTerminalSessions.endedAt)));
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "failed to mark session closed");
  }

  // Close the ticketing side. If the session was idle-reaped, leave the issue
  // in `awaiting_user` so the UI can surface a Continue button that resumes
  // the PTY (and, for Claude, the model session via `claude --resume`).
  if (session.sessionIssueId) {
    const issueId = session.sessionIssueId;
    const idleClosed = reason === "idle";
    try {
      const svc = issueService(db);
      const message = idleClosed
        ? buildIdleCloseComment({ session, issueId })
        : `Terminal session closed (reason: \`${reason}\`) at ${new Date().toISOString()}.`;
      await svc.addComment(issueId, message, {
        userId: session.openedByUserId ?? undefined,
      });
      await svc.update(issueId, { status: idleClosed ? "awaiting_user" : "done" });
    } catch (err) {
      logger.warn(
        { err, sessionId: session.id, issueId },
        "terminal: failed to close session issue",
      );
    }
  }
}

/**
 * Build the comment body posted on the session issue when a terminal is
 * reaped for idle. Gives the user three explicit resume paths so nobody
 * is left guessing how to get back into the REPL:
 *   1. UI — the Continue button on this very issue
 *   2. API — a curl the user can paste in any shell
 *   3. CLI — the direct `claude --resume <sessionId>` fallback for the
 *      Claude adapter so power users can skip the round-trip
 * The server base URL is taken from COMBYNE_PUBLIC_URL when set, falling
 * back to the canonical local-trusted dev URL so copy/paste still works.
 */
function buildIdleCloseComment(input: {
  session: TerminalSession;
  issueId: string;
}): string {
  const baseUrl =
    process.env.COMBYNE_PUBLIC_URL?.trim().replace(/\/$/, "") ||
    `http://127.0.0.1:${process.env.PORT?.trim() || "3100"}`;
  const apiUrl = `${baseUrl}/api/companies/${input.session.companyId}/agents/${input.session.agentId}/terminal/continue`;
  const curlLine = [
    `curl -fsS -X POST '${apiUrl}'`,
    `  -H 'content-type: application/json'`,
    `  -d '${JSON.stringify({ issueId: input.issueId })}'`,
  ].join(" \\\n");
  const lines: string[] = [
    `Terminal session idle-closed at ${new Date().toISOString()} after ${Math.round(IDLE_GRACE_MS / 60_000)} min of inactivity.`,
    ``,
    `**Resume this session:**`,
    ``,
    `1. **UI** — click the **Continue** button on this issue.`,
    ``,
    `2. **API** — run:`,
    "   ```bash",
    `   ${curlLine}`,
    "   ```",
  ];
  // For Claude we also have the PTY session id — surface it as a
  // power-user shortcut. The user can point their own claude CLI at it
  // directly without going through the Combyne endpoint.
  if (input.session.command.startsWith("claude")) {
    lines.push(
      ``,
      `3. **Direct CLI** — from inside the workspace \`${input.session.cwd}\`:`,
      "   ```bash",
      `   claude --resume ${input.session.id} --dangerously-skip-permissions`,
      "   ```",
      `   _(This bypasses Combyne and talks to Claude directly; prompts won't be logged as comments.)_`,
    );
  }
  lines.push(
    ``,
    `Issue status moved to **awaiting_user** so the agent won't auto-wake until you reply or click Continue.`,
  );
  return lines.join("\n");
}

export function toSessionInfo(session: TerminalSession): TerminalSessionInfo {
  return {
    id: session.id,
    companyId: session.companyId,
    agentId: session.agentId,
    mode: session.mode,
    command: session.command,
    cwd: session.cwd,
    status: session.closed ? "closed" : "running",
    exitCode: null,
    startedAt: session.startedAt,
  };
}

// Idle reaper: kill sessions with no attached writers after IDLE_GRACE_MS.
let reaperStarted = false;
export function startTerminalSessionReaper(db: Db) {
  if (reaperStarted) return;
  reaperStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const session of sessionsById.values()) {
      if (session.writers.size > 0) continue;
      if (now - session.lastActivityAt >= IDLE_GRACE_MS) {
        void closeSession(db, session, "idle");
      }
    }
  }, 30_000).unref?.();
}

// For testing/introspection
export function listSessions(): TerminalSessionInfo[] {
  return Array.from(sessionsById.values()).map(toSessionInfo);
}

// Resume a previously-closed terminal session. Looks up the originating session
// id from the issue's origin fields, spawns a fresh PTY, and — for claude_local
// — passes `--resume <sessionId>` so the model context is preserved. For other
// adapters we start a fresh REPL (the agent-memory + handoff subsystems carry
// context across).
export async function continueTerminalSession(
  db: Db,
  opts: {
    companyId: string;
    agentId: string;
    issueId: string;
    mode?: TerminalMode;
    cols?: number;
    rows?: number;
    openedBy?: string | null;
  },
): Promise<TerminalSession> {
  const { issues: issuesTable } = await import("@combyne/db");
  const issue = await db
    .select()
    .from(issuesTable)
    .where(and(eq(issuesTable.id, opts.issueId), eq(issuesTable.companyId, opts.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw new Error("issue not found");
  if (issue.originKind !== "terminal_session" || !issue.originId) {
    throw new Error("issue is not a terminal-session issue");
  }

  // If a live session already exists for this agent, surface it rather than
  // spawning a second one; the writer will re-attach via the normal ws flow.
  const existing = getActiveSessionForAgent(opts.companyId, opts.agentId);
  if (existing && !existing.closed) {
    return existing;
  }

  const agent = await resolveAgentRow(db, opts.companyId, opts.agentId);
  if (!agent) throw new Error("agent not found");

  const priorSessionId = issue.originId;
  const resumeClaude = agent.adapterType === "claude_local" ? priorSessionId : null;

  return createTerminalSession(db, {
    companyId: opts.companyId,
    agentId: opts.agentId,
    mode: opts.mode ?? "cli",
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    openedBy: opts.openedBy ?? null,
    reuseIssueId: opts.issueId,
    resumeClaudeSessionId: resumeClaude,
  });
}

// suppress unused import warning — desc reserved for future queries
void desc;
