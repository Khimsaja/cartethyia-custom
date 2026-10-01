/**
 * Model-abuse strikes: a graduated response to a client that repeatedly asks
 * for a model it may not use.
 *
 * A gateway request names a model; when that name is outside the key's
 * allowlist, denylisted, or resolves to nothing, the request is rejected 404
 * `model_not_found`. That rejection is a normal answer to one mistake — but a
 * client that keeps hitting it is not making a mistake, it is probing, and it
 * costs the operator real work: every attempt lands as a failed row in the
 * console and the share page, burying the traffic that matters.
 *
 * So the rejection escalates. Each *consecutive* invalid-model attempt records
 * a strike against the caller's IP and against its API key; the third strike
 * bans both. A valid-model request resets the counters, and a strike counter
 * expires on its own after a quiet window, so a single typo — or an honest
 * client that corrected itself — never accumulates toward a ban.
 *
 * **Two identities, one ban decision.** An IP alone is evaded by rotating keys;
 * a key alone is evaded by enrolling a new one from the same host. Recording
 * against both and banning on either closes both doors: a banned key cannot be
 * reused from a new IP, and a banned IP cannot mint a fresh key.
 *
 * **A ban is permanent until an operator lifts it** (there is no TTL), because
 * the abuse it answers is deliberate. The console lists bans and can remove
 * one, which is the only escape hatch — a false positive must be fixable.
 *
 * Fail-open on store outage: unlike admission (where admitting an unauthorized
 * request is worse than refusing a valid one), a strike layer that cannot read
 * its counter must not refuse a legitimate request. A store error is swallowed
 * and the request proceeds; the worst case is a missed strike, never a blocked
 * client.
 */
import { GatewayError } from "../transport/gateway-error";
import { redisEvalTuple, type RedisClient } from "../persistence/redis";

/** Which identity a ban is keyed on. */
export type ModelAbuseScope = "ip" | "api_key";

/** A ban row, for the console. */
export interface ModelAbuseBan {
  readonly scope: ModelAbuseScope;
  readonly identity: string;
}

/** One strike decision, as the store sees it. */
export interface ModelAbuseAttempt {
  readonly ip: string;
  readonly apiKeyId: string;
  /** Whether this attempt named a model the key may use. */
  readonly valid: boolean;
  /** Consecutive invalid attempts that trigger a ban. */
  readonly threshold: number;
  /** Quiet window (ms) after which a strike counter expires. */
  readonly windowMs: number;
}

/** What one strike decision decided. */
export interface ModelAbuseOutcome {
  /** The IP or key is banned, now or already. */
  readonly banned: boolean;
  /** Which identity is banned, when `banned` is true. */
  readonly scope?: ModelAbuseScope;
  /** Consecutive invalid attempts against the IP, after this one. `0` when valid. */
  readonly ipStrikes: number;
  /** Consecutive invalid attempts against the key, after this one. `0` when valid. */
  readonly keyStrikes: number;
  /** This attempt crossed the threshold and recorded the ban. */
  readonly bannedNow: boolean;
}

/**
 * The `{banned, ipCount, keyCount, bannedNow, scope}` tuple the script returns.
 * A value of the wrong length or with a non-finite member means the script and
 * its caller drifted; reading it as a decision would ban or admit on garbage, so
 * it throws — the service maps that to a swallowed fail-open, never a rejection.
 */
function decodeOutcome(raw: readonly unknown[]): ModelAbuseOutcome {
  if (raw.length !== 5) {
    throw new Error(`[model-abuse] script returned ${raw.length} elements, expected 5`);
  }
  const [bannedRaw, ipRaw, keyRaw, bannedNowRaw, scopeRaw] = raw.map((value) => Number(value));
  const banned = bannedRaw ?? NaN;
  const ipStrikes = ipRaw ?? NaN;
  const keyStrikes = keyRaw ?? NaN;
  const bannedNow = bannedNowRaw ?? NaN;
  const scope = scopeRaw ?? NaN;
  if (
    !Number.isFinite(banned) ||
    !Number.isFinite(ipStrikes) ||
    !Number.isFinite(keyStrikes) ||
    !Number.isFinite(bannedNow) ||
    !Number.isFinite(scope)
  ) {
    throw new Error(`[model-abuse] script returned a non-finite value: ${String(raw)}`);
  }
  const scopeName: ModelAbuseScope | undefined = scope === 1 ? "ip" : scope === 2 ? "api_key" : undefined;
  return {
    banned: banned === 1 || bannedNow === 1,
    ...(scopeName ? { scope: scopeName } : {}),
    ipStrikes,
    keyStrikes,
    bannedNow: bannedNow === 1,
  };
}

