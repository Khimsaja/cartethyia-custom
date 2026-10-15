// Daily check-in ride-along.
//
// WorkBuddy/CodeBuddy grant a free credit package once per calendar day. This
// claims it for every stored account and logs one line per account, so an
// operator can confirm each account got its daily login credit.
//
// It deliberately has no timer of its own: it rides along with the quota
// refresh sweep (`quota-refresh-sweep.ts`), which already resolves a fresh
// credential for each account every few minutes. Adding a second scheduled
// task would just duplicate that credential work for a once-a-day action.
//
// Budget is one attempt per account per day. A Redis day marker reserves the
// right to attempt, so a restart cannot double-post; the marker is released
// again when the attempt errors, so a transient failure retries on a later
// pass instead of forfeiting that day's grant.
//

import { and, eq } from "drizzle-orm";
import type { ValidatedFetch } from "../network/outbound-fetch";
import type { ValidatedNetworkBindingFactory } from "../network/pool/resolver";
import type { RedisClient } from "../persistence/redis";
import type { CartethyiaDatabase } from "../persistence/db-handle";
import { dailyCheckinLedger, networkPools } from "../persistence/schema";
import type { ProviderId } from "../providers/provider-contracts";
import { log } from "../observability/logger";
import { buddyAccountUid } from "../providers/integrations/buddy/buddy-oauth-shared";
import {
  DAILY_CHECKIN_PROVIDER_IDS,
  checkinDayKey,
  fetchBuddyActivityReport,
  fetchDailyCheckin,
  type BuddyActivityReportResult,
  type DailyCheckinResult,
} from "../providers/integrations/buddy/buddy-checkin";

export { DAILY_CHECKIN_PROVIDER_IDS, checkinDayKey };
export type { BuddyActivityReportResult, DailyCheckinResult };

/**
 * Pending check-in requests handed to the sweep by a caller outside it.
 *
 * A newly imported account is the reason this exists: the import path is
 * deliberately free of upstream calls so a paste of forty credentials lands as
 * one local write, and the credit claim therefore has to happen later. Rather
 * than giving it a second timer — which would duplicate the credential
 * resolution the quota sweep already does — the import enqueues here and the
 * sweep drains this on its next pass.
 *
 * Bounded: an import bigger than the cap drops the excess instead of growing
 * without limit, because every entry is still subject to the day marker and a
 * later pass picks the account up anyway. This queue is a nudge, not a
 * guarantee — it says "worth trying on the next pass", never "must run".
 */
const QUEUE_MAX = 200;
const checkinQueue = new Map<string, PendingCheckinRequest>();

/** One account a caller asked the sweep to consider for a check-in. */
export interface PendingCheckinRequest {
  readonly accountId: string;
  readonly providerId: string;
  readonly tenantId: string | null;
}

/** Accounts a caller has asked the sweep to check in, oldest request first. */
export function pendingCheckinRequests(): readonly PendingCheckinRequest[] {
  return [...checkinQueue.values()];
}

/** Number of accounts currently waiting. Bounded by `QUEUE_MAX`. */
export function pendingCheckinCount(): number {
  return checkinQueue.size;
}

/** Drops every queued request. Tests only. */
export function clearPendingCheckinRequests(): void {
  checkinQueue.clear();
}

/**
 * Queues a check-in for a newly added account.
 *
 * Non-blocking by construction: it records the id and returns, so an import
 * that adds a hundred accounts still answers as one local write. Returns
 * `false` for an account the check-in cannot serve at all (wrong provider, or
 * a queue already at its cap) so the caller can skip the work rather than
 * enqueue something the sweep would silently drop.
 */
export function enqueueCheckin(request: PendingCheckinRequest): boolean {
  if (!supportsDailyCheckin(request.providerId)) return false;
  // Already queued: keep the original position rather than re-inserting, which
  // in a Map would move it to the back and let a repeated import starve it.
  if (checkinQueue.has(request.accountId)) return true;
  // Oldest requests drain first, so a bounded queue drops the newest rather
  // than the ones that have already waited a pass. A dropped request is not a
  // lost check-in: the sweep reaches the account through its normal listing.
  if (checkinQueue.size >= QUEUE_MAX) return false;
  checkinQueue.set(request.accountId, request);
  return true;
}

