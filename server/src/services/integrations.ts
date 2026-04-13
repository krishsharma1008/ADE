import { and, eq } from "drizzle-orm";
import type { Db } from "@combyne/db";
import { companyIntegrations } from "@combyne/db";
import type { IntegrationProvider } from "@combyne/shared";
import { notFound } from "../errors.js";

export function integrationService(db: Db) {
  return {
    async list(companyId: string) {
      return db
        .select()
        .from(companyIntegrations)
        .where(eq(companyIntegrations.companyId, companyId));
    },

    async getByProvider(companyId: string, provider: IntegrationProvider) {
      const rows = await db
        .select()
        .from(companyIntegrations)
        .where(
          and(
            eq(companyIntegrations.companyId, companyId),
            eq(companyIntegrations.provider, provider),
          ),
        );
      return rows[0] ?? null;
    },

    async getById(id: string) {
      const rows = await db
        .select()
        .from(companyIntegrations)
        .where(eq(companyIntegrations.id, id));
      return rows[0] ?? null;
    },

    async create(
      companyId: string,
      provider: IntegrationProvider,
      config: Record<string, unknown>,
      createdByUserId: string | null,
    ) {
      const [row] = await db
        .insert(companyIntegrations)
        .values({
          companyId,
          provider,
          config,
          createdByUserId,
        })
        .returning();
      return row;
    },

    async update(
      id: string,
      patch: { enabled?: string; config?: Record<string, unknown> },
    ) {
      const [row] = await db
        .update(companyIntegrations)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(companyIntegrations.id, id))
        .returning();
      if (!row) throw notFound("Integration not found");
      return row;
    },

    async delete(id: string) {
      const [row] = await db
        .delete(companyIntegrations)
        .where(eq(companyIntegrations.id, id))
        .returning();
      if (!row) throw notFound("Integration not found");
      return row;
    },
  };
}
