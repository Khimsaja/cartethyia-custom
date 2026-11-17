/**
 * Operator caps on estimated input tokens per request, by provider.
 *
 * These are NOT the models' context windows — they are per-request ceilings
 * that keep one giant request from burning an account's per-minute token
 * quota and rate-limiting the shared pool for everyone else.
 *
 * Maritaca (docs, Nov 2026): S5 / S5-free carry a 1M-token context window,
 * but the S5-free launch tier is capped at 60 RPM and 256k input TPM per
 * account, fixed across all tiers. On 12 Nov 2026 a single buyer key fired
 * ~90k-token requests every ~15s (1.36M input tokens in one hour); the
 * router rotated accounts, but each 90k request ate 35% of one account's
 * minute quota and 80 accounts ended the burst rate-limited. The cap below
 * (32,768 = 1/8 of the 256k minute quota) blocks that shape while sitting
 * ~100x above normal traffic (median request is a few hundred tokens).
 * The upstream window is unchanged, so this is reversible in one line.
 */

/** Per-request input-token ceiling, in estimated tokens (see token-estimate). */
export const MAX_INPUT_TOKENS_BY_PROVIDER: Readonly<Record<string, number>> = {
  maritaca: 32_768,
};

/** The per-request input cap for a provider, or undefined when uncapped. */
export function maxInputTokensFor(providerId: string): number | undefined {
  return MAX_INPUT_TOKENS_BY_PROVIDER[providerId];
}

/**
 * Returns the cap when the estimate exceeds it, otherwise null. Pure — the
 * caller throws the rejection. The boundary itself passes: exactly at the
 * cap is allowed.
 */
export function inputLimitExceeded(
  estimatedInputTokens: number,
  providerId: string,
): number | null {
  const cap = maxInputTokensFor(providerId);
  if (cap === undefined) return null;
  return estimatedInputTokens > cap ? cap : null;
}
