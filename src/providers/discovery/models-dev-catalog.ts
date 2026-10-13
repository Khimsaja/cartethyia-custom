import compiledModels from "./base-models.json";

/** Billing metadata from the prebuilt models.dev base catalog. */
export interface ModelsDevModelCost {
  readonly input: number | null;
  readonly output: number | null;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly reasoning?: number;
  readonly pricing_model: "pay-per-use" | "subscription" | "unknown";
}

/** Canonical model metadata from the prebuilt base catalog. */
export interface ModelsDevModelMetadata {
  readonly id: string;
  readonly name?: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly cost: ModelsDevModelCost;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly reasoning: boolean;
  readonly toolCall: boolean;
}

type CompactRow = readonly [
  number,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  BaseCost,
];

interface CompiledCatalog {
  readonly providers: readonly string[];
  readonly modalities: readonly string[];
  readonly rows: readonly CompactRow[];
  readonly bareOrder: readonly number[];
  readonly globalCosts: Readonly<Record<string, number>>;
}

interface BaseCost {
  readonly input?: number;
  readonly output?: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly reasoning?: number;
}

const BASE_MODELS = compiledModels as unknown as CompiledCatalog;

function modalityList(mask: number): readonly string[] {
  return BASE_MODELS.modalities.filter((_, index) => (mask & (1 << index)) !== 0);
}

const UNKNOWN_COST: ModelsDevModelCost = {
  input: null,
  output: null,
  pricing_model: "unknown",
};

/**
 * Removes a trailing release date from a model id, in either spelling the
 * catalog uses: `-YYYY-MM-DD` (`gpt-4o-2024-11-20`) or `-YYYYMMDD`
 * (`claude-haiku-4-5-20251001`). A dated snapshot bills the same rate as the
 * model it snapshots, so both forms must reach the same row.
 */
function stripDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

/**
 * Suffixes a reseller appends to a model id it republishes unchanged.
 *
 * OpenRouter lists `deepseek/deepseek-v4.1-flash:free` and
 * `qwen/qwen3-coder:free` — the `:free` marks its own billing tier, not a
 * different model, so the underlying row is the one that carries the real
 * context and output limits. Left on, the id matched nothing and the discovered
 * model published `n/a` limits while the same id without the suffix resolved.
 *
 * `@variant` is the same idea (a pinned quantization or provider route). Open-
 * Router's leading `~` ("this id tracks the vendor's latest") needs no case
 * here: it sits before the `/`, so the bare-id lookup below already drops it.
 *
 * Stripped for *lookup only* — the id sent upstream is always the caller's.
 */
function stripVariantSuffix(modelId: string): string {
  return modelId.replace(/[:@][^/@:]*$/, "");
}

function pricingModel(cost: BaseCost): ModelsDevModelCost["pricing_model"] {
  return cost.input !== null || cost.output !== null ? "pay-per-use" : "unknown";
}

function toMetadata(row: CompactRow): ModelsDevModelMetadata {
  const [, id, name, context, output, inputMask, outputMask, flags, cost] = row;
  return {
    id,
    ...(name.length === 0 ? {} : { name }),
    contextLimit: context > 0 ? context : null,
    outputLimit: output > 0 ? output : null,
    cost: {
      input: cost.input ?? null,
      output: cost.output ?? null,
      ...(cost.cache_read === undefined ? {} : { cache_read: cost.cache_read }),
      ...(cost.cache_write === undefined ? {} : { cache_write: cost.cache_write }),
      ...(cost.reasoning === undefined ? {} : { reasoning: cost.reasoning }),
      pricing_model: pricingModel(cost),
    },
    modalities: {
      input: modalityList(inputMask),
      output: modalityList(outputMask),
    },
    reasoning: (flags & 1) !== 0,
    toolCall: (flags & 2) !== 0,
  };
}