/** Removes one account's queued request once the sweep has acted on it. */
export function dequeueCheckin(accountId: string): void {
  checkinQueue.delete(accountId);
}

const LEDGER_KEY_PREFIX = "cartethyia:daily-checkin";
/**
 * Ledger TTL. The key is already scoped to one calendar day, so the TTL only
 * needs to outlive that day; three days covers any timezone/clock skew without
 * relying on the key expiring for correctness.
 */
const LEDGER_TTL_SECONDS = 3 * 24 * 60 * 60;

/** The day-marker key for one account. Exported so the console reads the same key the sweep writes. */
export function ledgerKey(dayKey: string, accountId: string): string {
  return `${LEDGER_KEY_PREFIX}:${dayKey}:${accountId}`;
}

/**
 * True when this pass won the account's day slot and must do the work.
 *
 * Two guards, because the deployment shape decides which one is authoritative.
 * With Redis the `SET NX EX` is the cross-process guard (two gateway instances
 * cannot both attempt the same account). Without it the ledger *table* is the
 * guard, and its composite PK makes the insert atomic — so Lite records the
 * attempt it just made instead of silently returning `true`, which is what left
 * the console unable to answer "attempted today" and showing "Check-in due"
 * forever.
 */
async function reserveDaySlot(
  db: CartethyiaDatabase | undefined,
  redis: RedisClient | undefined,
  dayKey: string,
  accountId: string,
): Promise<boolean> {
  if (redis === undefined) {
    if (db === undefined) {
      // No ledger at all: one process needs no distributed guard, so the slot is
      // always won and the sweep's once-a-day cadence is the only throttle.
      return true;
    }
    // A handle without a query builder (the SQLite lite backend wraps its own)
    // cannot write the ledger. Fall back to "always won" rather than throwing:
    // the day marker is bookkeeping, and losing it costs a possible duplicate
    // claim tomorrow instead of forfeiting today's grant.
    if (typeof db.insert !== "function") return true;
    try {
      const inserted = await db
        .insert(dailyCheckinLedger)
        .values({ dayKey, accountId })
        .onConflictDoNothing()
        .returning({ accountId: dailyCheckinLedger.accountId });
      return inserted.length > 0;
    } catch (error) {
      log.warn(`[daily-checkin] ledger reserve failed for account=${accountId}`, error as Error);
      return true;
    }
  }
  const set = await redis.set(ledgerKey(dayKey, accountId), "1", "EX", LEDGER_TTL_SECONDS, "NX");
  return set !== null;
}

/**
 * Releases today's slot so a later pass can retry.
 *
 * Only transient outcomes release: `error` is a network/5xx failure and
 * `unavailable` means the probe could not be read — both are worth another
 * attempt, and holding the slot until tomorrow is what made an account look
 * "done" when nothing had been claimed. Terminal states keep the slot.
 */
async function releaseDaySlot(
  db: CartethyiaDatabase | undefined,
  redis: RedisClient | undefined,
  dayKey: string,
  accountId: string,
): Promise<void> {
  if (redis !== undefined) {
    await redis.del(ledgerKey(dayKey, accountId)).catch(() => undefined);
    return;
  }
  if (db === undefined) return;
  try {
    await db
      .delete(dailyCheckinLedger)
      .where(
        and(
          eq(dailyCheckinLedger.dayKey, dayKey),
          eq(dailyCheckinLedger.accountId, accountId),
        ),
      );
  } catch (error) {
    log.warn(`[daily-checkin] ledger release failed for account=${accountId}`, error as Error);
  }
}

/**
 * Stamps today's check-in slot for an account.
 *
 * Exists so a caller that deliberately bypasses the ledger — an operator
 * pressing "check in now" — still leaves the evidence that today's attempt
 * happened. Without the stamp the sweep re-POSTs the claim on its next pass
 * and the console reads "Check-in due" for an account that was checked in
 * minutes ago; the request itself is harmless (`forceClaim` answers
 * `already_claimed` upstream) but the day's budget is spent twice.
 *
 * Only writes the slot; it never releases one. A caller that attempted the
 * check-in is asserting "this account is settled for today", which is exactly
 * what the slot means.
 */
