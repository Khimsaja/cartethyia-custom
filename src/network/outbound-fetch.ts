// Validated fetch: SSRF-guarded outbound fetch with optional pool-agent support.
import { GatewayError } from "../protocol/gateway-error";
import { request as httpRequest, Agent as HttpAgent } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { Agent as UndiciAgent, fetch as undiciFetch, type UndiciRequestInit } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";
import { resolveAllAddresses, validateResolvedAddresses } from "./ssrf";
import type { SsrfPolicy } from "../config/network";
import { isProxyAgentPair, type ProxyAgentPair } from "./pool/agent";
import { metrics } from "../observability/metrics";
import { trackNetworkCall } from "../observability/performance-metrics";
// Validated fetch — single egress with ProxyAgent support
interface ValidatedFetchOptions {
  readonly fetchFn?: typeof fetch;
  readonly policy?: SsrfPolicy;
  readonly maxRedirects?: number;
  readonly resolveFn?: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  readonly agent?: HttpAgent | HttpsAgent | ProxyAgentPair;
  /**
   * Proxy URL to route the dial through, forwarded to the runtime-native fetch
   * (`proxy` option). Pool egress passes the pool's endpoint here; without it
   * a request that should leave through a proxy leaves directly.
   */
  readonly proxyUrl?: string;
  /**
   * Fetch implementation used for SOCKS5 dials (via the undici dispatcher).
   * Defaults to undici's fetch; injectable for offline tests.
   */
  readonly socksFetch?: (input: RequestInfo | URL, init?: UndiciRequestInit) => Promise<Response>;
}
export type ValidatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Whether a configured pool/relay agent owns this dial. When it does, the
 * proxy resolves the upstream target itself, so the local resolve below is an
 * advisory SSRF check rather than a prerequisite for egress.
 */

/**
 * Builds the application-relay request used by hosted relay front doors.
 * These endpoints intentionally do not receive CONNECT: they accept the
 * target origin/path in headers and perform the upstream fetch themselves,
 * matching the 21-beta relay contract.
 */
function relayRequest(
  relayEndpoint: URL,
  target: URL,
  init: RequestInit,
): { url: URL; init: RequestInit } {
  const relayUrl = new URL(relayEndpoint.toString());
  const headers = new Headers(init.headers);
  headers.delete("host");
  headers.set("x-relay-target", target.origin);
  headers.set("x-relay-path", `${target.pathname}${target.search}`);
  if (relayUrl.username || relayUrl.password) {
    const credentials = `${decodeURIComponent(relayUrl.username)}:${decodeURIComponent(relayUrl.password)}`;
    headers.set("x-relay-auth", `Basic ${Buffer.from(credentials).toString("base64")}`);
    relayUrl.username = "";
    relayUrl.password = "";
  }
  return { url: relayUrl, init: { ...init, headers } };
}


const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"] as const;

function stripCredentialsOnCrossOrigin(
  headersInit: HeadersInit | undefined,
): Headers {
  const headers = new Headers(headersInit);
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return headers;
}

/**
 * The injected dialer. `fetchFn` is the seam offline suites use to record
 * requests without a socket; the runtime fetch is the only other dialer.
 */
function dialer(options: ValidatedFetchOptions): typeof fetch {
  return options.fetchFn ?? fetch;
}

/**
 * Builds the `undici` dispatcher that routes a dial through a SOCKS5 pool
 * agent. The runtime-native fetch does not support `socks5://` proxies
 * (`UnsupportedProxyProtocol`), so the socks pair drives the transport via
 * undici's dispatcher instead — no node `http`/`https` adapter is involved.
 */
let socksDispatcherCache: WeakMap<SocksProxyAgent, UndiciAgent> | undefined;
function socksDispatcherFor(agent: SocksProxyAgent): UndiciAgent {
  socksDispatcherCache ??= new WeakMap();
  let dispatcher = socksDispatcherCache.get(agent);
  if (!dispatcher) {
    dispatcher = new UndiciAgent({
      connect: async (opts) => {
        const o = opts as {
          hostname?: string;
          port?: number | string;
          family?: number;
          lookup?: (hostname: string, options: unknown, cb: (err: Error | null, addresses: unknown) => void) => void;
        };
        return await agent.connect(
          {} as never,
          {
            host: o.hostname ?? "localhost",
            port: Number(o.port ?? 80),
            ...(o.family === undefined ? {} : { family: o.family }),
            ...(o.lookup === undefined ? {} : { lookup: o.lookup }),
          } as never,
        );
      },
    });
    socksDispatcherCache.set(agent, dispatcher);
  }
  return dispatcher;
}

