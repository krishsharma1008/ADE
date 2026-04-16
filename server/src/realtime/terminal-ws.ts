import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { agentApiKeys, companyMemberships, instanceUserRoles } from "@combyne/db";
import type { DeploymentMode } from "@combyne/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import {
  attachWriter,
  closeSession,
  createTerminalSession,
  detachWriter,
  getActiveSessionForAgent,
  getSessionById,
  resizeSession,
  startTerminalSessionReaper,
  toSessionInfo,
  writeStdin,
  type TerminalMode,
} from "../services/terminal-sessions.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string | Buffer): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  agentId: string;
  actorType: "board" | "agent";
  actorId: string;
}

type AuthFailureReason =
  | "missing_token"
  | "invalid_token"
  | "session_missing"
  | "company_access_denied"
  | "agent_mismatch";

type AuthorizeResult =
  | { ok: true; context: UpgradeContext }
  | { ok: false; reason: AuthFailureReason };

function httpStatusForReason(reason: AuthFailureReason): { status: number; line: string; message: string } {
  switch (reason) {
    case "missing_token":
    case "session_missing":
      return { status: 401, line: "401 Unauthorized", message: "unauthorized" };
    case "invalid_token":
    case "company_access_denied":
    case "agent_mismatch":
      return { status: 403, line: "403 Forbidden", message: "forbidden" };
  }
}

interface IncomingMessageWithContext extends IncomingMessage {
  combyneTerminalUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newRequestId() {
  return Math.random().toString(36).slice(2, 10);
}

function rejectUpgrade(
  socket: Duplex,
  statusLine: string,
  message: string,
  reqId?: string,
) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  const reqHeader = reqId ? `X-Request-Id: ${reqId}\r\n` : "";
  socket.write(
    `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n${reqHeader}\r\n${safe}`,
  );
  socket.destroy();
}

function parsePath(pathname: string): { companyId: string; agentId: string } | null {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/agents\/([^/]+)\/terminal\/ws$/);
  if (!match) return null;
  try {
    return {
      companyId: decodeURIComponent(match[1] ?? ""),
      agentId: decodeURIComponent(match[2] ?? ""),
    };
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  agentId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<AuthorizeResult> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        ok: true,
        context: { companyId, agentId, actorType: "board", actorId: "board" },
      };
    }
    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return { ok: false, reason: "missing_token" };
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return { ok: false, reason: "session_missing" };

    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    const hasCompanyMembership = memberships.some((row) => row.companyId === companyId);
    if (!roleRow && !hasCompanyMembership) {
      return { ok: false, reason: "company_access_denied" };
    }
    return {
      ok: true,
      context: { companyId, agentId, actorType: "board", actorId: userId },
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key) return { ok: false, reason: "invalid_token" };
  if (key.companyId !== companyId) return { ok: false, reason: "company_access_denied" };
  if (key.agentId !== agentId) return { ok: false, reason: "agent_mismatch" };
  return {
    ok: true,
    context: { companyId, agentId, actorType: "agent", actorId: key.agentId },
  };
}

interface ClientControlMessage {
  type: "start" | "resize" | "input" | "close";
  mode?: TerminalMode;
  cols?: number;
  rows?: number;
  data?: string;
}

function parseControlMessage(raw: Buffer): ClientControlMessage | null {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as ClientControlMessage;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setupTerminalWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  startTerminalSessionReaper(db);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).combyneTerminalUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    let session = getActiveSessionForAgent(context.companyId, context.agentId);
    if (session) {
      attachWriter(session, socket);
      try {
        socket.send(JSON.stringify({ type: "ready", session: toSessionInfo(session), attached: true }));
      } catch {
        // ignore
      }
    }

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Binary frame = stdin bytes to PTY
        if (!session) return;
        writeStdin(session, data.toString("utf8"));
        return;
      }
      const control = parseControlMessage(data);
      if (!control) return;
      if (control.type === "start") {
        if (session) {
          // Already running — just ack
          try {
            socket.send(
              JSON.stringify({ type: "ready", session: toSessionInfo(session), attached: true }),
            );
          } catch {
            /* ignore */
          }
          return;
        }
        const mode: TerminalMode = control.mode === "shell" ? "shell" : "cli";
        const cols = control.cols ?? 100;
        const rows = control.rows ?? 30;
        void createTerminalSession(db, {
          companyId: context.companyId,
          agentId: context.agentId,
          mode,
          cols,
          rows,
          openedBy: context.actorId,
        })
          .then((s) => {
            session = s;
            attachWriter(s, socket);
            try {
              socket.send(JSON.stringify({ type: "ready", session: toSessionInfo(s), attached: false }));
            } catch {
              /* ignore */
            }
          })
          .catch((err) => {
            logger.warn(
              { err, companyId: context.companyId, agentId: context.agentId },
              "failed to create terminal session",
            );
            try {
              socket.send(
                JSON.stringify({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            } catch {
              /* ignore */
            }
            socket.close(1011, "session create failed");
          });
        return;
      }
      if (control.type === "resize" && session) {
        resizeSession(session, control.cols ?? 100, control.rows ?? 30);
        return;
      }
      if (control.type === "input" && session && typeof control.data === "string") {
        writeStdin(session, control.data);
        return;
      }
      if (control.type === "close" && session) {
        void closeSession(db, session, "client requested");
        socket.close();
        return;
      }
    });

    socket.on("close", () => {
      if (session) detachWriter(session, socket);
    });

    socket.on("error", (err) => {
      logger.warn({ err, companyId: context.companyId, agentId: context.agentId }, "terminal ws client error");
      if (session) detachWriter(session, socket);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) return;
    const url = new URL(req.url, "http://localhost");
    const parsed = parsePath(url.pathname);
    if (!parsed) return; // not our endpoint — let other handlers handle it

    const reqId = newRequestId();

    void authorizeUpgrade(db, req, parsed.companyId, parsed.agentId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
    })
      .then((result) => {
        if (!result.ok) {
          const { line, message, status } = httpStatusForReason(result.reason);
          logger.info(
            {
              reqId,
              companyId: parsed.companyId,
              agentId: parsed.agentId,
              path: req.url,
              status,
              reason: result.reason,
            },
            "terminal websocket upgrade rejected",
          );
          rejectUpgrade(socket, line, message, reqId);
          return;
        }
        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.combyneTerminalUpgradeContext = result.context;
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error(
          { err, reqId, companyId: parsed.companyId, agentId: parsed.agentId, path: req.url },
          "failed terminal websocket upgrade authorization",
        );
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed", reqId);
      });
  });

  return wss;
}

// suppress unused import warning for getSessionById exported elsewhere
void getSessionById;