export async function markCheckinAttempted(args: {
  readonly db: CartethyiaDatabase | undefined;
  readonly redis: RedisClient | undefined;
  readonly accountId: string;
  readonly now?: () => Date;
}): Promise<void> {
  const dayKey = checkinDayKey(args.now?.() ?? new Date());
  if (args.redis !== undefined) {
    await args.redis
      .set(ledgerKey(dayKey, args.accountId), "1", "EX", LEDGER_TTL_SECONDS)
      .catch((error: unknown) => {
        log.warn(`[daily-checkin] ledger stamp failed for account=${args.accountId}`, error as Error);
      });
    return;
  }
  if (args.db === undefined) return;
  try {
    await args.db
      .insert(dailyCheckinLedger)
      .values({ dayKey, accountId: args.accountId })
      .onConflictDoNothing();
  } catch (error) {
    log.warn(`[daily-checkin] ledger stamp failed for account=${args.accountId}`, error as Error);
  }
}

/**
 * Reads whether today's check-in slot is settled for an account.
 *
 * The read belongs next to the writes because there are two places the marker
 * can live — the Redis key when Redis is present, the `daily_checkin_ledger`
 * row when it is not — and only this module knows which one its own writes
 * used. A caller that read the Redis key directly answered "not attempted" on
 * every Lite deployment, where the sweep had written the row.
 *
 * Absent or unreadable means unknown, never "not claimed": the sweep may
 * simply not have reached the account yet.
 */