/** Serializes a ban member for the shared ban set: `<scope>|<identity>`. */
function banMember(scope: ModelAbuseScope, identity: string): string {
  return `${scope}|${identity}`;
}

/** Parses a ban member, or `null` when it is not the expected shape. */
function parseBanMember(member: string): ModelAbuseBan | null {
  const separator = member.indexOf("|");
  if (separator <= 0) return null;
  const scope = member.slice(0, separator);
  const identity = member.slice(separator + 1);
  if ((scope !== "ip" && scope !== "api_key") || identity.length === 0) return null;
  return { scope, identity };
}

export interface ModelAbuseStore {
  /**
   * One atomic strike decision: reads the ban, records the attempt against the
   * IP and key counters (or clears them on a valid attempt), and records a ban
   * when either counter reaches the threshold.
   */
  record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome>;
  /** O(1) ban lookup for the pre-parse gate: which identity (if any) is banned. */
  isBanned(input: { readonly ip: string; readonly apiKeyId: string }): Promise<ModelAbuseScope | null>;
  /** Every active ban, for the console. */
  listBans(): Promise<readonly ModelAbuseBan[]>;
  /** Removes one ban. Returns whether a ban existed. */
  unban(scope: ModelAbuseScope, identity: string): Promise<boolean>;
}

interface InMemoryOptions {
  readonly maxKeys?: number;
}

/**
 * In-memory strike store: two consecutive counters and one ban set.
 *
 * Counters are `<count, expiresAt>` pairs, so a quiet window expires a strike
 * without a sweeper; the ban set has no TTL — a ban is permanent until lifted.
 * Bounded by `maxKeys` on the counter maps (oldest evicted) so an adversarial
 * fan-out over unique identities cannot pin memory; the ban set is bounded by
 * the abuse itself, since each member cost three attempts to add.
 */
export class InMemoryModelAbuseStore implements ModelAbuseStore {
  private readonly ipStrikes = new Map<string, { count: number; expiresAt: number }>();
  private readonly keyStrikes = new Map<string, { count: number; expiresAt: number }>();
  private readonly bans = new Set<string>();
  private readonly maxKeys: number;

