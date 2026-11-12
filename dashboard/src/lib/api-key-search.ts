/**
 * Client-side search over the API-key list.
 *
 * The list endpoint already returns every tenant key, so search is a pure
 * filter — no backend round-trip while typing. Every whitespace-separated
 * token must match (AND), and a token may hit the key's label, credential
 * prefix, or any model in its access list, so `prod gpt` finds the key
 * labelled "prod" that allows a GPT model.
 */

export interface SearchableApiKey {
  readonly label: string;
  readonly keyPrefix?: string | null | undefined;
  readonly modelList?: readonly string[] | null | undefined;
}

export function apiKeyMatchesSearch(key: SearchableApiKey, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystacks = [
    key.label.toLowerCase(),
    (key.keyPrefix ?? "").toLowerCase(),
    ...(key.modelList ?? []).map((model) => model.toLowerCase()),
  ];
  return tokens.every((token) => haystacks.some((field) => field.includes(token)));
}

export function filterApiKeys<T extends SearchableApiKey>(
  keys: readonly T[],
  query: string,
): T[] {
  if (query.trim().length === 0) return [...keys];
  return keys.filter((key) => apiKeyMatchesSearch(key, query));
}
