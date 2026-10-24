/**
 * Model-template save applies, and sync respects exclusions.
 *
 * Saving a changed template list must apply it to every linked key right
 * away (the edit is the apply, not a draft), while keys that must keep
 * their own list are left alone: the infra/checkout labels and the retired
 * bansos pools, mirroring the template sweep's exclusion list. A name-only
 * edit syncs nothing.
 *
 * Everything runs against in-memory fake stores, so the suite checks the
 * domain rules rather than the database.
 */
import { describe, expect, test } from "bun:test";
import { createModelTemplateOperations } from "../../src/console/model-templates/routes";
import type { ModelTemplate } from "../../src/persistence/stores/model-template-store";
import type { ApiKeyRecord } from "../../src/persistence/stores/api-key-store";

const TENANT = "tenant-1";
const TEMPLATE_ID = "template-1";

const access = {
  id: "operator",
  tenantId: TENANT,
  scopes: ["dashboard:write"] as const,
  admissionIdentity: "operator",
};

const accessResolver = () => access;

function templateRecord(models: readonly string[]): ModelTemplate {
  return {
    id: TEMPLATE_ID,
    tenantId: TENANT,
    name: "tiprouter new",
    models: [...models],
    createdAt: new Date("2026-10-24T00:00:00Z"),
    updatedAt: new Date("2026-10-24T00:00:00Z"),
  };
}

function keyRecord(
  id: string,
  label: string,
  extra: Partial<ApiKeyRecord> = {},
): ApiKeyRecord {
  return {
    id,
    tenantId: TENANT,
    keyHash: null,
    keyMode: "personal",
    label,
    enabled: true,
    scopes: [],
    isDefault: false,
    modelList: ["old-model"],
    ...extra,
  } as ApiKeyRecord;
}

function setup(models: readonly string[], keys: ApiKeyRecord[]) {
  let template = templateRecord(models);
  const keyState = new Map(keys.map((key) => [key.id, key]));
  const updates: { id: string; modelList: readonly string[] }[] = [];
  const store = {
    list: async () => [template],
    create: async () => template,
    get: async () => template,
    update: async (_tenantId: string, _id: string, patch: { name?: string; models?: readonly string[] }) => {
      template = { ...template, ...(patch.name ? { name: patch.name } : {}), ...(patch.models ? { models: [...patch.models] } : {}) };
      return template;
    },
    remove: async () => true,
  };
  const apiKeyStore = {
    listByModelTemplate: async () => [...keyState.values()],
    update: async (_tenantId: string, keyId: string, patch: { modelList?: readonly string[] }) => {
      const current = keyState.get(keyId);
      if (!current) return undefined;
      const next = { ...current, ...(patch.modelList ? { modelList: [...patch.modelList] } : {}) };
      keyState.set(keyId, next);
      updates.push({ id: keyId, modelList: next.modelList as readonly string[] });
      return next;
    },
  };
  const operations = createModelTemplateOperations({
    store: store as never,
    apiKeyStore: apiKeyStore as never,
    accessResolver: accessResolver as never,
  });
  return { operations, keyState, updates };
}

describe("model template sync exclusions", () => {
  test("manual sync updates buyers but skips excluded labels, revoked, children, and share keys", async () => {
    const buyer = keyRecord("k-buyer", "buyer@example.com");
    const { operations, keyState, updates } = setup(["a", "b"], [
      buyer,
      keyRecord("k-checkout", "tiprouter-checkout"),
      keyRecord("k-deepseek", "bansos-deepseek-3b"),
      keyRecord("k-bansos", "bansos"),
      keyRecord("k-master", "MASTER KEY"),
      keyRecord("k-revoked", "revoked@example.com", { revokedAt: new Date() }),
      keyRecord("k-child", "child@example.com", { parentKeyId: "k-buyer" }),
      keyRecord("k-share", "share@example.com", { keyMode: "share" }),
    ]);
    const res = await operations.syncTemplate(access, TEMPLATE_ID);
    expect(res.updatedKeys.map((key) => key.id)).toEqual(["k-buyer"]);
    expect(res.skippedCount).toBe(7);
    expect(updates).toEqual([{ id: "k-buyer", modelList: ["a", "b"] }]);
    expect(keyState.get("k-checkout")?.modelList).toEqual(["old-model"]);
    expect(keyState.get("k-deepseek")?.modelList).toEqual(["old-model"]);
  });

  test("editing the model list auto-applies to linked keys, skipping excluded labels", async () => {
    const buyer = keyRecord("k-buyer", "buyer@example.com");
    const { operations, keyState } = setup(["a", "b"], [
      buyer,
      keyRecord("k-checkout", "tiprouter-checkout"),
    ]);
    const res = await operations.updateTemplate(access, TEMPLATE_ID, {
      name: "tiprouter new",
      models: ["a", "c"],
    });
    expect(res.models).toEqual(["a", "c"]);
    expect(res.sync?.updatedKeys.map((key) => key.id)).toEqual(["k-buyer"]);
    expect(res.sync?.skippedCount).toBe(1);
    expect(keyState.get("k-buyer")?.modelList).toEqual(["a", "c"]);
    expect(keyState.get("k-checkout")?.modelList).toEqual(["old-model"]);
  });

  test("a name-only edit carries no sync and touches no key", async () => {
    const buyer = keyRecord("k-buyer", "buyer@example.com");
    const { operations, keyState, updates } = setup(["a", "b"], [buyer]);
    const res = await operations.updateTemplate(access, TEMPLATE_ID, {
      name: "renamed",
    });
    expect(res.name).toBe("renamed");
    expect(res.sync).toBeUndefined();
    expect(updates).toEqual([]);
    expect(keyState.get("k-buyer")?.modelList).toEqual(["old-model"]);
  });

  test("a reorder-only edit is not a model change and syncs nothing", async () => {
    const buyer = keyRecord("k-buyer", "buyer@example.com");
    const { operations, updates } = setup(["a", "b"], [buyer]);
    const res = await operations.updateTemplate(access, TEMPLATE_ID, {
      models: ["b", "a"],
    });
    expect(res.sync).toBeUndefined();
    expect(updates).toEqual([]);
  });
});
