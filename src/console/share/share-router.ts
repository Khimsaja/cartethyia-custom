// Public enrollment routes for shared API-key templates.
//
// Share URLs reveal policy and allow one child key to be created per canonical
// client IP. The child bearer is returned only by the successful issue call.

import { Elysia } from "elysia";
import { and, eq, isNull, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { apiKeys, models, providers } from "../../persistence/schema";
import { canonicalClientIpKey } from "../../security/ip-boundary";
import { decryptCredentialToString } from "../../security/crypto";
import { isModelAllowed, type ApiKeyAuthorizationSnapshot } from "../../security/api-key-auth";
import { API_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "../../security/outbound-headers";
import { SHARED_CHILD_HINT_MAX_LENGTH, generateApiKeySecret } from "../domains/api-keys/contracts";
import { popupImageBytes } from "../domains/api-keys/share-popup-image";
import type { ShareStatsPort } from "./share-stats";
import {
  hashShareToken,
  type ShareLinkPolicy,
  type ShareLinkStore,
} from "../../persistence/share-store";

/** Minimum accepted token length; generated tokens are 43 base64url chars. */
const MIN_TOKEN_LENGTH = 20;

export interface ShareRouterOptions {
  readonly db: CartethyiaDatabase;
  readonly shareStore: ShareLinkStore;
  /** Resolves the normalized client IP through the trusted-proxy boundary. */
  readonly resolveClientIp: (request: Request) => string | null;
  /** Family-wide activity rollup for the share page. Omitted in tests that do not exercise it. */
  readonly stats?: ShareStatsPort;
}

function shareHeaders(): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": API_CONTENT_SECURITY_POLICY,
    "x-frame-options": X_FRAME_OPTIONS,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: shareHeaders() });
}

function notFound(): Response {
  return json({ error: { code: "link_not_found", message: "Share link is unavailable" } }, 404);
}

function providerOf(slug: string): string {
  const index = slug.indexOf("/");
  return index === -1 ? "" : slug.slice(0, index);
}

function modelPrefixAllows(
  prefix: string | null,
  providerId: string,
  modelId: string,
): boolean {
  return prefix === null || modelId.startsWith(prefix) || `${providerId}/${modelId}`.startsWith(prefix);
}

/** Resolves the models a share recipient may use. */
async function modelsForShare(db: CartethyiaDatabase, row: ShareLinkPolicy): Promise<string[]> {
  const snapshot: ApiKeyAuthorizationSnapshot = {
    api_key_id: row.id,
    tenant_id: row.tenantId,
    model_allowlist: row.modelAllowlist,
    model_denylist: row.modelDenylist,
  };
  const configured = row.modelAllowlist;
  if (configured !== null && configured.length > 0) {
    return configured
      .filter((slug) => {
        const providerId = providerOf(slug);
        const modelId = providerId === "" ? slug : slug.slice(providerId.length + 1);
        return (
          isModelAllowed(snapshot, modelId, providerId || undefined, slug) &&
          modelPrefixAllows(row.modelPrefix, providerId, modelId)
        );
      })
      .sort((left, right) => left.localeCompare(right));
  }
  const providerScope = or(isNull(providers.tenantId), eq(providers.tenantId, row.tenantId));
  const rows = await db
    .select({ providerId: models.providerId, modelId: models.modelId })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.enabled, true), providerScope));
  const slugs = new Set<string>();
  for (const entry of rows) {
    const slug = `${entry.providerId}/${entry.modelId}`;
    if (!isModelAllowed(snapshot, entry.modelId, entry.providerId, slug)) continue;
    if (!modelPrefixAllows(row.modelPrefix, entry.providerId, entry.modelId)) continue;
    slugs.add(slug);
  }
  return [...slugs].sort((left, right) => left.localeCompare(right));
}