export async function checkinAttemptedToday(args: {
  readonly db: CartethyiaDatabase | undefined;
  readonly redis: RedisClient | undefined;
  readonly accountId: string;
  readonly now?: () => Date;
}): Promise<boolean> {
  const dayKey = checkinDayKey(args.now?.() ?? new Date());
  if (args.redis !== undefined) {
    try {
      return (await args.redis.get(ledgerKey(dayKey, args.accountId))) !== null;
    } catch {
      return false;
    }
  }
  if (args.db === undefined) return false;
  try {
    const rows = await args.db
      .select({ dayKey: dailyCheckinLedger.dayKey })
      .from(dailyCheckinLedger)
      .where(
        and(
          eq(dailyCheckinLedger.dayKey, dayKey),
          eq(dailyCheckinLedger.accountId, args.accountId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Providers whose billing facade exposes the daily check-in routes. */
export function supportsDailyCheckin(providerId: string): boolean {
  return (DAILY_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

export type DailyGrowthPassResult = {
  readonly checkin: DailyCheckinResult;
  readonly report: BuddyActivityReportResult;
};

/**

/**
 * Runs the full daily growth pass for one account, once per calendar day:
 * the growth-activity report first, then the check-in claim.
 *
 * Report first because it is the leg that actually lands on a free plan — the
 * check-in activity is often not running at all (`unavailable`), and letting
 * the claim go first meant its state decided whether the report ran, so those
 * accounts got neither daily action. Each leg runs once; neither is retried
 * within the day.
 *
 * The day slot is reserved here, so a caller cannot double-claim. The report
 * leg exists only for the buddy family, so any other provider's pass is the
 * check-in alone and the report field carries a "not supported" marker rather
 * than a fabricated success. It needs a uid, which only a JWT carries, so an
 * opaque API key fails closed instead of reporting one account's activity under
 * another's uid. A report-side failure never releases the day slot: the day's
 * growth action was attempted, and spinning every sweep pass today buys
 * nothing.
 *
 * Returns `null` when no slot could be reserved (already settled today).
 */
export async function attemptDailyGrowthPass(args: {
  readonly db: CartethyiaDatabase | undefined;
  readonly redis: RedisClient | undefined;
  readonly providerId: ProviderId;
  readonly accountId: string;
  /** Refresh-aware credential resolution (the quota sweep's own resolver). */
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}): Promise<DailyGrowthPassResult | null> {
  const { db, redis, providerId, accountId, resolveCredential } = args;
  const dayKey = checkinDayKey(args.now?.() ?? new Date());

  let reserved = false;
  try {
    reserved = await reserveDaySlot(db, redis, dayKey, accountId);
  } catch (error) {
    log.warn(`[daily-checkin] ledger unavailable for account=${accountId}`, error as Error);
    reserved = true;
  }
  if (!reserved) return null;

  let credential = "";
  try {
    credential = await resolveCredential(providerId, accountId);
  } catch (error) {
    await releaseDaySlot(db, redis, dayKey, accountId);
    return {
      checkin: {
        providerId,
        accountId,
        state: "error",
        credit: null,
        streakDays: null,
        error: error instanceof Error ? error.message : "Daily check-in failed.",
      },
      report: {
        providerId,
        accountId,
        state: "error",
        error: "Skipped (check-in failed).",
      },
    };
  }

  // The growth-activity report runs FIRST, then the check-in claim.
  //
  // The report is the leg that works when the check-in hit does not: it lights
  // the login streak and scores the daily growth event without depending on the
  // check-in activity being open. Running the claim first meant an account
  // whose check-in was `unavailable` — the common case on a free plan — got
  // *neither* daily action, because the claim's state decided whether the
  // report ran at all. Putting the reliable leg first means the account always
  // gets at least its streak, and the claim is attempted after it regardless of
  // how the report went.
  //
  // The growth event scores by uid, and only a JWT carries one. An opaque API
  // key fails closed here — the sweep must never report one account's activity
  // under another account's uid.
  const userId = buddyAccountUid(credential);
  let report: BuddyActivityReportResult;
  if (!userId) {
    report = {
      providerId,
      accountId,
      state: "error",
      error: "Skipped (no uid in this credential).",
    };
  } else {
    try {
      report = await fetchBuddyActivityReport({
        providerId,
        accountId,
        credential,
        userId,
        fetcher: args.fetcher ?? globalThis.fetch,
      });
    } catch (error) {
      report = {
        providerId,
        accountId,
        state: "error",
        error: error instanceof Error ? error.message : "Activity report failed.",
      };
    }
  }

  let checkin: DailyCheckinResult;
  try {
    checkin = await fetchDailyCheckin({
      providerId,
      accountId,
      credential,
      fetcher: args.fetcher ?? globalThis.fetch,
    });
  } catch (error) {
    checkin = {
      providerId,
      accountId,
      state: "error",
      credit: null,
      streakDays: null,
      error: error instanceof Error ? error.message : "Daily check-in failed.",
    };
  }

  // Only a transient `error` releases the slot so a later pass today can retry
  // (network, 5xx). `unavailable` is the status probe answering that no
  // activity is running — retrying that every pass spent the account's daily
  // slot on a door the provider had closed, and releasing the marker was also
  // what erased the evidence that anything had been attempted: the console then
  // read "Check-in due" forever while the sweep retried once a minute.
  // `already_claimed`, `not_eligible`, and `event_ended` are terminal for the
  // day and keep the slot.
  //
  // A report-side failure never releases either: the day's growth action was
  // attempted, and spinning every sweep pass today buys nothing.
  if (checkin.state === "error") await releaseDaySlot(db, redis, dayKey, accountId);
  return { checkin, report };
}

/**
 * Builds the per-account fetcher for one quota-sweep pass.
 *
 * Active pools are read once per pass, then rotated per tenant. A tenant can
 * use its own pools and the global pools, but never another tenant's pools.
 */
export function dailyCheckinEgressForPass(args: {
  readonly db: CartethyiaDatabase;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
}): (accountId: string, tenantId?: string | null) => Promise<ValidatedFetch> {
  const { db, networkBindingFactory } = args;
  let poolsPromise: Promise<readonly { id: string; tenantId: string | null }[]> | undefined;
  const cursors = new Map<string, number>();

  return async (_accountId, tenantId) => {
    poolsPromise ??= Promise.resolve()
      .then(() =>
        db
          .select({ id: networkPools.id, tenantId: networkPools.tenantId })
          .from(networkPools)
          .where(eq(networkPools.status, "active")),
      )
      .catch(() => []);
    const pools = await poolsPromise;
    const global = pools.filter((pool) => pool.tenantId === null);
    const owned =
      tenantId === undefined || tenantId === null
        ? []
        : pools.filter((pool) => pool.tenantId === tenantId);
    const candidates = [...owned, ...global];
    if (candidates.length === 0) return globalThis.fetch;

    const cursorKey = tenantId ?? "global";
    const cursor = cursors.get(cursorKey) ?? 0;
    const pool = candidates[cursor % candidates.length]!;
    cursors.set(cursorKey, cursor + 1);
    try {
      return networkBindingFactory.fetch(pool.id, tenantId ?? undefined);
    } catch {
      return globalThis.fetch;
    }
  };
}
