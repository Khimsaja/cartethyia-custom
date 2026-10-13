/**
 * Rebuilds the single generated models.dev catalog at
 * `src/providers/discovery/base-models.json`.
 *
 * Run manually when the catalog should be refreshed — never at server runtime.
 * `models-dev-catalog.ts` reads only the committed snapshot (no live `fetch`),
 * so the server never makes an outbound call to models.dev.
 *
 *   bun run scripts/generate/models-dev-snapshot.ts
 *
 * The snapshot is pruned to the fields the resolver reads and includes
 * generated lookup indexes. It is the only checked-in copy of this data;
 * neither the upstream payload nor an intermediate compact snapshot is kept.
 */
import path from "node:path";

const SNAPSHOT_PATH = path.join(import.meta.dir, "../../src/providers/discovery/base-models.json");
const SOURCE_URL = "https://models.dev/api.json";

interface RawCost {
  readonly input?: number;
  readonly output?: number;
  readonly cache_read?: number;
  readonly cache_write?: number;
  readonly reasoning?: number;
}

interface RawModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly reasoning?: unknown;
  readonly tool_call?: unknown;
  readonly cost?: RawCost;
}

interface SnapshotRow {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly context: number | null;
  readonly output: number | null;
  readonly input: readonly string[];
  readonly outputModalities: readonly string[];
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly cost: RawCost;
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
  RawCost,
];

interface CompiledCatalog {
  readonly source: "models.dev";
  readonly fetchedAt: string;
  readonly providers: readonly string[];
  readonly modalities: readonly string[];
  readonly rows: readonly CompactRow[];
  readonly bareOrder: readonly number[];
  readonly globalCosts: Readonly<Record<string, number>>;
}