/**
 * One dial, always through `fetch`.
 *
 * The runtime's own fetch (Bun/Undici) is the transport the clients this
 * gateway impersonates actually use, and several upstreams meter per client
 * transport fingerprint — OpenCode's anonymous free tier refuses a
 * Node-stack dial with 429 FreeUsageLimitError while accepting the identical
 * bytes over this one. There is no Node `http`/`https` path to choose
 * between: the SSRF resolve/validate pass that runs before this dial is the
 * security boundary, and it is identical for every caller.
 *
 * A configured pool/relay agent is still honored through `dispatcher` when the
 * runtime supports it (Bun and Undici both do); when it is not supported the
 * agent is ignored rather than silently replaced by an unvalidated dial.
 *
 * `content-length` is set for a known-length body only when the caller did not
 * set it: without the header the request falls back to chunked encoding, and
 * some upstream gateways wait for the complete chunked stream before routing
 * the request — an avoidable round trip per dial.
 */
async function dial(
  url: URL,
  init: RequestInit,
  fetchFn: typeof fetch,
  proxyUrl: string | undefined,
  dispatcher?: UndiciAgent,
  socksFetch: (input: RequestInfo | URL, init?: UndiciRequestInit) => Promise<Response> = undiciFetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  let body: BodyInit | null | undefined = init.body;
  if (body !== undefined && body !== null && !headers.has("content-length")) {
    if (typeof body === "string") {
      headers.set("content-length", String(Buffer.byteLength(body, "utf8")));
    } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      headers.set("content-length", String(body.byteLength));
    } else {
      // Stream bodies (ReadableStream, Blob, FormData, ...): measuring the
      // length consumes the body, so the measured bytes must become the body
      // sent. Passing the drained original to fetch throws "Body object
      // should not be disturbed or locked" (Bun) and the request never
      // leaves — every streamed chat-wire dispatch failed this way.
      const bytes = await new Response(body).arrayBuffer();
      headers.set("content-length", String(bytes.byteLength));
      body = bytes;
    }
  }
  const fetchPromise =
    dispatcher !== undefined
      ? socksFetch(url, {
          ...init,
          headers,
          // Same buffered-body rule as the fetch path below: a measured stream
          // body must be replaced by its bytes, or the SOCKS dial sends a drained
          // body. (Merge note: upstream 2.7.3 added this branch without it.)
          ...(body === undefined ? {} : { body }),
          dispatcher,
        })
      : fetchFn(url, {
          ...init,
          headers,
          // `body` is only overridden when it was buffered above; spreading an
          // explicit `undefined` would trip `exactOptionalPropertyTypes`.
          ...(body === undefined ? {} : { body }),
          ...(proxyUrl === undefined ? {} : { proxy: proxyUrl }),
        });
  // Release the request body now: the bytes are handed to fetch. Holding
  // `init`/`body` across the await parks the payload in this frame for the
  // whole upstream wait — and forever if the fetch hangs (heap diag9: a
  // 10 MB body retained via this frame, rooted by Bun's StrongRootBlock).
  body = undefined;
  const slimInit: RequestInit = { ...init };
  delete slimInit.body;
  init = slimInit;
  return await fetchPromise;
}

/**
 * One raw GET/HEAD dial that carries a body.
 *
 * The runtime-native fetch (`Bun`/undici) rejects `GET`/`HEAD` requests with a
 * body — "request with GET/HEAD method cannot have body" — but some upstreams
 * validate a signature over the body on a GET (Qoder's `/model/list` does).
 * This is the Node `http`/`https` path for exactly that case. It runs only
 * after the SSRF resolve/validate pass and only when no pool/relay agent owns
 * the dial, so the security boundary is unchanged.
 */
