// Console model-template domain: HTTP routes.
//
// Owns CRUD over a tenant's named model whitelist presets. Templates are a
// provisioning aid only: applying one in the console copies its model list
// into the API-key form, and nothing on the gateway path ever reads them.
import { Elysia } from "elysia";
import type { AccessDecision } from "../../security/access-control";
import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditSink } from "../audit/contracts";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../shared/errors";
import { isUniqueViolation } from "../../persistence/boot";
import type { DrizzleModelTemplateStore } from "../../persistence/stores/model-template-store";
import type { DrizzleApiKeyStore } from "../../persistence/stores/api-key-store";
import { invalidateApiKeyCache } from "../../security/api-key-auth";
import {
  parseCreateModelTemplateRequest,
  parseUpdateModelTemplateRequest,
  toModelTemplateResponse,
  type ModelTemplateResponse,
  type ModelTemplateSyncResponse,
} from "./contracts";

export interface ModelTemplateConfig {
  readonly store: DrizzleModelTemplateStore;
  readonly apiKeyStore: Pick<DrizzleApiKeyStore, "listByModelTemplate" | "update">;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}

/** The shared helper knows the PostgreSQL SQLSTATE; SQLite reports its own constraint codes/messages. */
function isTemplateNameTaken(error: unknown): boolean {
  if (isUniqueViolation(error)) return true;
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const code = "code" in current ? String(current.code) : "";
    if (code.startsWith("SQLITE_CONSTRAINT")) return true;
    if (current instanceof Error && /unique constraint/i.test(current.message)) return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

export function createModelTemplateOperations(config: ModelTemplateConfig) {
  return {
    async listTemplates(access: AccessDecision | undefined): Promise<ModelTemplateResponse[]> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const records = await config.store.list(authorized.tenantId);
      return records.map(toModelTemplateResponse);
    },

    async createTemplate(
      access: AccessDecision | undefined,
      body: unknown,
    ): Promise<ModelTemplateResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const request = parseCreateModelTemplateRequest(body);
      let record;
      try {
        record = await config.store.create(authorized.tenantId, request);
      } catch (error) {
        if (isTemplateNameTaken(error)) {
          throw new ConsoleDomainError(
            "template_name_taken",
            409,
            "A template with this name already exists",
          );
        }
        throw error;
      }
      await config.auditSink?.record({
        access: authorized,
        action: "model_template.created",
        target: record.id,
        detail: { name: record.name, modelCount: record.models.length },
      });
      return toModelTemplateResponse(record);
    },

    async updateTemplate(
      access: AccessDecision | undefined,
      templateId: string,
      body: unknown,
    ): Promise<ModelTemplateResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const request = parseUpdateModelTemplateRequest(body);
      let record;
      try {
        record = await config.store.update(authorized.tenantId, templateId, request);
      } catch (error) {
        if (isTemplateNameTaken(error)) {
          throw new ConsoleDomainError(
            "template_name_taken",
            409,
            "A template with this name already exists",
          );
        }
        throw error;
      }
      if (!record) {
        throw new ConsoleDomainError("template_not_found", 404, "No such model template");
      }
      await config.auditSink?.record({
        access: authorized,
        action: "model_template.updated",
        target: record.id,
        detail: { name: record.name, modelCount: record.models.length },
      });
      return toModelTemplateResponse(record);
    },

    async deleteTemplate(
      access: AccessDecision | undefined,
      templateId: string,
    ): Promise<{ success: true }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const removed = await config.store.remove(authorized.tenantId, templateId);
      if (!removed) {
        throw new ConsoleDomainError("template_not_found", 404, "No such model template");
      }
      await config.auditSink?.record({
        access: authorized,
        action: "model_template.deleted",
        target: templateId,
        detail: {},
      });
      return { success: true };
    },

    /**
     * Pushes the template's current model list onto every key linked to it.
     * This is the deliberate counterpart to create-time copying: the operator
     * edits the template, then explicitly applies it to keys already issued.
     * Only live top-level personal keys are rewritten — revoked keys, share
     * templates, and share children keep their lists (children follow their
     * parent, and a revoked key must not silently come back different).
     */
    async syncTemplate(
      access: AccessDecision | undefined,
      templateId: string,
    ): Promise<ModelTemplateSyncResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const template = await config.store.get(authorized.tenantId, templateId);
      if (!template) {
        throw new ConsoleDomainError("template_not_found", 404, "No such model template");
      }
      const linked = await config.apiKeyStore.listByModelTemplate(
        authorized.tenantId,
        templateId,
      );
      const updatedKeys: { id: string; label: string }[] = [];
      let skippedCount = 0;
      for (const key of linked) {
        if (key.revokedAt !== undefined || key.parentKeyId !== undefined || key.keyMode !== "personal") {
          skippedCount += 1;
          continue;
        }
        const updated = await config.apiKeyStore.update(authorized.tenantId, key.id, {
          modelAccessMode: "whitelist",
          modelList: [...template.models],
        });
        if (!updated) {
          skippedCount += 1;
          continue;
        }
        // The model list is an auth-snapshot field: drop the cached snapshot
        // so the new list governs the key's very next request.
        invalidateApiKeyCache(key.id);
        updatedKeys.push({ id: key.id, label: key.label });
      }
      await config.auditSink?.record({
        access: authorized,
        action: "model_template.synced",
        target: template.id,
        detail: { name: template.name, updated: updatedKeys.length, skipped: skippedCount },
      });
      return { templateId: template.id, updatedKeys, skippedCount };
    },
  };
}

export function createModelTemplateRoutes(config: ModelTemplateConfig): Elysia {
  const operations = createModelTemplateOperations(config);
  return new Elysia({ prefix: "/model-templates" })
    .get("/", async ({ request, set }) => {
      try {
        return await operations.listTemplates(config.accessResolver(request));
      } catch (error) {
        return errorResponse(error, set, "Model template operation failed");
      }
    })
    .post("/", async ({ request, body, set }) => {
      try {
        set.status = 201;
        return await operations.createTemplate(config.accessResolver(request), body);
      } catch (error) {
        return errorResponse(error, set, "Model template operation failed");
      }
    })
    .patch("/:templateId", async ({ request, params, body, set }) => {
      try {
        return await operations.updateTemplate(
          config.accessResolver(request),
          params.templateId,
          body,
        );
      } catch (error) {
        return errorResponse(error, set, "Model template operation failed");
      }
    })
    .delete("/:templateId", async ({ request, params, set }) => {
      try {
        return await operations.deleteTemplate(config.accessResolver(request), params.templateId);
      } catch (error) {
        return errorResponse(error, set, "Model template operation failed");
      }
    })
    .post("/:templateId/sync", async ({ request, params, set }) => {
      try {
        return await operations.syncTemplate(config.accessResolver(request), params.templateId);
      } catch (error) {
        return errorResponse(error, set, "Model template operation failed");
      }
    }) as unknown as Elysia;
}