/** Trims a numeric field to a finite, positive integer or `null`. */
function limit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function pruneCost(cost: RawCost | undefined): RawCost {
  const out: Record<string, number> = {};
  for (const key of ["input", "output", "cache_read", "cache_write", "reasoning"] as const) {
    const value = cost?.[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`models.dev responded with HTTP ${response.status}`);
const payload: unknown = await response.json();
if (typeof payload !== "object" || payload === null) {
  throw new Error("models.dev returned an invalid catalog");
}

const rows: SnapshotRow[] = [];
for (const [provider, providerValue] of Object.entries(payload as Record<string, unknown>)) {
  if (typeof providerValue !== "object" || providerValue === null) continue;
  const rawModels = (providerValue as { models?: Record<string, unknown> }).models;
  if (rawModels === undefined || typeof rawModels !== "object") continue;
  for (const modelValue of Object.values(rawModels)) {
    if (typeof modelValue !== "object" || modelValue === null) continue;
    const model = modelValue as RawModel;
    const id = typeof model.id === "string" && model.id.length > 0 ? model.id : undefined;
    if (id === undefined) continue;
    if (isExcludedModel(id, model.name)) continue;
    rows.push({
      provider,
      id,
      ...(typeof model.name === "string" && model.name.length > 0 ? { name: model.name } : {}),
      context: limit(model.limit?.context),
      output: limit(model.limit?.output),
      input: stringList(model.modalities?.input),
      outputModalities: stringList(model.modalities?.output),
      reasoning: model.reasoning === true,
      toolCall: model.tool_call === true,
      cost: pruneCost(model.cost),
    });
  }
}

const originalOrder = [...rows].sort((a, b) =>
  a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
);
const providers = [...new Set(rows.map((row) => row.provider.trim().toLowerCase()))].sort(compareText);
const providerIndex = new Map(providers.map((provider, index) => [provider, index]));
const modalities = ["text", "image", "pdf", "video", "audio"];
const indexedRows = originalOrder.map((row, originalIndex) => ({
  originalIndex,
  row,
  normalizedProvider: row.provider.trim().toLowerCase(),
  normalizedId: row.id.trim().toLowerCase(),
}));
indexedRows.sort((a, b) =>
  compareText(a.normalizedProvider, b.normalizedProvider) ||
  compareText(a.normalizedId, b.normalizedId) ||
  a.originalIndex - b.originalIndex,
);

const compactRows: CompactRow[] = indexedRows.map(({ row }) => {
  const index = providerIndex.get(row.provider.trim().toLowerCase());
  if (index === undefined) throw new Error(`Missing provider index for ${row.provider}`);
  return [
    index,
    row.id,
    row.name ?? "",
    row.context ?? 0,
    row.output ?? 0,
    modalityMask(row.input, modalities),
    modalityMask(row.outputModalities, modalities),
    (row.reasoning ? 1 : 0) | (row.toolCall ? 2 : 0),
    row.cost,
  ];
});
const bareOrder = compactRows
  .map((_, index) => index)
  .sort((left, right) => {
    const leftRow = compactRows[left];
    const rightRow = compactRows[right];
    if (leftRow === undefined || rightRow === undefined) {
      throw new Error("Invalid compact row index while sorting bare ids");
    }
    const leftId = bareId(leftRow[1]);
    const rightId = bareId(rightRow[1]);
    return compareText(leftId, rightId) || left - right;
  });
const globalCosts = buildGlobalCosts(originalOrder, indexedRows);

const snapshot: CompiledCatalog = {
  source: "models.dev",
  fetchedAt: new Date().toISOString(),
  providers,
  modalities,
  rows: compactRows,
  bareOrder,
  globalCosts,
};
await Bun.write(SNAPSHOT_PATH, `${JSON.stringify(snapshot)}\n`);
console.log(
  `Wrote ${compactRows.length} rows across ${providers.length} providers to ${SNAPSHOT_PATH}`,
);

function buildGlobalCosts(
  orderedRows: readonly SnapshotRow[],
  compiledRows: readonly {
    readonly originalIndex: number;
  }[],
): Record<string, number> {
  const rowIndexByOriginalIndex = new Map(
    compiledRows.map(({ originalIndex }, index) => [originalIndex, index]),
  );
  const votes = new Map<
    string,
    Map<string, { rowIndex: number; count: number; detail: number; total: number }>
  >();
  for (const [originalIndex, row] of orderedRows.entries()) {
    if (typeof row.cost.input !== "number" || typeof row.cost.output !== "number") continue;
    const id = bareId(row.id);
    let idVotes = votes.get(id);
    if (idVotes === undefined) {
      idVotes = new Map();
      votes.set(id, idVotes);
    }
    const signature = `${row.cost.input}/${row.cost.output}`;
    const rowIndex = rowIndexByOriginalIndex.get(originalIndex);
    if (rowIndex === undefined) throw new Error(`Missing compiled row for ${row.provider}:${row.id}`);
    const existing = idVotes.get(signature);
    const detail = rateCompleteness(row.cost);
    if (existing) {
      existing.count += 1;
      if (detail > existing.detail) {
        existing.rowIndex = rowIndex;
        existing.detail = detail;
      }
    } else {
      idVotes.set(signature, {
        rowIndex,
        count: 1,
        detail,
        total: row.cost.input + row.cost.output,
      });
    }
  }

  const result = new Map<string, number>();
  for (const [id, idVotes] of votes) {
    let winner: { rowIndex: number; count: number; total: number } | undefined;
    for (const vote of idVotes.values()) {
      if (
        winner === undefined ||
        vote.count > winner.count ||
        (vote.count === winner.count && vote.total > winner.total)
      ) {
        winner = { rowIndex: vote.rowIndex, count: vote.count, total: vote.total };
      }
    }
    if (winner !== undefined) result.set(id, winner.rowIndex);
  }

  for (const [id, rowIndex] of result) {
    const undated = stripDateSuffix(id);
    if (undated !== id && !result.has(undated)) result.set(undated, rowIndex);
  }
  return Object.fromEntries(result);
}

function rateCompleteness(cost: RawCost): number {
  let score = 0;
  if (typeof cost.cache_read === "number") score += 1;
  if (typeof cost.cache_write === "number") score += 1;
  if (typeof cost.reasoning === "number") score += 1;
  return score;
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

function stripDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

function isExcludedModel(id: string, name: unknown): boolean {
  return /\bgpt[- ]?6[- ]?astra\b/i.test(id) ||
    (typeof name === "string" && /\bgpt[- ]?6[- ]?astra\b/i.test(name));
}

function modalityMask(values: readonly string[], modalities: readonly string[]): number {
  return values.reduce((mask, value) => {
    const index = modalities.indexOf(value);
    return index < 0 ? mask : mask | (1 << index);
  }, 0);
}
