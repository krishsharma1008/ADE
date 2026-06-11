import { and, eq, count, notInArray, sql } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { companies, agents, issues } from "@combyne/db";

export function companyService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";

  function deriveIssuePrefixBase(name: string) {
    const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
    return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
  }

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function isIssuePrefixConflict(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;

    // Check the error itself (raw postgres driver)
    const e = error as Record<string, unknown>;
    if (e.code === "23505" && (e.constraint === "companies_issue_prefix_idx" || e.constraint_name === "companies_issue_prefix_idx")) {
      return true;
    }

    // Drizzle wraps postgres errors — check .cause as well
    if ("cause" in e && e.cause) {
      return isIssuePrefixConflict(e.cause);
    }

    // Also check the error message as a fallback
    if (typeof e.message === "string" && e.message.includes("companies_issue_prefix_idx")) {
      return true;
    }

    return false;
  }

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
    const base = deriveIssuePrefixBase(data.name);
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      try {
        const rows = await db
          .insert(companies)
          .values({ ...data, issuePrefix: candidate })
          .returning();
        return rows[0];
      } catch (error) {
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  return {
    list: () => db.select().from(companies),

    getById: (id: string) =>
      db
        .select()
        .from(companies)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null),

    create: async (data: typeof companies.$inferInsert) => createCompanyWithUniquePrefix(data),

    update: (id: string, data: Partial<typeof companies.$inferInsert>) =>
      db
        .update(companies)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    archive: (id: string) =>
      db.transaction(async (tx) => {
        const now = new Date();
        const company = await tx
          .update(companies)
          .set({
            status: "archived",
            pauseReason: "system",
            pausedAt: now,
            updatedAt: now,
          })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!company) return null;

        await tx
          .update(agents)
          .set({
            status: "paused",
            pauseReason: "system",
            pausedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(agents.companyId, id),
              notInArray(agents.status, ["terminated", "pending_approval"]),
            ),
          );

        return company;
      }),

    // Soft, reversible pause: blocks every new wakeup/run via isCompanyActive (status
    // must be "active") without archiving the company or terminating its agents. Pair
    // with heartbeat.cancelActiveForCompany() at the route to also stop in-flight runs.
    pause: (id: string, reason: string = "manual") =>
      db
        .update(companies)
        .set({
          status: "paused",
          pauseReason: reason,
          pausedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    resume: (id: string, data: Partial<typeof companies.$inferInsert> = {}) =>
      db
        .update(companies)
        .set({
          ...data,
          status: "active",
          pauseReason: null,
          pausedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // A hand-maintained dependency-ordered delete list rotted every time a
        // company-scoped table was added (live 2026-06-11: agent_transcripts and
        // issue_read_states 500'd the delete). Instead, discover every public
        // table carrying a company_id column and delete multi-pass: a table
        // whose delete is blocked by an inter-child FK simply succeeds on a
        // later pass once its dependents are gone. New company-scoped tables
        // are covered automatically.
        const discovered = await tx.execute<{ table_name: string }>(sql`
          SELECT DISTINCT table_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name = 'company_id'
            AND table_name <> 'companies'
        `);
        const discoveredRows =
          (discovered as unknown as { rows?: Array<{ table_name: string }> }).rows ??
          (discovered as unknown as Array<{ table_name: string }>);
        let remaining = discoveredRows.map((row) => row.table_name);
        for (let pass = 0; pass < 10 && remaining.length > 0; pass++) {
          const blocked: string[] = [];
          for (const tableName of remaining) {
            try {
              // Nested transaction = SAVEPOINT: a blocked DELETE must not abort
              // the outer transaction (Postgres poisons a tx after any error).
              await tx.transaction(async (sp) => {
                await sp.execute(
                  sql`DELETE FROM ${sql.identifier(tableName)} WHERE company_id = ${id}`,
                );
              });
            } catch {
              blocked.push(tableName);
            }
          }
          if (blocked.length === remaining.length) {
            // No progress — a cycle or a non-company-scoped dependent. Surface
            // the blockers instead of failing with a bare FK error.
            throw new Error(
              `Company delete blocked by foreign keys on: ${blocked.join(", ")}`,
            );
          }
          remaining = blocked;
        }
        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }),

    stats: () =>
      Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          .groupBy(issues.companyId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.companyId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.companyId]) {
            result[row.companyId].issueCount = row.count;
          } else {
            result[row.companyId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
