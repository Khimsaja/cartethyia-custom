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
  type ModelTemplateUpdateResponse,
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

/**
 * Labels the template sync never touches, mirroring the template sweep's
 * exclusion list: the infra keys (minting/checkout/admin) plus the retired
 * shared bansos pools. A key carrying one of these labels keeps its own list
 * even when it is linked to the template — unlinking is not required to opt
 * out. Unlinked keys are skipped by construction (only linked keys sync).
 * Infra labels match exactly, as in the sweep; the bansos family matches
 * case-insensitively.
 */
const SYNC_EXCLUDED_LABELS: ReadonlySet<string> = new Set([
  "agent-manager",
  "admin",
  "agent-master",
  "tiprouter-auth (website)",
  "admin hermes",
  "tiprouter-bot (automation)",
  "tiprouter-checkout",
  "MASTER KEY",
]);

function isSyncExcludedLabel(label: string): boolean {
  if (SYNC_EXCLUDED_LABELS.has(label)) return true;
  const lower = label.toLowerCase();
  return lower === "bansos" || lower === "bansos-web" || lower.startsWith("bansos-deepseek-");
}

/** Order-insensitive model-list equality (the sweep compares the same way). */
function sameModelSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((model) => set.has(model));
}

/**
 * Pushes a template's current model list onto every linked key that is
 * eligible for it. Shared by the manual sync endpoint and by the automatic
 * apply that runs when a template's model list is edited.
 */
/**
 * Applies `fn` to `items` with at most `limit` in flight, preserving result
 * order. Template syncs used to await one key update after another, so a
 * template linked to 1000+ keys held the PATCH open for minutes; bounded
 * parallelism keeps the same per-key semantics while leaving DB-pool
 * headroom for buyer traffic (pool is 40).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

// Per-key apply parallelism for template syncs (see mapWithConcurrency).
const TEMPLATE_SYNC_CONCURRENCY = 12;

async function pushTemplateToLinkedKeys(
  config: ModelTemplateConfig,
  tenantId: string,
  template: { id: string; name: string; models: readonly string[] },
  access: AccessDecision,
): Promise<ModelTemplateSyncResponse> {
  const linked = await config.apiKeyStore.listByModelTemplate(tenantId, template.id);
  const eligible = linked.filter(
    (key) =>
      key.revokedAt === undefined &&
      key.parentKeyId === undefined &&
      key.keyMode === "personal" &&
      !isSyncExcludedLabel(key.label),
  );
  const results = await mapWithConcurrency(eligible, TEMPLATE_SYNC_CONCURRENCY, async (key) => {
    const updated = await config.apiKeyStore.update(tenantId, key.id, {
      modelAccessMode: "whitelist",
      modelList: [...template.models],
    });
    if (!updated) return undefined;
    // The model list is an auth-snapshot field: drop the cached snapshot
    // so the new list governs the key's very next request.
    invalidateApiKeyCache(key.id);
    return { id: key.id, label: key.label };
  });
  const updatedKeys = results.filter(
    (result): result is { id: string; label: string } => result !== undefined,
  );
  const skippedCount = linked.length - updatedKeys.length;
  await config.auditSink?.record({
    access,
    action: "model_template.synced",
    target: template.id,
    detail: { name: template.name, updated: updatedKeys.length, skipped: skippedCount },
  });
  return { templateId: template.id, updatedKeys, skippedCount };
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
    ): Promise<ModelTemplateUpdateResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const request = parseUpdateModelTemplateRequest(body);
      const before = await config.store.get(authorized.tenantId, templateId);
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
      // Saving a changed model list applies it to every linked key right
      // away — the template edit is the apply, not a draft waiting for a
      // second click. A name-only edit syncs nothing.
      const modelsChanged =
        request.models !== undefined &&
        before !== undefined &&
        !sameModelSet(before.models, record.models);
      if (!modelsChanged) {
        return toModelTemplateResponse(record);
      }
      const sync = await pushTemplateToLinkedKeys(
        config,
        authorized.tenantId,
        record,
        authorized,
      );
      return { ...toModelTemplateResponse(record), sync };
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
     * Pushes the template's current model list onto every linked key.
     * Manual re-apply: since edits already auto-apply on save, this exists
     * to repair drift (a key whose list was changed behind the template's
     * back). Only live top-level personal keys are rewritten — revoked keys,
     * share children, and excluded labels (infra/checkout/retired bansos
     * pools) keep their lists.
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
      return pushTemplateToLinkedKeys(config, authorized.tenantId, template, authorized);
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
