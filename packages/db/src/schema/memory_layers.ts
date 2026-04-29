import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  real,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Layered memory store for the 4-layer context system.
 *
 * Layers persisted here:
 *   - workspace: team/domain knowledge, owned by company
 *   - personal:  user/agent overlay; can shadow workspace at retrieval, never writes to it
 *   - shared:    cross-team distilled memory (promoted from workspace/personal via review)
 *
 * Layer A (Core execution) is ephemeral — built per-task from live state and never persisted.
 *
 * Embeddings are stored as `real[]` to keep the schema portable across embedded
 * Postgres test rigs that don't ship pgvector. Cosine similarity is computed
 * in the service layer; the call sites are isolated so swapping in pgvector
 * later is a one-file change.
 */
export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    layer: text("layer").notNull(), // 'workspace' | 'personal' | 'shared'
    ownerType: text("owner_type"), // 'user' | 'agent' | null (workspace/shared)
    ownerId: uuid("owner_id"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    kind: text("kind").notNull().default("fact"), // fact | runbook | convention | pointer | note
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    serviceScope: text("service_scope"),
    source: text("source"),
    embedding: jsonb("embedding").$type<number[] | null>(),
    status: text("status").notNull().default("active"), // active | archived | deprecated
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ttlDays: integer("ttl_days"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLayerIdx: index("memory_entries_company_layer_idx").on(table.companyId, table.layer),
    ownerIdx: index("memory_entries_owner_idx").on(
      table.companyId,
      table.ownerType,
      table.ownerId,
    ),
    statusIdx: index("memory_entries_status_idx").on(table.companyId, table.status),
    serviceIdx: index("memory_entries_service_idx").on(table.companyId, table.serviceScope),
  }),
);

/**
 * Promotion proposals: workspace/personal entries proposed for shared layer.
 * Auto-distill creates rows in 'pending'; board operator approves/rejects.
 */
export const memoryPromotions = pgTable(
  "memory_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceEntryId: uuid("source_entry_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    proposedSubject: text("proposed_subject").notNull(),
    proposedBody: text("proposed_body").notNull(),
    proposedTags: jsonb("proposed_tags").$type<string[]>().notNull().default([]),
    proposedKind: text("proposed_kind").notNull().default("fact"),
    proposerType: text("proposer_type").notNull(), // 'system' | 'agent' | 'user'
    proposerId: text("proposer_id"),
    state: text("state").notNull().default("pending"), // pending | approved | rejected
    reviewerId: text("reviewer_id"),
    reviewNotes: text("review_notes"),
    promotedEntryId: uuid("promoted_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => ({
    companyStateIdx: index("memory_promotions_company_state_idx").on(
      table.companyId,
      table.state,
    ),
    sourceIdx: index("memory_promotions_source_idx").on(table.sourceEntryId),
  }),
);

/**
 * Per-retrieval usage events. Drives recency boost in the ranker and
 * the auto-distill heuristic (entries hit by N distinct tasks become
 * promotion candidates).
 */
export const memoryUsage = pgTable(
  "memory_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => memoryEntries.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    score: real("score"),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entryIdx: index("memory_usage_entry_idx").on(table.entryId),
    companyIssueIdx: index("memory_usage_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
