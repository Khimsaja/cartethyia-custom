// Family-wide activity rollup for a public share link.
//
// The share page is the *recipient's* view, but the figures it needs are the
// template's: the quota is shared, so "how much has this link used" only means
// something as a total across every key the link has issued. This port answers
// that from telemetry, in one pass per shape, and never returns a raw client
// IP — the recipient is outside the tenant, so IPs leave masked regardless of
// the tenant's console privacy preference.
//
// Everything here is read-only and payload-free: token counts, model slugs,
// masked addresses. No request or response bodies cross this boundary.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { maskClientIp } from "../../observability/redaction";
import { gatewayErrorSql } from "../../observability/telemetry-status";
import { telemetryEvents } from "../../persistence/schema";

/** Totals for the whole share family, all-time plus the windows the UI draws. */
export interface ShareFamilyTotals {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Requests in the last 60 minutes. */
  readonly lastHourRequests: number;
  /** Tokens spent since 00:00 UTC — what the daily limit is compared against. */
  readonly todayTokens: number;
  /** Tokens spent since the 1st of the month UTC — the monthly limit's figure. */
  readonly monthTokens: number;
}

/** One hour bucket of the last 24 hours, oldest first. */
export interface ShareHourlyBucket {
  /** ISO instant at the top of the hour. */
  readonly hour: string;
  readonly requests: number;
}

export interface ShareTopModel {
  readonly providerId: string | null;
  readonly modelId: string;
  readonly requests: number;
  readonly tokens: number;
}

export interface ShareTopClientIp {
  /** Always masked: this payload is served to the recipient, not the tenant. */
  readonly ip: string;
  readonly requests: number;
  readonly tokens: number;
  readonly lastSeenAt: string | null;
}

export interface ShareFamilyStats {
  readonly totals: ShareFamilyTotals;
  readonly recipients: { readonly total: number; readonly active: number };
  /** 24 buckets, oldest first, gaps filled with zero. */
  readonly hourly: readonly ShareHourlyBucket[];
  readonly models: readonly ShareTopModel[];
  readonly clientIps: readonly ShareTopClientIp[];
}

/** Read-only family rollup for one share link. */
export interface ShareStatsPort {
  getFamilyStats(
    tenantId: string,
    keyIds: readonly string[],
    recipients: { readonly total: number; readonly active: number },
  ): Promise<ShareFamilyStats>;
}

const HOUR_MS = 3_600_000;

/** Start of the current UTC day. */
function utcDayStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** Start of the current UTC month. */
function utcMonthStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** Top of the hour containing `now`, in UTC. */
function utcHourStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

function emptyStats(
  recipients: { readonly total: number; readonly active: number },
): ShareFamilyStats {
  return {
    totals: {
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastHourRequests: 0,
      todayTokens: 0,
      monthTokens: 0,
    },
    recipients,
    hourly: [],
    models: [],
    clientIps: [],
  };
}

const TOP_MODELS_LIMIT = 8;
const TOP_IPS_LIMIT = 8;
const HOURS_WINDOW = 24;