/** Creates the public enrollment page and one-time shared-key issuance route. */
export function createShareRouter(options: ShareRouterOptions): Elysia {
  const { db, shareStore } = options;

  return new Elysia()
    /**
     * Resolves a link to its policy and, for a handoff link, the key it
     * reveals.
     *
     * One endpoint serves both kinds because a token is exactly one of them. A
     * page that had to guess the kind sent a personal key's handoff link to the
     * enrollment lookup, which answered 404 for a link that was live — the
     * recipient saw "link unavailable" for a URL the console had just handed
     * out.
     */
    .get("/share/:token/data", async ({ params, request }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const tokenHash = hashShareToken(token);
      const resolved = await shareStore.resolveShareLink(tokenHash);
      if (resolved === null) return notFound();
      const row = resolved.key;
      const clientIp = options.resolveClientIp(request);
      const clientIpKey = clientIp === null ? undefined : canonicalClientIpKey(clientIp);
      const [modelAllowlist, alreadyIssued] = await Promise.all([
        modelsForShare(db, row),
        // Only an enrollment link hands out keys, so only it can be exhausted
        // by the one-active-key-per-IP rule.
        resolved.kind === "enroll" && clientIpKey !== undefined
          ? shareStore.hasActiveSharedKeyForIp(clientIpKey)
          : Promise.resolve(false),
      ]);
      void shareStore.touchView(tokenHash).catch(() => undefined);
      const policy = {
        name: row.name,
        keyPrefix: row.keyPrefix,
        dailyLimit: row.dailyTokenLimit,
        monthlyLimit: row.monthlyTokenLimit,
        oneTimeLimit: row.lifetimeTokenBudget,
        requestsPerMinute: row.requestsPerMinute,
        maxConcurrentRequests: row.maxConcurrentRequests,
        modelPrefix: row.modelPrefix,
        modelAllowlist,
        modelDenylist: row.modelDenylist,
        notes: {
          title: row.notesTitle,
          subtitle: row.notesSubtitle,
          body: row.notesBody,
        },
        sharePopup: {
          enabled: row.sharePopupEnabled,
          hasImage: row.sharePopupImage !== null,
          title: row.sharePopupTitle,
          body: row.sharePopupBody,
        },
        expiresAt: row.expiresAt,
      };
      if (resolved.kind === "handoff") {
        // The link exists and is authorized; only its retained ciphertext can
        // be missing, which happens for a row written before token retention or
        // under a rotated encryption key. That is a page with nothing to
        // reveal, not a link the recipient mistyped.
        let key: string | null = null;
        if (resolved.key.keyEncrypted !== null) {
          try {
            key = decryptCredentialToString(resolved.key.keyEncrypted);
          } catch {
            key = null;
          }
        }
        return json({ kind: "handoff", key, ...policy });
      }
      return json({
        kind: "enroll",
        canIssue: clientIpKey !== undefined && !alreadyIssued,
        alreadyIssued,
        ...policy,
      });
    })
    /**
     * The owner-uploaded popup art. It is served from the same bearer token as
     * the page itself, so a link that stops resolving stops exposing the image.
     */
    .get("/share/:token/popup-image", async ({ params }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const resolved = await shareStore.resolveShareLink(hashShareToken(token));
      const image = resolved?.key.sharePopupImage;
      const mime = resolved?.key.sharePopupImageMime;
      if (!image || !mime) return notFound();
      return new Response(new Blob([popupImageBytes(image)], { type: mime }), {
        headers: {
          "content-length": String(image.byteLength),
          // Per-link content: a shared cache keyed only by path would keep
          // serving it after the token stops resolving.
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    })
    .post("/share/:token/issue", async ({ params, request, set }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const clientIp = options.resolveClientIp(request);
      if (clientIp === null)
        return json({ error: { code: "client_ip_unavailable", message: "Client IP is unavailable" } }, 503);
      const clientIpKey = canonicalClientIpKey(clientIp);
      if (clientIpKey === undefined)
        return json({ error: { code: "client_ip_invalid", message: "Client IP could not be normalized" } }, 400);

      const tokenHash = hashShareToken(token);
      const resolved = await shareStore.resolveShareLink(tokenHash);
      // A handoff link reveals an existing key; it never mints one.
      if (resolved === null || resolved.kind !== "enroll") return notFound();
      // The recipient supplies the label hint; policy still comes exclusively from the template.
      let nameHint: string;
      try {
        const body = (await request.json()) as { nameHint?: unknown };
        if (typeof body.nameHint !== "string" || body.nameHint.trim().length === 0) {
          return json({ error: { code: "name_required", message: "Your name is required" } }, 400);
        }
        nameHint = body.nameHint.trim().slice(0, SHARED_CHILD_HINT_MAX_LENGTH);
      } catch {
        return json({ error: { code: "name_required", message: "Your name is required" } }, 400);
      }
      const template = resolved.key;
      const generated = generateApiKeySecret(template.keyPrefix ?? undefined);
      const issued = await shareStore.issueSharedApiKey(tokenHash, {
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        clientIp,
        clientIpKey,
        nameHint,
      });
      if (issued.kind === "link_unavailable") return notFound();
      if (issued.kind === "ip_limit") {
        return json(
          { error: { code: "shared_key_ip_limit", message: "This IP address already has an active shared API key" } },
          409,
        );
      }
      set.status = 201;
      return json({
        key: generated.secret,
        keyId: issued.apiKeyId,
        keyPrefix: issued.keyPrefix,
        createdAt: issued.createdAt.toISOString(),
      }, 201);
    })
    /**
     * Family-wide activity for the share page's stats section.
     *
     * Aggregates every key the link has issued, not just the caller's own: the
     * quota is shared, so a per-recipient figure would understate what the link
     * has actually spent. The same bearer token that opens the page authorizes
     * this, and the response carries masked IPs only — it is rendered outside
     * the tenant.
     */
    .get("/share/:token/stats", async ({ params }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const stats = options.stats;
      if (!stats) return json({ error: { code: "stats_unavailable", message: "Stats are unavailable" } }, 503);
      const resolved = await shareStore.resolveShareLink(hashShareToken(token));
      if (resolved === null) return notFound();
      const templateId = resolved.key.id;
      const tenantId = resolved.key.tenantId;
      const children = await db
        .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.parentKeyId, templateId));
      const active = children.filter((child) => child.revokedAt === null).length;
      const keyIds = [templateId, ...children.map((child) => child.id)];
      const family = await stats.getFamilyStats(tenantId, keyIds, {
        total: children.length,
        active,
      });
      return json(family);
    }) as unknown as Elysia;
}
