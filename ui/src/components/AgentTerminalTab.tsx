import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { terminalApi, type TerminalMode } from "../api/terminal";
import { Loader2, Power, RotateCcw, TerminalSquare } from "lucide-react";

interface Props {
  companyId: string;
  agentId: string;
  adapterType: string;
}

type Status = "idle" | "connecting" | "running" | "exited" | "error";

function adapterCliLabel(adapterType: string): string {
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
      return "CLI";
  }
}

export function AgentTerminalTab({ companyId, agentId, adapterType }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [mode, setMode] = useState<TerminalMode>("cli");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const cliLabel = useMemo(() => adapterCliLabel(adapterType), [adapterType]);

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= 1) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }, []);

  const connect = useCallback(
    (selectedMode: TerminalMode) => {
      const term = termRef.current;
      if (!term) return;
      setErrorMsg(null);
      setStatus("connecting");
      disconnect();

      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${scheme}://${window.location.host}/api/companies/${companyId}/agents/${agentId}/terminal/ws`;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "start",
            mode: selectedMode,
            cols: term.cols,
            rows: term.rows,
          }),
        );
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as { type: string; [k: string]: unknown };
            if (msg.type === "ready") {
              setStatus("running");
            } else if (msg.type === "exit") {
              setStatus("exited");
              term.write(
                `\r\n\x1b[33m[session exited code=${msg.code ?? "?"}${msg.signal ? ` signal=${msg.signal}` : ""}]\x1b[0m\r\n`,
              );
            } else if (msg.type === "error") {
              setStatus("error");
              setErrorMsg(typeof msg.message === "string" ? msg.message : "error");
              term.write(`\r\n\x1b[31m[error: ${msg.message}]\x1b[0m\r\n`);
            }
          } catch {
            // ignore unrecognized text
          }
          return;
        }
        // Binary output
        const data = new Uint8Array(ev.data as ArrayBuffer);
        term.write(data);
      };

      ws.onerror = () => {
        setStatus("error");
        setErrorMsg("WebSocket error");
      };

      ws.onclose = () => {
        setStatus((prev) => (prev === "exited" ? prev : "idle"));
      };
    },
    [companyId, agentId, disconnect],
  );

  // Initialize xterm once
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#0b0b0f",
        foreground: "#e4e4e7",
      },
      scrollback: 10000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      // ignore
    }
    term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(new TextEncoder().encode(data));
    });
    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        // ignore
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount, probe for an existing session. If one is running, reattach.
  // Otherwise auto-launch a CLI session so the user doesn't have to click Start
  // and doesn't have to type `claude`/`codex` themselves — the agent's CLI is
  // the whole point of opening this tab.
  useEffect(() => {
    let cancelled = false;
    void terminalApi
      .getSession(companyId, agentId)
      .then((res) => {
        if (cancelled) return;
        if (res.session && res.session.status === "running") {
          setMode(res.session.mode);
          connect(res.session.mode);
        } else {
          connect("cli");
        }
      })
      .catch(() => {
        if (!cancelled) connect("cli");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, agentId]);

  const handleStart = () => connect(mode);
  const handleRestart = async () => {
    try {
      await terminalApi.closeSession(companyId, agentId);
    } catch {
      // ignore
    }
    disconnect();
    setTimeout(() => connect(mode), 200);
  };
  const handleClose = async () => {
    try {
      await terminalApi.closeSession(companyId, agentId);
    } catch {
      // ignore
    }
    disconnect();
    setStatus("idle");
  };

  const statusPill = (() => {
    switch (status) {
      case "running":
        return <span className="text-xs rounded-full bg-green-500/10 text-green-500 px-2 py-0.5">running</span>;
      case "connecting":
        return (
          <span className="text-xs rounded-full bg-blue-500/10 text-blue-500 px-2 py-0.5 inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> connecting
          </span>
        );
      case "exited":
        return <span className="text-xs rounded-full bg-amber-500/10 text-amber-500 px-2 py-0.5">exited</span>;
      case "error":
        return <span className="text-xs rounded-full bg-red-500/10 text-red-500 px-2 py-0.5">error</span>;
      default:
        return <span className="text-xs rounded-full bg-neutral-500/10 text-neutral-400 px-2 py-0.5">idle</span>;
    }
  })();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Interactive Terminal</h3>
          {statusPill}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
            <button
              type="button"
              className={`px-2.5 py-1 ${mode === "cli" ? "bg-accent text-foreground" : "text-muted-foreground"}`}
              onClick={() => setMode("cli")}
              disabled={status === "running" || status === "connecting"}
            >
              CLI ({cliLabel})
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 ${mode === "shell" ? "bg-accent text-foreground" : "text-muted-foreground"}`}
              onClick={() => setMode("shell")}
              disabled={status === "running" || status === "connecting"}
            >
              Shell
            </button>
          </div>
          {status === "running" || status === "connecting" ? (
            <>
              <Button variant="outline" size="sm" onClick={handleRestart}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restart
              </Button>
              <Button variant="outline" size="sm" onClick={handleClose}>
                <Power className="h-3.5 w-3.5 mr-1" /> Close
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={handleStart}>
              Start
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Runs in the agent's workspace with its persona, identity and COMBYNE_API_KEY. Tool calls still go through
        Combyne's RBAC and business logic just like a heartbeat run.
      </p>
      {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
      <div
        ref={containerRef}
        className="h-[70vh] min-h-[420px] w-full rounded-md border border-border bg-[#0b0b0f] p-2"
      />
    </div>
  );
}

