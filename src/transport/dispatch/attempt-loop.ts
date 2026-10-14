/**
 * Shared per-candidate attempt lifecycle for every dispatch route.
 *
 * Admission lease → pool slot → routing reservation, the route-specific
 * upstream operation, then one `completeAttempt` for the attempt's accounting.
 * Retry, backoff, pool-cooldown flagging, and reactive OAuth refresh are one
 * policy here, so the canonical proxy routes and the native Responses-compact
 * route cannot drift. Route-specific behavior arrives as the `prepare` and
 * `attempt` closures; this module never forks retry policy.
 */
import { GatewayError } from "../../protocol/gateway-error";
import type { ResolvedCredential } from "../../providers/provider-contracts";
import { classifyTerminalOutcome, fallbackRetryDelayMs, isRetryableFailure, sleep } from "../failure-policy";
import { resolveRouteMaxAttempts } from "../../config/timeouts";
import type { OAuthTokenRefresher } from "../../providers/authentication/oauth-refresh-service";
import type { OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { ByokUpstreamHost } from "../../providers/operations/provider-catalog-service";
import type { AdmissionLease } from "../../security/admission/contracts";
import type { RouteCandidate, Reservation, RouteSnapshotService } from "../routing/route-model";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { acquireAttemptLeases, releaseAttemptLeases } from "./leases";
import type { AttemptLeaseSource, AttemptLeases } from "./leases";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ProxyRequestState } from "../request/state";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { flagPoolCooldown } from "../../network/pool-health";
import { completeAttempt, errorClientResponseBody, estimatedUsage, type ProviderExchangeCapture } from "./attempt-finalize";
import { repriceUsage } from "../../providers/provider-usage";
import { shouldCooldownPool, isOAuthCredentialInvalidated } from "./retry-policy";
import { drainAbortReason } from "../shutdown-notice";

/**
 * Identity of one combo member for the request-scoped failure flag.
 *
 * Account, model, and endpoint distinguish siblings that share a provider.
 * The flag lives only for this request: it stops a failed member from being
 * retried while another member remains, without writing a durable cooldown.
 */
function comboCandidateKey(candidate: RouteCandidate): string {
  return [
    candidate.provider_id,
    candidate.provider_account_id ?? "global",
    candidate.model_id,
    candidate.endpoint,
  ].join(":");
}

/**
 * Which combo member a candidate belongs to.
 *
 * A combo's members are distinct models (usually one per provider), so the
 * model id is what separates them — the accounts of one member are siblings
 * that share it. Used only to give each member its own share of the attempt
 * budget; a candidate list that is not a combo collapses to one member, which
 * keeps the ordinary single-model path untouched.
 */
function comboMemberKey(candidate: RouteCandidate): string {
  return `${candidate.provider_id}:${candidate.model_id}:${candidate.endpoint}`;
}

/** Zero-based position of `candidate`'s member in the flattened candidate list. */
function memberIndexOf(
  candidates: readonly RouteCandidate[],
  candidate: RouteCandidate,
  index: number,
): number {
  const members: string[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const key = comboMemberKey(candidates[i]!);
    if (members[members.length - 1] !== key) members.push(key);
    if (i === index) return members.length - 1;
  }
  return members.indexOf(comboMemberKey(candidate));
}

/** Route-specific preconditions resolved for one candidate before its leases are taken. */
interface PreparedAttempt<TAdapter> {
  readonly credential: ResolvedCredential;
  readonly adapter: TAdapter;
}

/** One candidate attempt with its admission lease, pool slot, and reservation held. */
interface AttemptContext<TAdapter> {
  readonly candidate: RouteCandidate;
  readonly credential: ResolvedCredential;
  readonly adapter: TAdapter;
  readonly leases: AttemptLeases;
  /** Zero-based candidate index; also this attempt's failover count. */
  readonly attemptIndex: number;
  readonly providerCapture: ProviderExchangeCapture;
  /**
   * Hands lease ownership to the value this attempt returns (a streaming
   * response releases its own lease on stream completion/cancel). Without it
   * the loop releases the leases in `finally`.
   */
  retainLeases(): void;
}

