import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createValidatedFetch } from "../../src/network/outbound-fetch";
import { createHttpProxyAgent } from "../../src/network/pool/agent";
import { metrics } from "../../src/observability/metrics";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function startHttpServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok-http1");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function counterValue(name: string): number {
  const match = metrics.render().match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, "m"));
  return match ? Number(match[1]) : 0;
}

const loopbackPolicy = { allowPrivate: true } as const;
const resolveLoopback = async (): Promise<readonly string[]> => ["127.0.0.1"];

describe("createValidatedFetch transport selection", () => {
  test("uses the pinned HTTP/1.1 path for a direct dial", async () => {
    const port = await startHttpServer();
    const fetchFn = createValidatedFetch({
      policy: loopbackPolicy,
      resolveFn: resolveLoopback,
    });
    const response = await fetchFn(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok-http1");
  });

  test("pool-bound dial still egresses when local target DNS fails (broken VPN resolver)", async () => {
    // A minimal CONNECT proxy: tunnels the caller's stream verbatim to the
    // requested host:port (the proxy resolves the target itself, never the
    // gateway's system resolver).
    const proxies: net.Server[] = [];
    const startConnectProxy = (): Promise<number> => {
      const { promise, resolve } = Promise.withResolvers<number>();
      const server = net.createServer((socket) => {
        socket.once("data", (first) => {
          const line = first.toString().split("\r\n")[0] ?? "";
          const match = /^CONNECT ([^:]+):(\d+) /.exec(line);
          if (!match) {
            socket.end();
            return;
          }
          /**
           * The CONNECT host is the target hostname (unresolvable locally by
           * design in this test). The proxy resolves its own answer — here the
           * origin server lives on loopback, so dial 127.0.0.1:port the same
           * way a real proxy would dial the address it resolved.
           */
          const upstream = net.connect(Number(match[2]), "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
            upstream.pipe(socket);
            socket.pipe(upstream);
          });
          upstream.on("error", () => socket.end());
        });
      });
      proxies.push(server);
      server.listen(0, "127.0.0.1", () =>
        resolve((server.address() as AddressInfo).port),
      );
      return promise;
    };
    try {
      const targetPort = await startHttpServer();
      const proxyPort = await startConnectProxy();
      const agent = createHttpProxyAgent(`http://127.0.0.1:${proxyPort}`, undefined, loopbackPolicy);
      const before = counterValue("cartethyia_proxy_dial_dns_fallback_total");

      // Broken-VPN DNS: the target hostname fails to resolve locally, but the
      // proxy address (127.0.0.1) resolves. The CONNECT proxy resolves the
      // target itself, so egress must still succeed.
      const failingResolve = async (hostname: string): Promise<readonly string[]> => {
        if (hostname === "127.0.0.1") return ["127.0.0.1"];
        throw new Error("upstream DNS resolution failed");
      };
      const fetchFn = createValidatedFetch({
        policy: loopbackPolicy,
        resolveFn: failingResolve,
        agent,
      });

      const response = await fetchFn(`http://target.invalid:${targetPort}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok-http1");
      expect(counterValue("cartethyia_proxy_dial_dns_fallback_total")).toBe(before + 1);
    } finally {
      for (const p of proxies.splice(0)) p.close();
    }
  });
});

describe("createValidatedFetch response decompression", () => {
  // `node:http` does not decode `content-encoding`, unlike `fetch`/Undici, so the
  // pinned path must decode it itself. Rebuilding a `Response` around the raw
  // compressed stream made `response.text()` return binary garbage — which
  // surfaced as `platform_unavailable: <provider> response is not valid JSON`
  // for the upstreams that compress (Anthropic answers `br`).
  function startCompressedServer(encoding: string, body: string, encode: (s: string) => Buffer) {
    return new Promise<number>((resolve) => {
      const server = http.createServer((_req, res) => {
        const compressed = encode(body);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": encoding,
        });
        res.end(compressed);
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  }

  test("decodes a brotli body and drops the content-encoding header", async () => {
    const { brotliCompressSync } = await import("node:zlib");
    const payload = JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }] });
    const port = await startCompressedServer("br", payload, (s) => brotliCompressSync(s));
    const fetchFn = createValidatedFetch({ policy: loopbackPolicy, resolveFn: resolveLoopback });

    const response = await fetchFn(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    // The header must not survive, or a caller would decode a decoded body.
    expect(response.headers.get("content-encoding")).toBeNull();
    // The body must be the real JSON, not raw brotli bytes.
    expect(JSON.parse(await response.text())).toEqual({
      type: "message",
      content: [{ type: "text", text: "OK" }],
    });
  });

  test("decodes a gzip body", async () => {
    const { gzipSync } = await import("node:zlib");
    const port = await startCompressedServer("gzip", "hello-gzip", (s) => gzipSync(s));
    const fetchFn = createValidatedFetch({ policy: loopbackPolicy, resolveFn: resolveLoopback });

    const response = await fetchFn(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("hello-gzip");
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("leaves an un-decodable encoding header in place for the caller", async () => {
    // zstd is not decoded here; forwarding the header with the raw body keeps
    // the caller's own decoder in charge rather than claiming a plain body.
    const port = await startCompressedServer("zstd", "ignored", (s) => Buffer.from(s));
    const fetchFn = createValidatedFetch({ policy: loopbackPolicy, resolveFn: resolveLoopback });

    const response = await fetchFn(`http://127.0.0.1:${port}/`);
    expect(response.headers.get("content-encoding")).toBe("zstd");
  });
});