  constructor(private readonly clock: () => number = () => Date.now(), opts: InMemoryOptions = {}) {
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  private evictOldest(map: Map<string, { count: number; expiresAt: number }>): void {
    if (map.size < this.maxKeys) return;
    let toEvict = map.size - this.maxKeys + 1;
    for (const key of map.keys()) {
      if (toEvict-- <= 0) break;
      map.delete(key);
    }
  }

  private read(
    map: Map<string, { count: number; expiresAt: number }>,
    key: string,
    now: number,
  ): number {
    const entry = map.get(key);
    if (entry === undefined) return 0;
    if (entry.expiresAt <= now) {
      map.delete(key);
      return 0;
    }
    return entry.count;
  }

  private bump(
    map: Map<string, { count: number; expiresAt: number }>,
    key: string,
    now: number,
    windowMs: number,
  ): number {
    const current = this.read(map, key, now);
    const next = current + 1;
    this.evictOldest(map);
    map.set(key, { count: next, expiresAt: now + windowMs });
    return next;
  }

  async record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome> {
    const now = this.clock();
    const { ip, apiKeyId, valid, threshold, windowMs } = attempt;

    if (this.bans.has(banMember("ip", ip)))
      return { banned: true, scope: "ip", ipStrikes: 0, keyStrikes: 0, bannedNow: false };
    if (this.bans.has(banMember("api_key", apiKeyId)))
      return { banned: true, scope: "api_key", ipStrikes: 0, keyStrikes: 0, bannedNow: false };

    if (valid) {
      this.ipStrikes.delete(ip);
      this.keyStrikes.delete(apiKeyId);
      return { banned: false, ipStrikes: 0, keyStrikes: 0, bannedNow: false };
    }

    const ipStrikes = this.bump(this.ipStrikes, ip, now, windowMs);
    const keyStrikes = this.bump(this.keyStrikes, apiKeyId, now, windowMs);
    let bannedNow = false;
    let scope: ModelAbuseScope | undefined;
    if (ipStrikes >= threshold) {
      this.bans.add(banMember("ip", ip));
      bannedNow = true;
      scope = "ip";
    }
    if (keyStrikes >= threshold) {
      this.bans.add(banMember("api_key", apiKeyId));
      bannedNow = true;
      scope ??= "api_key";
    }
    return {
      banned: bannedNow,
      ...(scope ? { scope } : {}),
      ipStrikes,
      keyStrikes,
      bannedNow,
    };
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    return [...this.bans].map(parseBanMember).filter((ban): ban is ModelAbuseBan => ban !== null);
  }

  async isBanned(input: { readonly ip: string; readonly apiKeyId: string }): Promise<ModelAbuseScope | null> {
    if (this.bans.has(banMember("ip", input.ip))) return "ip";
    if (this.bans.has(banMember("api_key", input.apiKeyId))) return "api_key";
    return null;
  }

  async unban(scope: ModelAbuseScope, identity: string): Promise<boolean> {
    return this.bans.delete(banMember(scope, identity));
  }
}

/**
 * The one strike decision, as a static Lua script.
 *
 * `KEYS[1]` the IP strike counter, `KEYS[2]` the key strike counter, `KEYS[3]`
 * the ban set. `ARGV`: 1 windowMs, 2 threshold, 3 valid(`1`/`0`), 4 ip member,
 * 5 key member.
 *
 * Returns `{banned, ipCount, keyCount, bannedNow, scope}`. The ban is read first
 * and short-circuits without writing, so a banned identity cannot extend its own
 * counters. Counters carry the window as their TTL, so a quiet window expires a
 * strike with no sweeper. The ban set has no TTL — a ban is permanent until an
 * operator removes the member.
 */
const MODEL_ABUSE_SCRIPT = `
  if redis.call('SISMEMBER', KEYS[3], ARGV[4]) == 1 then
    return {1, 0, 0, 0, 1}
  end
  if redis.call('SISMEMBER', KEYS[3], ARGV[5]) == 1 then
    return {1, 0, 0, 0, 2}
  end
  if ARGV[3] == '1' then
    redis.call('DEL', KEYS[1])
    redis.call('DEL', KEYS[2])
    return {0, 0, 0, 0, 0}
  end
  local ipCount = redis.call('INCR', KEYS[1])
  if ipCount == 1 then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1])) end
  local keyCount = redis.call('INCR', KEYS[2])
  if keyCount == 1 then redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[1])) end
  local bannedNow = 0
  local scope = 0
  if ipCount >= tonumber(ARGV[2]) then
    redis.call('SADD', KEYS[3], ARGV[4])
    bannedNow = 1
    scope = 1
  end
  if keyCount >= tonumber(ARGV[2]) then
    redis.call('SADD', KEYS[3], ARGV[5])
    bannedNow = 1
    if scope == 0 then scope = 2 end
  end
  return {0, ipCount, keyCount, bannedNow, scope}
`;

export class RedisModelAbuseStore implements ModelAbuseStore {
  constructor(private readonly redis: RedisClient) {}

  private ipStrikeKey(ip: string): string {
    return `cartethyia:model-abuse:strike:ip:${ip}`;
  }
  private keyStrikeKey(apiKeyId: string): string {
    return `cartethyia:model-abuse:strike:key:${apiKeyId}`;
  }
  private banSetKey(): string {
    return "cartethyia:model-abuse:bans";
  }

  async record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome> {
    const { ip, apiKeyId, valid, threshold, windowMs } = attempt;
    const raw = await redisEvalTuple(
      this.redis,
      MODEL_ABUSE_SCRIPT,
      3,
      this.ipStrikeKey(ip),
      this.keyStrikeKey(apiKeyId),
      this.banSetKey(),
      String(Math.max(1, windowMs)),
      String(threshold),
      valid ? "1" : "0",
      banMember("ip", ip),
      banMember("api_key", apiKeyId),
    );
    return decodeOutcome(raw);
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    const members = (await this.redis.smembers(this.banSetKey())) as string[];
    return members.map(parseBanMember).filter((ban): ban is ModelAbuseBan => ban !== null);
  }

  async isBanned(input: { readonly ip: string; readonly apiKeyId: string }): Promise<ModelAbuseScope | null> {
    const [ipBanned, keyBanned] = await this.redis.smismember(this.banSetKey(), [
      banMember("ip", input.ip),
      banMember("api_key", input.apiKeyId),
    ]);
    if (Number(ipBanned) === 1) return "ip";
    if (Number(keyBanned) === 1) return "api_key";
    return null;
  }

