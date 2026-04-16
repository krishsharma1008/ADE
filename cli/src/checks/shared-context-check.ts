import type { CombyneConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

export async function sharedContextCheck(
  config: CombyneConfig,
): Promise<CheckResult> {
  const connectionString =
    config.database.mode === "postgres"
      ? config.database.connectionString
      : config.database.mode === "embedded-postgres"
        ? `postgres://combyne:combyne@127.0.0.1:${config.database.embeddedPostgresPort}/combyne`
        : null;

  if (!connectionString) {
    return {
      name: "Shared context",
      status: "warn",
      message: "No database configured — cannot verify shared-context tables",
      canRepair: false,
    };
  }

  try {
    const { createDb } = await import("@combyne/db");
    const { sql } = await import("drizzle-orm");
    const db = createDb(connectionString);

    const countOf = async (table: string): Promise<number | null> => {
      try {
        const rows = await db.execute(sql.raw(`SELECT COUNT(*)::text AS c FROM ${table}`));
        const first = (rows as unknown as Array<{ c: string }>)[0];
        return first ? Number(first.c) : 0;
      } catch {
        return null;
      }
    };

    const [transcripts, memory, handoffs, runs] = await Promise.all([
      countOf("agent_transcripts"),
      countOf("agent_memory"),
      countOf("agent_handoffs"),
      countOf("heartbeat_runs"),
    ]);

    if (transcripts === null || memory === null || handoffs === null) {
      return {
        name: "Shared context",
        status: "fail",
        message: "Shared-context tables missing — run the server once so migrations apply",
        canRepair: false,
        repairHint: "Start the server (`pnpm dev`) — migrations run automatically on boot",
      };
    }

    const runCount = runs ?? 0;

    if (runCount > 0 && transcripts === 0) {
      return {
        name: "Shared context",
        status: "warn",
        message: `Runs exist (${runCount}) but no transcript rows — agent-transcripts capture may be failing silently`,
        canRepair: false,
        repairHint: "Check server logs for 'appendTranscriptEntry' errors",
      };
    }

    if (runCount === 0) {
      return {
        name: "Shared context",
        status: "pass",
        message: "Shared-context tables present (no runs yet, nothing to verify end-to-end)",
      };
    }

    return {
      name: "Shared context",
      status: "pass",
      message: `Transcripts: ${transcripts}, memory: ${memory}, handoffs: ${handoffs} (${runCount} runs completed)`,
    };
  } catch (err) {
    return {
      name: "Shared context",
      status: "warn",
      message: `Could not verify shared-context tables: ${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "Ensure the database is running (`combyne doctor` → Database check should pass first)",
    };
  }
}