export function createShareStatsPort(db: CartethyiaDatabase): ShareStatsPort {
  return {
    async getFamilyStats(tenantId, keyIds, recipients) {
      if (keyIds.length === 0) return emptyStats(recipients);

      const now = new Date();
      const dayStart = utcDayStart(now);
      const monthStart = utcMonthStart(now);
      const hourStart = utcHourStart(now);
      const lastHourStart = new Date(now.getTime() - HOUR_MS);
      const windowStart = new Date(hourStart.getTime() - (HOURS_WINDOW - 1) * HOUR_MS);

      const familyScope = and(
        eq(telemetryEvents.tenantId, tenantId),
        inArray(telemetryEvents.apiKeyId, [...keyIds]),
      );
      const tokenSum = sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)), 0)`;
      const tokenSumFiltered = (condition: ReturnType<typeof sql> | boolean) =>
        sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)) filter (where ${condition}), 0)`;

      const [totalsRows, hourlyRows, modelRows, ipRows] = await Promise.all([
        db
          .select({
            requests: sql<number>`count(*)`,
            errors: sql<number>`count(*) filter (where ${gatewayErrorSql(telemetryEvents.status, telemetryEvents.httpStatus)})`,
            inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
            lastHourRequests: sql<number>`count(*) filter (where ${telemetryEvents.createdAt} >= ${lastHourStart})`,
            todayTokens: tokenSumFiltered(sql`${telemetryEvents.createdAt} >= ${dayStart}`),
            monthTokens: tokenSumFiltered(sql`${telemetryEvents.createdAt} >= ${monthStart}`),
          })
          .from(telemetryEvents)
          .where(familyScope),
        db
          .select({
            hour: sql<string>`date_trunc('hour', ${telemetryEvents.createdAt})`,
            requests: sql<number>`count(*)`,
          })
          .from(telemetryEvents)
          .where(and(familyScope, gte(telemetryEvents.createdAt, windowStart)))
          .groupBy(sql`date_trunc('hour', ${telemetryEvents.createdAt})`),
        db
          .select({
            providerId: telemetryEvents.providerId,
            modelId: telemetryEvents.requestedModel,
            requests: sql<number>`count(*)`,
            tokens: tokenSum,
          })
          .from(telemetryEvents)
          .where(and(familyScope, sql`${telemetryEvents.requestedModel} is not null`))
          .groupBy(telemetryEvents.providerId, telemetryEvents.requestedModel)
          .orderBy(desc(sql`count(*)`))
          .limit(TOP_MODELS_LIMIT),
        db
          .select({
            clientIp: telemetryEvents.clientIp,
            requests: sql<number>`count(*)`,
            tokens: tokenSum,
            lastSeenAt: sql<string | null>`max(${telemetryEvents.createdAt})`,
          })
          .from(telemetryEvents)
          .where(and(familyScope, sql`${telemetryEvents.clientIp} is not null`))
          .groupBy(telemetryEvents.clientIp)
          .orderBy(desc(sql`count(*)`))
          .limit(TOP_IPS_LIMIT),
      ]);

      const totals = totalsRows[0];
      // Fill the 24 buckets in JS: SQL only returns hours that saw traffic, and
      // a chart drawn from sparse rows would silently compress the axis.
      const byHour = new Map<string, number>();
      for (const row of hourlyRows) {
        byHour.set(new Date(row.hour).toISOString(), Number(row.requests ?? 0));
      }
      const hourly: ShareHourlyBucket[] = [];
      for (let index = 0; index < HOURS_WINDOW; index += 1) {
        const hour = new Date(windowStart.getTime() + index * HOUR_MS).toISOString();
        hourly.push({ hour, requests: byHour.get(hour) ?? 0 });
      }

      return {
        totals: {
          requests: Number(totals?.requests ?? 0),
          errors: Number(totals?.errors ?? 0),
          inputTokens: Number(totals?.inputTokens ?? 0),
          outputTokens: Number(totals?.outputTokens ?? 0),
          totalTokens: Number(totals?.inputTokens ?? 0) + Number(totals?.outputTokens ?? 0),
          lastHourRequests: Number(totals?.lastHourRequests ?? 0),
          todayTokens: Number(totals?.todayTokens ?? 0),
          monthTokens: Number(totals?.monthTokens ?? 0),
        },
        recipients,
        hourly,
        models: modelRows.flatMap((row) =>
          typeof row.modelId !== "string"
            ? []
            : [
                {
                  providerId: row.providerId,
                  modelId: row.modelId,
                  requests: Number(row.requests ?? 0),
                  tokens: Number(row.tokens ?? 0),
                },
              ],
        ),
        clientIps: ipRows.flatMap((row) =>
          typeof row.clientIp !== "string"
            ? []
            : [
                {
                  ip: maskClientIp(row.clientIp),
                  requests: Number(row.requests ?? 0),
                  tokens: Number(row.tokens ?? 0),
                  lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt).toISOString(),
                },
              ],
        ),
      };
    },
  };
}
