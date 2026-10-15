// Persistence for model templates: named model whitelist presets a tenant
// reuses when provisioning API keys.
//
// The store is deliberately thin — validation lives in the console domain
// contracts, and this layer only owns tenant-scoped reads and writes. Name
// uniqueness per tenant is enforced by the `model_templates_tenant_name_uidx`
// unique index; the console layer translates the resulting unique violation
// into a 409, so a duplicate name can never slip in through a race.
import { and, asc, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../db-handle";
import { modelTemplates, type ModelTemplate } from "../schema";

export type { ModelTemplate };

export interface ModelTemplateCreate {
  readonly name: string;
  readonly models: readonly string[];
}

export interface ModelTemplatePatch {
  readonly name?: string;
  readonly models?: readonly string[];
}

export class DrizzleModelTemplateStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  /** Every template the tenant owns, name-sorted for a stable console list. */
  async list(tenantId: string): Promise<ModelTemplate[]> {
    return this.db
      .select()
      .from(modelTemplates)
      .where(eq(modelTemplates.tenantId, tenantId))
      .orderBy(asc(modelTemplates.name));
  }

  async create(tenantId: string, input: ModelTemplateCreate): Promise<ModelTemplate> {
    const rows = await this.db
      .insert(modelTemplates)
      .values({ tenantId, name: input.name, models: [...input.models] })
      .returning();
    return rows[0]!;
  }

  async get(tenantId: string, templateId: string): Promise<ModelTemplate | undefined> {
    const rows = await this.db
      .select()
      .from(modelTemplates)
      .where(and(eq(modelTemplates.tenantId, tenantId), eq(modelTemplates.id, templateId)))
      .limit(1);
    return rows[0];
  }

  async update(
    tenantId: string,
    templateId: string,
    patch: ModelTemplatePatch,
  ): Promise<ModelTemplate | undefined> {
    const rows = await this.db
      .update(modelTemplates)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.models !== undefined ? { models: [...patch.models] } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(modelTemplates.tenantId, tenantId), eq(modelTemplates.id, templateId)))
      .returning();
    return rows[0];
  }

  async remove(tenantId: string, templateId: string): Promise<boolean> {
    const rows = await this.db
      .delete(modelTemplates)
      .where(and(eq(modelTemplates.tenantId, tenantId), eq(modelTemplates.id, templateId)))
      .returning({ id: modelTemplates.id });
    return rows.length > 0;
  }
}
