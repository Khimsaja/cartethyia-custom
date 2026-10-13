import type { ProviderModuleCapabilities } from "../../provider-capabilities";
import { oauthCapability, quotaCapability } from "../../provider-capabilities";

type BuddyProviderId = "cb" | "cbcn" | "workbuddy" | "workbuddycn";

/**
 * Lazy capability declarations for Buddy's four independently identified
 * regional products.
 */
export const BUDDY_PROVIDER_CAPABILITIES = {
  cb: {
    loadAdapter: async () => (await import("./intl/codebuddy/provider")).createCodeBuddyAdapter(),
    loadModels: async () => (await import("./intl/codebuddy/provider")).CODEBUDDY_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./intl/codebuddy/provider")).discoverCodeBuddyModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./intl/codebuddy/oauth"),
      "codeBuddyOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./intl/codebuddy/quota"),
      "fetchCodeBuddyIntlQuota",
    ),
  },
  cbcn: {
    loadAdapter: async () => (await import("./cn/codebuddy/provider")).createCodeBuddyCnAdapter(),
    loadModels: async () => (await import("./cn/codebuddy/provider")).CODEBUDDY_CN_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./cn/codebuddy/provider")).discoverCodeBuddyCnModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./intl/codebuddy/oauth"),
      "codeBuddyCnOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./intl/codebuddy/quota"),
      "fetchCodeBuddyCnQuota",
    ),
  },
  workbuddy: {
    loadAdapter: async () => (await import("./intl/workbuddy/provider")).createWorkBuddyAdapter(),
    loadModels: async () => (await import("./intl/workbuddy/provider")).WORKBUDDY_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./intl/workbuddy/provider")).discoverWorkBuddyModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./intl/workbuddy/oauth"),
      "workBuddyOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./intl/workbuddy/quota"),
      "fetchWorkBuddyQuota",
    ),
  },
  workbuddycn: {
    loadAdapter: async () => (await import("./cn/workbuddy/provider")).createWorkBuddyCnAdapter(),
    loadModels: async () => (await import("./cn/workbuddy/provider")).WORKBUDDY_CN_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./cn/workbuddy/provider")).discoverWorkBuddyCnModels({
        credential,
        ...(fetcher === undefined ? {} : { fetcher }),
      }),
    loadAuthentication: oauthCapability(
      () => import("./cn/workbuddy/oauth"),
      "workBuddyCnOAuthClient",
      { withRefresher: true },
    ),
    loadQuotaCollector: quotaCapability(
      () => import("./intl/workbuddy/quota"),
      "fetchWorkBuddyCnQuota",
    ),
  },
} satisfies Readonly<Record<BuddyProviderId, ProviderModuleCapabilities>>;
