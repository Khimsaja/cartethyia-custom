import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { modelAliases, modelCombos, models, providers, tenants } from "../../../src/persistence/schema";
import { PublicModelCatalogStore } from "../../../src/console/providers/catalog/public-model-store";
import type { ApiKeyAuthorizationSnapshot } from "../../../src/security/api-key-auth";

/**
 * The public `/v1/models` surface, driven against a real catalog.
 *
 * The shadow filter is the one rule here that cannot be checked by reading the
 * allowlist: `isModelAllowed` matches a bare entry against every qualified
 * form on purpose (dispatch wants "this model, any provider"), so discovery
 * must subtract the qualified forms itself. These tests pin that subtraction
 * at the boundary the API key actually sees.
 */
dbDescribe("PublicModelCatalogStore — alias shadowing", () => {
  let db: CartethyiaDatabase;
  const tenantId = randomUUID();
  const nestedProvider = `shadow-nested-${randomUUID().slice(0, 8)}`;
  const bareProvider = `shadow-bare-${randomUUID().slice(0, 8)}`;
  const modelName = `shadow-model-${randomUUID().slice(0, 8)}`;
  const comboName = `shadow-pool-${randomUUID().slice(0, 8)}`;
  // A provider that nests a path of its own inside `modelId`. This is the shape
  // that used to escape the filter: its bare name equals the alias, but the
  // full `modelId` does not.
  const nestedModelId = `free/${modelName}`;

  function snapshot(overrides: Partial<ApiKeyAuthorizationSnapshot> = {}): ApiKeyAuthorizationSnapshot {
    return {
      api_key_id: randomUUID(),
      tenant_id: tenantId,
      model_allowlist: [modelName],
      model_denylist: null,
      ...overrides,
    };
  }

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "public-model-store-test", status: "active" })
      .onConflictDoNothing();
    await db.insert(providers).values([
      { id: nestedProvider, tenantId, enabled: true, requiresAccount: false },
      { id: bareProvider, tenantId, enabled: true, requiresAccount: false },
    ]);
    await db.insert(models).values([
      { providerId: nestedProvider, modelId: nestedModelId, wireFamily: "chat", endpointPath: "/v1/chat/completions", enabled: true },
      { providerId: bareProvider, modelId: modelName, wireFamily: "chat", endpointPath: "/v1/chat/completions", enabled: true },
    ]);
    // The alias targets a *combo*, not a qualified row — the shape an operator
    // actually configures. That matters: it means the alias never equals any
    // row's qualified id, so only the bare-name comparison can hide the
    // provider rows sharing its name.
    await db.insert(modelCombos).values({
      tenantId,
      name: comboName,
      members: [`${bareProvider}/${modelName}`],
      strategy: "fallback",
    });
    await db.insert(modelAliases).values({ tenantId, alias: modelName, targetModel: comboName });
  });

  afterAll(async () => {
    await db.delete(modelAliases).where(eq(modelAliases.tenantId, tenantId));
    await db.delete(modelCombos).where(eq(modelCombos.tenantId, tenantId));
    await db.delete(models).where(inArray(models.providerId, [nestedProvider, bareProvider]));
    await db.delete(providers).where(inArray(providers.id, [nestedProvider, bareProvider]));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("an allowlisted alias is the only entry, even when a provider nests the same bare name", async () => {
    const store = new PublicModelCatalogStore(db);
    const listed = await store.listPublicModels(tenantId, snapshot());

    expect(listed.map((m) => m.id)).toEqual([modelName]);
    expect(listed[0]?.owned_by).toBe("cartethyia");
    // The nested catalog row is the same route under another label; publishing
    // it would advertise a provider the operator never named.
    expect(listed.some((m) => m.id === `${nestedProvider}/${nestedModelId}`)).toBe(false);
    expect(listed.some((m) => m.id === `${bareProvider}/${modelName}`)).toBe(false);
  });

  test("an explicitly qualified allowlist entry is never shadowed", async () => {
    const store = new PublicModelCatalogStore(db);
    const listed = await store.listPublicModels(
      tenantId,
      snapshot({ model_allowlist: [modelName, `${nestedProvider}/${nestedModelId}`] }),
    );

    // Naming the exact row is an unambiguous grant, so both the alias and that
    // qualified row stay visible — only the unqualified sibling is hidden.
    expect(listed.map((m) => m.id)).toContain(`${nestedProvider}/${nestedModelId}`);
    expect(listed.map((m) => m.id)).toContain(modelName);
    expect(listed.some((m) => m.id === `${bareProvider}/${modelName}`)).toBe(false);
  });
});

/**
 * Limits and capabilities an alias or combo advertises.
 *
 * An alias commonly targets a *combo* name rather than a model, and a combo
 * member may itself be an alias or combo — the same chain dispatch resolves.
 * Reading only the immediate target finds no catalog row, so the entry falls
 * back to invented defaults (200k/64k) that understate the route and can make
 * a capable model look unusable to a client that reads `/v1/models`.
 */
