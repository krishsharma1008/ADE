// Central Context DB — Phase B (company-pin adoption glue, in-process core).
//
// `companies.id` is `defaultRandom()`, so every teammate who boots a local ops DB
// gets a DIFFERENT company UUID. The shared context rail, however, is addressed by
// ONE canonical company id (the team's id on the shared `companies` registry).
// Adopting that id locally — creating the local `companies` row at the SAME id — is
// what makes the local company id equal the shared team id, so memory routes by id.
//
// This module holds the testable, in-process upsert (`adoptPinnedCompany`) so it
// can be imported from BOTH the CLI (`server/scripts/company-pin.ts`, which re-
// exports it) and server runtime code (the onboarding "join an existing team"
// route) — `server/scripts` is not part of the compiled `src` rootDir, so the
// shared logic must live under `src`.

import { companies, type Db } from "@combyne/db";
import { eq } from "drizzle-orm";

// ---- Prefix-collision detection (the companies.ts helper is not exported) ----
function isIssuePrefixConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as Record<string, unknown>;
  if (
    e.code === "23505" &&
    (e.constraint === "companies_issue_prefix_idx" || e.constraint_name === "companies_issue_prefix_idx")
  ) {
    return true;
  }
  if ("cause" in e && e.cause) return isIssuePrefixConflict(e.cause);
  return typeof e.message === "string" && e.message.includes("companies_issue_prefix_idx");
}

function isPkConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as Record<string, unknown>;
  const constraint = String(e.constraint ?? e.constraint_name ?? "");
  if (
    e.code === "23505" &&
    (constraint.includes("companies_pkey") ||
      (typeof e.message === "string" && e.message.includes("companies_pkey")))
  ) {
    return true;
  }
  if ("cause" in e && e.cause) return isPkConflict(e.cause);
  return false;
}

export interface AdoptResult {
  id: string;
  name: string;
  status: string;
  issuePrefix: string;
  /** What the upsert did, for the caller's log + tests. */
  action: "inserted" | "kept" | "renamed";
}

/**
 * Idempotent adoption of the pinned company id. Testable in-process (no argv / no
 * process.exit). Two invariants:
 *  - B-PIN-4 (no silent clobber): an EXISTING pinned row keeps its name unless
 *    `forceRename` is passed; a re-run with a different name is a no-op by default.
 *  - B-PIN-3 (prefix-safe insert): a FRESH insert picks a unique, NON-default issue
 *    prefix derived from the UUID and retries on collision, so a local company that
 *    already holds the seeded default 'PAP' can't crash the UNIQUE prefix index.
 */
export async function adoptPinnedCompany(
  db: Db,
  opts: { id: string; name: string; forceRename?: boolean },
): Promise<AdoptResult> {
  const existing = await db.select().from(companies).where(eq(companies.id, opts.id)).limit(1);

  if (existing[0]) {
    const row = existing[0];
    if (row.name === opts.name) {
      return { ...row, action: "kept" } as AdoptResult;
    }
    if (opts.forceRename) {
      const [renamed] = await db
        .update(companies)
        .set({ name: opts.name, updatedAt: new Date() })
        .where(eq(companies.id, opts.id))
        .returning();
      return { ...renamed, action: "renamed" } as AdoptResult;
    }
    return { ...row, action: "kept" } as AdoptResult;
  }

  // Fresh insert with a derived, non-default prefix; retry on a benign prefix clash.
  const base = `PIN${opts.id.replace(/-/g, "").slice(0, 4).toUpperCase()}`; // e.g. PIN1A2B
  let persisted: typeof companies.$inferSelect | undefined;
  for (let attempt = 0; attempt < 10_000 && !persisted; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${"A".repeat(attempt)}`;
    try {
      [persisted] = await db
        .insert(companies)
        .values({ id: opts.id, name: opts.name, issuePrefix: candidate })
        .returning();
    } catch (err) {
      if (isIssuePrefixConflict(err)) continue; // benign clash → next candidate
      if (isPkConflict(err)) {
        // A concurrent create raced us to the pinned id — re-read the now-existing row.
        [persisted] = await db.select().from(companies).where(eq(companies.id, opts.id)).limit(1);
        break;
      }
      throw err;
    }
  }
  if (!persisted) {
    throw new Error("company-pin: unable to allocate a unique issue prefix for the pinned company");
  }
  return { ...persisted, action: "inserted" } as AdoptResult;
}