  async unban(scope: ModelAbuseScope, identity: string): Promise<boolean> {
    const removed = await this.redis.srem(this.banSetKey(), banMember(scope, identity));
    return Number(removed) > 0;
  }
}

export interface ModelStrikeOptions {
  /** Consecutive invalid-model attempts that trigger a ban. Default 3. */
  readonly threshold?: number;
  /** Quiet window (ms) after which a strike counter expires. Default 5 minutes. */
  readonly windowMs?: number;
}

/**
 * Graduated model-abuse strikes over a store.
 *
 * `noteInvalid` is the hot path for a rejected model; `noteValid` clears a
 * strike but only writes when this process has actually seen a strike for the
 * identity, so a well-behaved client pays nothing. `listBans`/`unban` are the
 * console's escape hatch.
 */
export class ModelStrikeService {
  private readonly threshold: number;
  private readonly windowMs: number;
  /**
   * Identities this process has recorded a strike for, so `noteValid` can skip
   * the reset write for a client that was never struck. Process-local on
   * purpose: a miss only means a strike survives until its window expires
   * instead of being cleared early, which is the safe direction for abuse.
   */
  private readonly dirty = new Set<string>();

  constructor(private readonly store: ModelAbuseStore, opts: ModelStrikeOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? 3);
    this.windowMs = Math.max(1, opts.windowMs ?? 5 * 60_000);
  }

  /** The ban threshold, for an operator-facing warning message. */
  get limit(): number {
    return this.threshold;
  }

  private dirtyKey(ip: string, apiKeyId: string): string {
    return `${ip}|${apiKeyId}`;
  }

  /** Read-only ban lookup for the pre-parse gate. Throws only on store outage. */
  async check(input: { readonly ip: string; readonly apiKeyId: string }): Promise<ModelAbuseScope | null> {
    return this.store.isBanned(input);
  }

  /** Records one invalid-model attempt and returns the escalation decision. */
  async noteInvalid(input: { readonly ip: string; readonly apiKeyId: string }): Promise<ModelAbuseOutcome> {
    const outcome = await this.store.record({
      ip: input.ip,
      apiKeyId: input.apiKeyId,
      valid: false,
      threshold: this.threshold,
      windowMs: this.windowMs,
    });
    if (outcome.ipStrikes > 0 || outcome.keyStrikes > 0) this.dirty.add(this.dirtyKey(input.ip, input.apiKeyId));
    return outcome;
  }

  /**
   * Clears a strike after a valid-model request. Writes only when this process
   * saw a strike for the identity, so the reset never costs a round trip on a
   * client that has nothing to clear.
   */
  async noteValid(input: { readonly ip: string; readonly apiKeyId: string }): Promise<void> {
    const key = this.dirtyKey(input.ip, input.apiKeyId);
    if (!this.dirty.has(key)) return;
    this.dirty.delete(key);
    await this.store.record({
      ip: input.ip,
      apiKeyId: input.apiKeyId,
      valid: true,
      threshold: this.threshold,
      windowMs: this.windowMs,
    });
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    return this.store.listBans();
  }

  async unban(scope: ModelAbuseScope, identity: string): Promise<boolean> {
    return this.store.unban(scope, identity);
  }
}

/**
 * The typed rejection a banned caller receives. 403 with its own code so the
 * console and the client can tell an abuse ban from a per-request rejection.
 */
export function modelAbuseBannedError(scope: ModelAbuseScope | undefined): GatewayError {
  const what = scope === "api_key" ? "this API key" : "this client address";
  return new GatewayError(
    "model_abuse_banned",
    403,
    `${what} is banned for repeatedly requesting models it may not use`,
    { ...(scope ? { scope } : {}) },
  );
}

/**
 * The 404 a rejected model returns, carrying the escalating warning. The message
 * names the strike count so an honest client that mistyped is told exactly what
 * it is doing wrong before it is banned, instead of seeing the same generic 404
 * three times and then a wall.
 */
export function modelWarningMessage(
  model: string,
  outcome: ModelAbuseOutcome,
  limit: number,
): string {
  const strikes = Math.max(outcome.ipStrikes, outcome.keyStrikes);
  return (
    `Model '${model}' is not available to this API key. ` +
    `Warning ${strikes} of ${limit} — repeatedly requesting models outside your access will ban this client.`
  );
}