dbDescribe("PublicModelCatalogStore — alias/combo metadata", () => {
  let db: CartethyiaDatabase;
  const tenantId = randomUUID();
  const poolProvider = `meta-pool-${randomUUID().slice(0, 8)}`;
  const deepProvider = `meta-deep-${randomUUID().slice(0, 8)}`;
  const aliasName = `meta-alias-${randomUUID().slice(0, 8)}`;
  const poolName = `meta-pool-combo-${randomUUID().slice(0, 8)}`;
  const nestedComboName = `meta-nested-${randomUUID().slice(0, 8)}`;
  const smallModel = `meta-small-${randomUUID().slice(0, 8)}`;
  const largeModel = `meta-large-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "public-model-store-meta-test", status: "active" })
      .onConflictDoNothing();
    await db.insert(providers).values([
      { id: poolProvider, tenantId, enabled: true, requiresAccount: false },
      { id: deepProvider, tenantId, enabled: true, requiresAccount: false },
    ]);
    await db.insert(models).values([
      {
        providerId: poolProvider,
        modelId: smallModel,
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        contextLimit: 300_000,
        outputLimit: 32_000,
        modalities: { input: ["text", "image"], output: ["text"] },
        enabled: true,
      },
      {
        providerId: deepProvider,
        modelId: largeModel,
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        contextLimit: 1_048_576,
        outputLimit: 131_072,
        modalities: { input: ["text"], output: ["text"] },
        enabled: true,
      },
    ]);
    // alias -> combo -> (model, alias -> combo -> model): the nested shape that
    // used to resolve to nothing.
    await db.insert(modelCombos).values([
      { tenantId, name: nestedComboName, members: [`${deepProvider}/${largeModel}`], strategy: "fallback" },
      { tenantId, name: poolName, members: [`${poolProvider}/${smallModel}`, nestedComboName], strategy: "fallback" },
    ]);
    await db.insert(modelAliases).values({ tenantId, alias: aliasName, targetModel: poolName });
  });

  afterAll(async () => {
    await db.delete(modelAliases).where(eq(modelAliases.tenantId, tenantId));
    await db.delete(modelCombos).where(eq(modelCombos.tenantId, tenantId));
    await db.delete(models).where(inArray(models.providerId, [poolProvider, deepProvider]));
    await db.delete(providers).where(inArray(providers.id, [poolProvider, deepProvider]));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("an alias targeting a combo mirrors the pool's real limits, not defaults", async () => {
    const store = new PublicModelCatalogStore(db);
    const listed = await store.listPublicModels(tenantId, {
      api_key_id: randomUUID(),
      tenant_id: tenantId,
      model_allowlist: [aliasName],
      model_denylist: null,
    });

    const entry = listed.find((m) => m.id === aliasName);
    expect(entry).toBeDefined();
    // The pool may route to either member, so the safe claim is the tighter
    // limit — 300k/32k, never the invented 200k/64k defaults.
    expect(entry?.context_length).toBe(300_000);
    expect(entry?.max_completion_tokens).toBe(32_000);
    // Only the modality every member shares survives; the large model is
    // text-only, so the image capability must not be advertised.
    expect(entry?.capabilities).toEqual({ input: ["text"], output: ["text"] });
  });

  test("a combo whose member is another combo resolves through to catalog rows", async () => {
    const store = new PublicModelCatalogStore(db);
    const listed = await store.listPublicModels(tenantId, {
      api_key_id: randomUUID(),
      tenant_id: tenantId,
      model_allowlist: [poolName],
      model_denylist: null,
    });

    const entry = listed.find((m) => m.id === poolName);
    expect(entry?.context_length).toBe(300_000);
    expect(entry?.max_completion_tokens).toBe(32_000);
  });
});

/**
 * The metadata a client parses off `/v1/models`.
 *
 * The surface used to publish only `context_length`/`max_completion_tokens`/
 * `capabilities`, so `reasoning`, `tool_call`, `web_search`, and `cost` — all
 * persisted on the `models` row — never reached a client. These tests pin the
 * whole emitted entry, including the normalized modality vocabulary.
 */
dbDescribe("PublicModelCatalogStore — emitted metadata", () => {
  let db: CartethyiaDatabase;
  const tenantId = randomUUID();
  const providerId = `meta-emit-${randomUUID().slice(0, 8)}`;
  const richModel = `rich-${randomUUID().slice(0, 8)}`;
  const plainModel = `plain-${randomUUID().slice(0, 8)}`;
  const systemoneModel = `sys-${randomUUID().slice(0, 8)}`;
  const aliasName = `emit-alias-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "public-model-store-emit-test", status: "active" })
      .onConflictDoNothing();
    await db
      .insert(providers)
      .values({ id: providerId, tenantId, enabled: true, requiresAccount: false });
    await db.insert(models).values([
      {
        providerId,
        modelId: richModel,
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        contextLimit: 1_048_576,
        outputLimit: 131_072,
        // Provider-native spelling: `document` and `file` must fold to `pdf`,
        // and an unknown token must be dropped rather than leaked.
        modalities: { input: ["text", "image", "document", "file", "hologram"], output: ["text"] },
        reasoning: true,
        toolCall: true,
        webSearch: true,
        cost: { input: 3, output: 15, cache_read: 0.3 },
        enabled: true,
      },
      {
        providerId,
        modelId: plainModel,
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        contextLimit: 8_192,
        outputLimit: 4_096,
        modalities: null,
        reasoning: false,
        toolCall: false,
        webSearch: false,
        cost: null,
        enabled: true,
      },
      {
        // A native-service row (System One) is not served on a chat wire; the
        // public list must label it so a chat client can tell it apart.
        providerId,
        modelId: systemoneModel,
        wireFamily: "chat",
        serviceKind: "systemone",
        endpointPath: "/zen/v1/systemone",
        contextLimit: 200_000,
        outputLimit: 8_192,
        modalities: { input: ["text"], output: ["text"] },
        reasoning: false,
        toolCall: false,
        webSearch: false,
        cost: null,
        enabled: true,
      },
    ]);
    await db.insert(modelAliases).values({ tenantId, alias: aliasName, targetModel: `${providerId}/${richModel}` });
  });

  afterAll(async () => {
    await db.delete(modelAliases).where(eq(modelAliases.tenantId, tenantId));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  function snapshot(): ApiKeyAuthorizationSnapshot {
    return {
      api_key_id: randomUUID(),
      tenant_id: tenantId,
      model_allowlist: [`${providerId}/${richModel}`, `${providerId}/${plainModel}`, `${providerId}/${systemoneModel}`, aliasName],
      model_denylist: null,
    };
  }

  test("a rich catalog row publishes reasoning/tool_call/web_search/cost and a normalized vocabulary", async () => {
    const store = new PublicModelCatalogStore(db);
    const listed = await store.listPublicModels(tenantId, snapshot());
    const entry = listed.find((m) => m.id === `${providerId}/${richModel}`);

    expect(entry).toBeDefined();
    expect(entry?.context_length).toBe(1_048_576);
    expect(entry?.max_completion_tokens).toBe(131_072);
    // `document`/`file` folded to `pdf`; `hologram` dropped.
    expect(entry?.capabilities).toEqual({ input: ["text", "image", "pdf"], output: ["text"] });
    expect(entry?.reasoning).toBe(true);
    expect(entry?.tool_call).toBe(true);
    expect(entry?.web_search).toBe(true);
    expect(entry?.cost).toEqual({ input: 3, output: 15, cache_read: 0.3 });
  });

  test("a native-service row is labelled with its service_kind", async () => {
    // A System One row is not served on the chat wire. Publishing its
    // `service_kind` lets a chat client label it instead of offering a route
    // that only answers `capability_unsupported`.
    const store = new PublicModelCatalogStore(db);
    const listed = await store.listPublicModels(tenantId, snapshot());
    const entry = listed.find((m) => m.id === `${providerId}/${systemoneModel}`);

    expect(entry).toBeDefined();
    expect(entry?.service_kind).toBe("systemone");
    // An ordinary chat row stays unlabelled (absence means `llm`).
    const chatEntry = listed.find((m) => m.id === `${providerId}/${richModel}`);
    expect(chatEntry?.service_kind).toBeUndefined();
  });

  test("a bare row omits capabilities and the false flags rather than publishing defaults", async () => {
    const store = new PublicModelCatalogStore(db);
    const listed = await store.listPublicModels(tenantId, snapshot());
    const entry = listed.find((m) => m.id === `${providerId}/${plainModel}`);

    expect(entry).toBeDefined();
    expect(entry?.capabilities).toBeUndefined();
    expect(entry?.reasoning).toBeUndefined();
    expect(entry?.tool_call).toBeUndefined();
    expect(entry?.web_search).toBeUndefined();
    expect(entry?.cost).toBeUndefined();
  });

  test("an alias mirrors its target's capability flags and cost", async () => {
    const store = new PublicModelCatalogStore(db);
    const listed = await store.listPublicModels(tenantId, snapshot());
    const entry = listed.find((m) => m.id === aliasName);

    expect(entry).toBeDefined();
    expect(entry?.owned_by).toBe("cartethyia");
    expect(entry?.reasoning).toBe(true);
    expect(entry?.tool_call).toBe(true);
    expect(entry?.web_search).toBe(true);
    expect(entry?.cost).toEqual({ input: 3, output: 15, cache_read: 0.3 });
    expect(entry?.capabilities).toEqual({ input: ["text", "image", "pdf"], output: ["text"] });
  });

  test("the detail route emits the same extended entry", async () => {
    const store = new PublicModelCatalogStore(db);
    const detail = await store.getPublicModelDetail(
      `${providerId}/${richModel}`,
      tenantId,
      snapshot(),
    );

    expect(detail?.reasoning).toBe(true);
    expect(detail?.tool_call).toBe(true);
    expect(detail?.web_search).toBe(true);
    expect(detail?.cost).toEqual({ input: 3, output: 15, cache_read: 0.3 });
    expect(detail?.capabilities).toEqual({ input: ["text", "image", "pdf"], output: ["text"] });
  });
});