function bareId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  return normalized.includes("/") ? normalized.slice(normalized.indexOf("/") + 1) : normalized;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Cartethyia provider id → the provider key models.dev files it under.
 *
 * Only ids that genuinely differ belong here, and each entry is backed by the
 * deployment's own upstream: `opencodeft` serves `opencode.ai/zen/v1`, and 78
 * of its 80 model ids also appear under models.dev's `opencode`. Without this
 * the exact lookup missed for every one of those models, so each fell through
 * to the bare lookup — which fails closed when providers disagree — and the
 * entry was published with invented defaults.
 *
 * Deliberately absent: providers with no models.dev counterpart (a private
 * gateway, a BYOK endpoint) and any id whose match rests on model ids alone.
 * A shared model id is not proof of identity — the same generic id appears
 * under hundreds of resellers — so a guess here would attribute a stranger's
 * limits to this gateway's serving, which is the exact failure this catalog's
 * disagreement rule exists to prevent.
 *
 * This table is for **metadata** (limits, modalities), where a wrong row is
 * harmful and failing closed is right. Pricing does not need it: see
 * `globalCostFor`, which falls back to the model's own rate when the routed
 * provider has none of its own.
 */
const MODELS_DEV_PROVIDER_IDS: Readonly<Record<string, string>> = {
  opencodeft: "opencode",
  opencodezen: "opencode",
  opencodego: "opencode-go",
  ollamacloud: "ollama-cloud",
  xiaomipg: "xiaomi-token-plan-sgp",
  xiaomitp: "xiaomi-token-plan-cn",
  // Cartethyia ids that are shorter than the name models.dev files the provider
  // under. Without these the exact lookup misses for every model, and each row
  // falls through to the bare lookup — which fails closed when providers
  // disagree about the id — so the catalog would publish invented defaults.
  github: "github-copilot",
  // Discovery-backed aggregators whose models.dev key is spelled differently.
  // `qianfan` and `helmcode` are deliberately absent: models.dev files no rows
  // for either, and an entry pointing at a provider the catalog does not carry
  // would make every lookup miss and publish invented limits.
  siliconflowcn: "siliconflow-cn",
  nanogpt: "nano-gpt",
  novita: "novita-ai",
  together: "togetherai",
  wafer: "wafer.ai",
  // The Token Plan and the mainland DashScope host. Each points at the key
  // models.dev files the *same* service under, so without these every one of
  // their rows missed the exact lookup and fell through to the bare one, which
  // fails closed when providers disagree about an id that resellers share.
  //
  // `cloudflareai` is deliberately absent: the gateway files its rows as
  // `anthropic/claude-opus-5` while the provider dispatches the bare
  // `claude-opus-5`, so the exact lookup misses under either key. An entry here
  // would only restate the miss.
  alibabacp: "alibaba-token-plan",
  dashscope: "alibaba-coding-plan-cn",
};

/**
 * Resolves model metadata and pricing exclusively from the prebuilt base
 * catalog shipped with Cartethyia. Runtime network access is intentionally
 * absent: deployed instances use the exact catalog selected at build time.
 */
export class ModelsDevCatalog {
  private readonly rows = BASE_MODELS.rows;
  private readonly providerIndexes = new Map(
    BASE_MODELS.providers.map((provider, index) => [provider.trim().toLowerCase(), index]),
  );
  /**
   * Bare model id → the price the catalog records for the model itself,
   * independent of which provider filed it.
   *
   * Pricing is a property of the model, not of the reseller: a gateway that
   * republishes `grok-4.7` bills the model's rate even though the catalog filed
   * that id under `xai`. Metadata stays provider-specific and fail-closed on
   * disagreement, but a price is needed for every routed request.
   */
  private readonly globalCosts = BASE_MODELS.globalCosts;
  /** Metadata objects created for rows that were actually queried. */
  private readonly metadataCache = new Map<number, ModelsDevModelMetadata>();

  private metadataAt(index: number): ModelsDevModelMetadata | undefined {
    const cached = this.metadataCache.get(index);
    if (cached) return cached;
    const row = this.rows[index];
    if (row === undefined) return undefined;
    const metadata = toMetadata(row);
    this.metadataCache.set(index, metadata);
    return metadata;
  }