/** Collaborators shared by every dispatch route. */
interface AttemptLoopDeps {
  readonly db: CartethyiaDatabase;
  readonly poolSelector?: NetworkPoolSelector;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  readonly snapshotService?: RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

interface AttemptLoopInput<TResult, TAdapter> {
  readonly state: ProxyRequestState;
  readonly deps: AttemptLoopDeps;
  readonly leaseSource: AttemptLeaseSource;
  readonly candidates: readonly RouteCandidate[];
  readonly tenantId: string | null;
  /** Strict pool selection rejects direct egress when every pool is at capacity. */
  readonly strictPoolSelection: boolean;
  /** BYOK host for a candidate, when this route validates network bindings. */
  readonly resolveHost?: (candidate: RouteCandidate) => ByokUpstreamHost | undefined;
  readonly prepare: (candidate: RouteCandidate) => Promise<PreparedAttempt<TAdapter>>;
  readonly attempt: (context: AttemptContext<TAdapter>) => Promise<TResult>;
  /** Raised when the candidate list is empty and no attempt ever ran. */
  readonly exhaustedError: GatewayError;
}

/**
 * Shared per-candidate attempt lifecycle for the canonical proxy routes and
 * the native Responses-compact route: admission lease → pool slot → routing
 * reservation, the route-specific upstream operation, then one
 * `completeAttempt` for the attempt's accounting. Retry, backoff,
 * pool-cooldown flagging, and reactive OAuth refresh are one policy here, so
 * the two routes cannot drift.
 */
export async function runAttemptLoop<TResult, TAdapter>(
  input: AttemptLoopInput<TResult, TAdapter>,
): Promise<TResult> {
  const { state, deps, leaseSource } = input;
  const candidates = [...input.candidates];
  let lastError: unknown = input.exhaustedError;
  const refreshedCandidates = new Set<string>();
  const failedCandidates = new Set<string>();
  // Every attempt owns a fresh capture sink, but only the terminal attempt's
  // sink reaches the payload store. When the terminal attempt fails before it
  // fires an outbound request (lease/acquire/prepare threw, or failover
  // exhausted), its sink is empty and the drawer reads "—" for a request that
  // DID reach an upstream on an earlier attempt. Keep the fired exchanges so
  // the terminal completion can fall back to the last one that has a request.
  const firedCaptures: ProviderExchangeCapture[] = [];
  const maxAttempts = resolveRouteMaxAttempts();
  // One combo member must not be able to spend the whole budget.
  //
  // A combo's member list is flattened into this candidate list, so the first
  // member's accounts occupy its head. With one member holding more accounts
  // than `maxAttempts` (default 8), every attempt was spent inside that member
  // and a later, perfectly healthy member was never dialed — a `deepseek` combo
  // of [cb, wb] stayed stuck on cb while wb sat idle, because cb's twelve
  // accounts exhausted all eight attempts before the list reached wb.
  //
  // Each member gets an equal share of the budget, and a member that used less
  // than its share releases the remainder to the members behind it: the first
  // member is capped at `ceil(maxAttempts / members)` and the rest of the
  // budget stays available, so a healthy later member is always reached.
  const memberCount = new Set(candidates.map(comboMemberKey)).size;
  const perMemberCap =
    memberCount > 1 ? Math.max(1, Math.ceil(maxAttempts / memberCount)) : maxAttempts;
  let index = 0;
  let attempts = 0;
  while (index < candidates.length && attempts < maxAttempts) {
    const candidate = candidates[index];
    if (!candidate) break;
    // A member that has spent its share is skipped: the loop advances past the
    // rest of its accounts to the next member instead of burning the budget
    // they would have consumed.
    if (memberCount > 1 && attempts >= perMemberCap * (memberIndexOf(candidates, candidate, index) + 1)) {
      index += 1;
      continue;
    }
    let lease: AdmissionLease | undefined;
    let reservation: Reservation | undefined;
    let proxySlot: { poolId: string; release: () => void } | undefined;
    let networkPoolId: string | undefined;
    let bindingEstablished = false;
    let leasesRetained = false;
    let retryDelayMs = 0;
    const providerCapture: ProviderExchangeCapture = {
      request: null,
      response: Promise.resolve(null),
    };
    try {
      if (state.abortController.signal.aborted)
        throw new GatewayError("transport_closed", 499, "request was cancelled");
      const { credential, adapter } = await input.prepare(candidate);
      const host = input.resolveHost?.(candidate);
      // Single attempt-lease manager owns acquisition order (admission →
      // pool slot → reservation) with reverse-order unwind. Assigned only on
      // success, so a mid-acquire throw leaves these undefined for `finally`.
      const attemptLeases = await acquireAttemptLeases(leaseSource, candidate, {
        signal: state.abortController.signal,
        ...(deps.poolSelector ? { poolSelector: deps.poolSelector } : {}),
        ...(deps.networkBindingFactory ? { networkBindingFactory: deps.networkBindingFactory } : {}),
        ...(host ? { host } : {}),
        strictPoolSelection: input.strictPoolSelection,
      });
      lease = attemptLeases.lease;
      reservation = attemptLeases.reservation;
      proxySlot = attemptLeases.proxySlot;
      networkPoolId = attemptLeases.networkPoolId;
      // Downstream error paths gate `commitUsage(estimated)` on this flag so
      // the estimate is only charged once the request truly consumed
      // upstream resources; the lease and reservation are held from here on.
      bindingEstablished = true;
      state.startProviderFlight();
      return await input.attempt({
        candidate,
        credential,
        adapter,
        leases: attemptLeases,
        attemptIndex: index,
        providerCapture,
        retainLeases: () => {
          leasesRetained = true;
        },
      });
    } catch (error) {
      // A drain aborts the controller, so a mid-flight attempt unwinds here as
      // an abort. Surface the typed shutdown error (503 shutting_down /
      // restart_for_update) instead of an opaque `transport_closed`, so the
      // client's JSON error — not just the SSE path — names the real cause.
      const drain = drainAbortReason(state.abortController.signal.reason);
      if (drain !== undefined) error = drain;
      lastError = error;
      // A drain is a *server* close, not a client cancel: it must be recorded
      // as a failure with the shutdown code, and it is never retryable.
      // Status, category, and origin come from one classifier so they cannot
      // disagree (a `cancelled` row used to carry `transport_unavailable`/502).
      const terminal = classifyTerminalOutcome(error, state.abortController.signal);
      const cancelled = terminal.status === "cancelled";
      const terminalAttempt =
        cancelled || !isRetryableFailure(error) || index === candidates.length - 1;
      if (providerCapture.request !== null) firedCaptures.push(providerCapture);
      // The payload store only keeps the terminal attempt's exchange. When the
      // terminal attempt never fired (failover walked past the attempt that
      // did, or prepare/lease threw first), fall back to the last fired
      // exchange so Request Detail still shows the translated provider
      // request instead of "—" for a request that reached an upstream.
      const terminalCapture =
        providerCapture.request !== null
          ? providerCapture
          : [...firedCaptures].reverse().find((capture) => capture.request !== null) ??
            providerCapture;
      await completeAttempt(state, {
        status: terminal.status,
        providerId: candidate.provider_id,
        ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
        ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
        errorCategory: terminal.errorCategory,
        errorOrigin: terminal.errorOrigin,
        modelId: candidate.model_id,
        ...(networkPoolId ? { networkPoolId } : {}),
        error,
        ...(lease ? { lease } : {}),
        // A failed attempt may have sent bytes upstream, so it is not free —
        // but it must not be charged the full input estimate plus a full
        // output reserve either, because a request that walks N candidates
        // would then leave N estimates on the counters for one client request.
        // Commit the input estimate only: nothing was generated, and the
        // `finally` release then refunds the (uncommitted) output reserve.
        ...(!cancelled && bindingEstablished
          ? {
              commitUsage: repriceUsage(
                estimatedUsage(leaseSource.estimatedInputTokens, 0),
                candidate.provider_id,
                candidate.model_id,
              ),
            }
          : {}),
        terminal: terminalAttempt,
        tenantId: input.tenantId,
        ingressBody: state.ingressBody,
        responseBody: null,
        // The client still receives the public error envelope on the wire —
        // store it so Request Detail's Client Response panel traces failures
        // exactly as the client saw them. Cancelled requests have no client
        // response (the caller is gone).
        ...(terminalAttempt && !cancelled
          ? { clientResponseText: errorClientResponseBody(error) }
          : {}),
        providerCapture: terminalCapture,
        db: deps.db,
        ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
        ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
      });
      if (networkPoolId && !cancelled && deps.poolSelector && shouldCooldownPool(error, candidate.provider_id)) {
        flagPoolCooldown(deps.poolSelector, deps.db, networkPoolId, candidate.provider_id, error);
      }
      // A 403 can be a deterministic provider policy rejection, not an
      // invalid OAuth credential. Only the evidence-based classifier above
      // may trigger a refresh.
      const candidateKey = `${candidate.provider_id}:${candidate.provider_account_id ?? "global"}:${candidate.model_id}:${candidate.endpoint}`;
      const authInvalidated = isOAuthCredentialInvalidated(error);
      if (
        !cancelled &&
        !refreshedCandidates.has(candidateKey) &&
        authInvalidated &&
        candidate.provider_account_id &&
        deps.oauthRefreshService &&
        deps.resolveOAuthRefresher
      ) {
        const refresher = await deps.resolveOAuthRefresher(candidate.provider_id);
        if (refresher) {
          const fresh = await deps.oauthRefreshService.ensureFreshAccessToken(
            candidate.provider_account_id,
            refresher,
            { force: true },
          );
          if (fresh) {
            refreshedCandidates.add(candidateKey);
            continue;
          }
        }
      }
      if (terminalAttempt) {
        metrics.proxy_requests_total.inc(1, { status: cancelled ? "cancelled" : "failed" });
        throw error;
      }
      // A failed combo member stays flagged for this request. Move it behind
      // every candidate that has not failed yet, so the next attempt cannot
      // stick to it while a sibling remains. It becomes eligible again only
      // after that sibling list is exhausted.
      const failureKey = comboCandidateKey(candidate);
      if (!failedCandidates.has(failureKey)) {
        failedCandidates.add(failureKey);
        candidates.push(candidates.splice(index, 1)[0]!);
      } else {
        index += 1;
      }
      retryDelayMs = fallbackRetryDelayMs(attempts);
    } finally {
      if (!leasesRetained)
        await releaseAttemptLeases({ lease, reservation, proxySlot }, leaseSource.routingEngine);
    }
    attempts += 1;
    if (retryDelayMs > 0) {
      try {
        await sleep(retryDelayMs, state.abortController.signal);
      } catch {
        // Abort during backoff used to escape as the sleep's own error with
        // no counter increment: attempts already recorded their telemetry,
        // but `proxy_requests_total` missed the request. Fail with the last
        // attempt's error so the client sees the real cause, counted once.
        metrics.proxy_requests_total.inc(1, { status: "cancelled" });
        throw lastError;
      }
    }
  }
  // The loop can fall out with a retryable error still in hand (every attempt
  // was retryable, so the terminal branch in the catch never fired). That used
  // to throw with no completion: no telemetry row, no payload capture, and
  // `state.completed` left clear — so a request that genuinely exhausted its
  // attempts was invisible in Request Detail. Record it as terminal here.
  if (!state.completed) {
    const terminal = classifyTerminalOutcome(lastError, state.abortController.signal);
    const lastCandidate = candidates[Math.min(index, candidates.length - 1)];
    const terminalCapture = [...firedCaptures]
      .reverse()
      .find((capture) => capture.request !== null);
    await completeAttempt(state, {
      status: terminal.status,
      providerId: lastCandidate?.provider_id ?? "",
      ...(lastCandidate?.provider_account_id
        ? { accountId: lastCandidate.provider_account_id }
        : {}),
      ...(lastCandidate?.provider_account_label
        ? { accountLabel: lastCandidate.provider_account_label }
        : {}),
      errorCategory: terminal.errorCategory,
      errorOrigin: terminal.errorOrigin,
      ...(lastCandidate?.model_id === undefined ? {} : { modelId: lastCandidate.model_id }),
      error: lastError,
      terminal: true,
      tenantId: input.tenantId,
      ingressBody: state.ingressBody,
      responseBody: null,
      // The client receives the public error envelope on the wire — store it
      // so the Client Response panel traces the failure as the client saw it.
      ...(terminal.status === "cancelled"
        ? {}
        : { clientResponseText: errorClientResponseBody(lastError) }),
      ...(terminalCapture === undefined ? {} : { providerCapture: terminalCapture }),
      db: deps.db,
      ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
      ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
    });
  }
  metrics.proxy_requests_total.inc(1, { status: "failed" });
  throw lastError;
}