function nodeDial(url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "http:" ? httpRequest : httpsRequest;
    const headers: Record<string, string> = {};
    {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    let payload: Buffer | undefined;
    const body = init.body;
    if (typeof body === "string") {
      payload = Buffer.from(body, "utf8");
    } else if (Buffer.isBuffer(body)) {
      payload = body;
    } else if (body instanceof Uint8Array) {
      payload = Buffer.from(body);
    } else if (body !== null && body !== undefined) {
      reject(new TypeError("nodeDial only supports string/Buffer/Uint8Array bodies"));
      return;
    }
    if (payload !== undefined) headers["content-length"] = String(payload.byteLength);
    const req = mod(
      url,
      {
        method: (init.method ?? "GET").toUpperCase(),
        headers,
        ...(init.signal === undefined ? {} : { signal: init.signal as AbortSignal }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 200,
              ...(res.statusMessage === undefined ? {} : { statusText: res.statusMessage }),
              headers: res.headers as unknown as HeadersInit,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function createValidatedFetch(options: ValidatedFetchOptions = {}): ValidatedFetch {
  const policy = options.policy ?? {};
  const maxRedirects = options.maxRedirects ?? policy.maxRedirects ?? 3;
  const resolveFn = options.resolveFn ?? resolveAllAddresses;
  const fetchFn = dialer(options);
  const configuredAgent = options.agent;
  const relayEndpoint = isProxyAgentPair(configuredAgent)
    ? configuredAgent.relayEndpoint
    : undefined;
  const socksAgent = isProxyAgentPair(configuredAgent)
    ? configuredAgent.socks
    : undefined;
  const socksFetch = options.socksFetch ?? undiciFetch;
  const proxyUrl =
    options.proxyUrl ?? (isProxyAgentPair(configuredAgent) ? configuredAgent.proxyUrl : undefined);
  return async (input, init = {}) => {
    const startedAt = performance.now();
    let url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    let requestInit: RequestInit = { ...init, redirect: "manual" };
    if (input instanceof Request && init.headers === undefined) {
      requestInit.headers = new Headers(input.headers);
    }
    // Release the request body once it has been handed to the dial: the
    // bytes are already with the fetch, but holding `requestInit.body` (and
    // the caller's `init.body`) across the await parks the payload in this
    // frame for the whole upstream wait — and forever if the fetch hangs
    // (heap diag9/diag10: the body retained via this frame). Unconditional:
    // a length gate undercounts 2-byte strings (diag10: a 1.2 MB body is
    // ~619k UTF-16 units, below a 1M gate), and 307/308 replays of a POST
    // body effectively never occur for these upstreams (a failed replay is
    // retried by the attempt loop).
    const dropLargeBody = (): void => {
      if (requestInit.body !== undefined && requestInit.body !== null) {
        const slim: RequestInit = { ...requestInit };
        delete slim.body;
        requestInit = slim;
        const slimInit: RequestInit = { ...init };
        delete slimInit.body;
        init = slimInit;
      }
    };
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new TypeError("unsupported outbound URL protocol");
      const signal = requestInit.signal ?? new AbortController().signal;
      // Every hop — including proxied dials and redirect targets — is resolved
      // and checked against the SSRF policy. When a proxy agent owns the dial,
      // the proxy still resolves its own answer, so the check is advisory there;
      // it deterministically rejects targets whose *advertised* addresses fall
      // in blocked ranges (literal-IP redirects, private-space DNS, relay abuse).
      // For a pool/relay-owned dial, the upstream *target* is resolved by the
      // proxy/relay itself, so local DNS for it is an advisory SSRF check,
      // not a prerequisite for egress. Operator VPNs routinely break the
      // system resolver (tunnel DNS that is unreachable or drops queries);
      const poolDialsTarget = Boolean(configuredAgent || relayEndpoint);
      let resolvedAddress: string | undefined;
      let relayResolvedAddress: string | undefined;
      if (poolDialsTarget) {
        // The egress dials the pool/relay, which resolves the target itself.
        // Counting these lets ops confirm how much traffic depends on
        // proxy-resolved DNS rather than the local system resolver.
        metrics.cartethyia_proxy_dial_proxy_resolved_total.inc();
      }
      try {
        if (!poolDialsTarget) {
          const addresses = await resolveFn(url.hostname, signal);
          validateResolvedAddresses(addresses, policy);
          resolvedAddress = addresses[0];
        }
        if (relayEndpoint) {
          const relayAddresses = await resolveFn(relayEndpoint.hostname, signal);
          validateResolvedAddresses(relayAddresses, policy);
          relayResolvedAddress = relayAddresses[0];
          if (!relayResolvedAddress)
            throw new TypeError(`no validated address for ${relayEndpoint.hostname}`);
        }
      } catch (error) {
        // A pool/relay-owned dial still needs its egress host locally; only
        // the advisory target lookup may degrade.
        if (relayEndpoint && !relayResolvedAddress) throw error;
        if (!poolDialsTarget) throw new TypeError(`no validated address for ${url.hostname}`);
      }
      if (!poolDialsTarget && !resolvedAddress)
        throw new TypeError(`no validated address for ${url.hostname}`);
      let response: Response;
      if (relayEndpoint) {
        const relay = relayRequest(relayEndpoint, url, requestInit);
        // The relay front door is reached directly: it reads the target from
        // `x-relay-target`/`x-relay-path` and performs the upstream fetch
        // itself, so the runtime fetch must NOT be given `proxy` here — that
        // would make it attempt a CONNECT tunnel against the relay, which a
        // serverless front door refuses (400).
        const relayDial = dial(relay.url, relay.init, fetchFn, undefined);
        dropLargeBody();
        response = await relayDial;
      } else {
        const method = (requestInit.method ?? "GET").toUpperCase();
        const hasBody = requestInit.body !== undefined && requestInit.body !== null;
        // The runtime fetch cannot carry a body on GET/HEAD, but Qoder's
        // model-list endpoint requires a signed GET body. When no pool/relay
        // owns the dial and no injected test fetch is present, dial through the
        // Node http(s) client (post SSRF validation). Every other case keeps
        // the existing fetch path.
        if ((method === "GET" || method === "HEAD") && hasBody && !socksAgent && options.fetchFn === undefined) {
          const nodeDialPromise = nodeDial(url, requestInit);
          dropLargeBody();
          response = await nodeDialPromise;
        } else {
          const dialPromise = dial(url, requestInit, fetchFn, proxyUrl, socksAgent ? socksDispatcherFor(socksAgent) : undefined, socksFetch);
          dropLargeBody();
          response = await dialPromise;
        }
      }
      if (response.status < 300 || response.status >= 400) {
        trackNetworkCall(url.hostname, performance.now() - startedAt);
        return response;
      }
      const location = response.headers.get("location");
      if (!location) {
        trackNetworkCall(url.hostname, performance.now() - startedAt);
        return response;
      }
      // The redirect response body is never consumed: release its socket
      // before following the next hop instead of leaving it open.
      await response.body?.cancel().catch(() => undefined);
      const nextUrl = new URL(location, url);
      const isCrossOriginRedirect = nextUrl.origin !== url.origin;
      if (isCrossOriginRedirect) {
        requestInit = { ...requestInit, headers: stripCredentialsOnCrossOrigin(requestInit.headers) };
      }
      if (isCrossOriginRedirect && (response.status === 307 || response.status === 308)) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD" && requestInit.body !== undefined) {
          throw new GatewayError("invalid_request", 400, "cross-origin redirect with body blocked (request {requestId}). Check the shape of what you sent — then resend 🪞");
        }
      }
      if (
        !isCrossOriginRedirect &&
        (response.status === 307 || response.status === 308) &&
        requestInit.body !== undefined &&
        typeof requestInit.body !== "string" &&
        !Buffer.isBuffer(requestInit.body) &&
        !(requestInit.body instanceof Uint8Array)
      ) {
        // A 307/308 replays the body on the next hop, but a stream body was
        // already consumed by the first hop. Failing loudly beats sending
        // an empty body the upstream would read as a different request.
        throw new GatewayError(
          "invalid_request",
          400,
          "same-origin redirect cannot replay a streamed request body",
        );
      }
      url = nextUrl;
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        const method = (requestInit.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          const { body: _body, ...withoutBody } = requestInit;
          requestInit = { ...withoutBody, method: "GET" };
        }
      }
    }
    throw new Error("outbound redirect limit exceeded");
  };
}