  private exactIndex(provider: string, modelId: string): number {
    const providerIndex = this.providerIndexes.get(provider);
    if (providerIndex === undefined) return -1;
    let low = 0;
    let high = this.rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const row = this.rows[middle];
      if (row === undefined) return -1;
      const comparison = row[0] - providerIndex || compareText(row[1].trim().toLowerCase(), modelId);
      if (comparison <= 0) low = middle + 1;
      else high = middle;
    }
    const candidate = this.rows[low - 1];
    return candidate?.[0] === providerIndex && candidate[1].trim().toLowerCase() === modelId
      ? low - 1
      : -1;
  }

  private bareRange(modelId: string): readonly [number, number] {
    const order = BASE_MODELS.bareOrder;
    let low = 0;
    let high = order.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const rowIndex = order[middle];
      const row = rowIndex === undefined ? undefined : this.rows[rowIndex];
      if (row === undefined || compareText(bareId(row[1]), modelId) < 0) low = middle + 1;
      else high = middle;
    }
    const start = low;
    while (low < order.length) {
      const rowIndex = order[low];
      const row = rowIndex === undefined ? undefined : this.rows[rowIndex];
      if (row === undefined || bareId(row[1]) !== modelId) break;
      low += 1;
    }
    return [start, low];
  }

  private metadataForBare(modelId: string): ModelsDevModelMetadata[] {
    const [start, end] = this.bareRange(modelId);
    return BASE_MODELS.bareOrder
      .slice(start, end)
      .flatMap((index) => {
        const metadata = this.metadataAt(index);
        return metadata === undefined ? [] : [metadata];
      });
  }

  /**
   * Resolves metadata for one model id.
   *
   * An exact `provider:model` hit always wins — it is the only lookup that
   * names the provider actually serving the request. The bare-id fallback is
   * used only when it is **unambiguous**: if the base catalog recorded the id
   * under several providers with different facts, no row can be called the
   * model's own, so the answer is `undefined` and the caller keeps its own
   * declared limits instead of inheriting a stranger's.
   *
   * Callers that know the provider should pass it; passing `""` opts into the
   * bare lookup, which is why it fails closed on disagreement.
   */
  resolve(providerId: string, modelId: string): ModelsDevModelMetadata | undefined {
    const provider = providerId.trim().toLowerCase();
    const normalizedModel = modelId.trim().toLowerCase();
    // Try the id as given, then its models.dev filing name. The mapped name is
    // a second chance, not a replacement: an id that already matches exactly
    // must keep winning, or a future provider added upstream under our own id
    // would be shadowed by the mapping.
    const exact =
      this.metadataAt(this.exactIndex(provider, normalizedModel)) ??
      this.metadataAt(this.exactIndex(MODELS_DEV_PROVIDER_IDS[provider] ?? "", normalizedModel));
    if (exact) return exact;
    // A reseller suffix (`:free`, `@variant`) is the reseller's, not the
    // model's: retry the exact lookup without it before falling through to the
    // bare id. Doing this here rather than in `stripVariantSuffix` alone keeps
    // the *provider-scoped* match — `openrouter:deepseek/deepseek-v4.1-flash`
    // resolves to OpenRouter's own row instead of whichever reseller happens to
    // file that bare id.
    const unsuffixed = stripVariantSuffix(normalizedModel);
    if (unsuffixed !== normalizedModel) {
      const unsuffixedExact =
        this.metadataAt(this.exactIndex(provider, unsuffixed)) ??
        this.metadataAt(this.exactIndex(MODELS_DEV_PROVIDER_IDS[provider] ?? "", unsuffixed));
      if (unsuffixedExact) return unsuffixedExact;
    }
    const bareModelId = bareId(normalizedModel);
    const bare = this.unambiguousBare(bareModelId);
    if (bare) return bare;
    const strippedDate = stripDateSuffix(bareModelId);
    if (strippedDate !== bareModelId) {
      const dated = this.unambiguousBare(strippedDate);
      if (dated) return dated;
    }
    // Last chance: the bare id may carry a reseller suffix of its own
    // (`provider/model:free` → bare `model:free`).
    const unsuffixedBare = stripVariantSuffix(bareModelId);
    if (unsuffixedBare !== bareModelId && unsuffixedBare !== strippedDate) {
      return this.unambiguousBare(unsuffixedBare);
    }
    return undefined;
  }

  /**
   * The single row for `bareId`, or `undefined` when the catalog disagrees
   * about it. Two rows that agree on every reported fact are interchangeable,
   * so the first is returned rather than treating agreement as ambiguity.
   */
  private unambiguousBare(bareId: string): ModelsDevModelMetadata | undefined {
    const rows = this.metadataForBare(bareId);
    const first = rows[0];
    if (first === undefined) return undefined;
    if (rows.length === 1) return first;
    const signature = (m: ModelsDevModelMetadata): string =>
      JSON.stringify([m.contextLimit, m.outputLimit, m.cost, m.modalities]);
    const expected = signature(first);
    for (const row of rows) {
      if (signature(row) !== expected) return undefined;
    }
    return first;
  }

  /**
   * The most widely agreed row for `bareId`, or `undefined` when nothing
   * records it.
   *
   * `resolve`/`unambiguousBare` fail closed on any disagreement, which is right
   * when the caller can leave a limit unstated. A caller that must publish a
   * number for a model the catalog knows about but disagrees on — a roster
   * whose own upstream reports nothing, where the alternative is a fixed
   * default — is better served by the majority answer: 18 of 19 rows file
   * `claude-opus-5` as 1000000/128000, and the single dissenter (a reseller's
   * 64k output cap) is the outlier, not the model.
   *
   * The vote is per-field and only among rows that state the field, so a row
   * omitting `output` cannot win that field by abstaining. Ties resolve to the
   * larger value: a limit stated too low truncates a caller's work, while one
   * stated too high is caught by the provider.
   */
  majorityFor(modelId: string): { contextLimit: number; outputLimit: number } | undefined {
    const normalized = modelId.trim().toLowerCase();
    const bare = bareId(normalized);
    // The bare index is keyed by the id as filed, so a dated spelling needs its
    // undated form tried too (the global cost index seeds both; this one does
    // not). Merge rather than pick: both spellings name the same model.
    const rows = [
      ...this.metadataForBare(bare),
      ...(stripDateSuffix(bare) === bare ? [] : this.metadataForBare(stripDateSuffix(bare))),
    ];
    if (rows.length === 0) return undefined;
    const vote = (values: ReadonlyArray<number | null>): number | undefined => {
      const counts = new Map<number, number>();
      for (const value of values) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      let best: number | undefined;
      let bestCount = 0;
      for (const [value, count] of counts) {
        if (count > bestCount || (count === bestCount && best !== undefined && value > best)) {
          best = value;
          bestCount = count;
        }
      }
      return best;
    };
    const contextLimit = vote(rows.map((row) => row.contextLimit));
    const outputLimit = vote(rows.map((row) => row.outputLimit));
    if (contextLimit === undefined && outputLimit === undefined) return undefined;
    return {
      contextLimit: contextLimit ?? outputLimit ?? 0,
      outputLimit: outputLimit ?? contextLimit ?? 0,
    };
  }

  /**
   * The price to bill for `modelId`, preferring the routed provider's own row.
   *
   * Unlike {@link resolve}, this does **not** fail closed when the provider has
   * no row: a gateway that republishes a model without publishing its own rate
   * still owes a cost, and the model's own global rate is the honest answer.
   * `resolve` keeps its fail-closed metadata rule — a wrong context limit is
   * harmful, while a missing price makes every request on that route read
   * `$0.00` as if it were measured.
   */
  costFor(providerId: string, modelId: string): ModelsDevModelCost {
    if (modelId.trim().length === 0 && providerId.trim().length === 0) return UNKNOWN_COST;
    const own = this.resolve(providerId, modelId)?.cost;
    if (own && (typeof own.input === "number" || typeof own.output === "number")) return own;
    const normalized = modelId.trim().toLowerCase();
    const modelBareId = bareId(normalized);
    // The generated global index carries both spellings of a dated id.
    const globalIndex = Object.hasOwn(this.globalCosts, modelBareId)
      ? this.globalCosts[modelBareId]
      : undefined;
    const global = globalIndex === undefined ? undefined : this.metadataAt(globalIndex)?.cost;
    return global ?? own ?? UNKNOWN_COST;
  }
}

export const modelsDevCatalog = new ModelsDevCatalog();
