import { useState, type ReactElement } from "react";
import { ChevronRight } from "lucide-react";
import { Card } from "../../components/ui/card";
import type { ShareFamilyStatsData, ShareLinkPolicyData } from "../../hooks/share-data";

/** Compact token count: 1.2K / 84.2K / 3.4M. Matches the console's key cards. */
function compact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const amount = Math.max(0, value);
  if (amount >= 1_000_000_000) return `${Number((amount / 1_000_000_000).toFixed(2))}B`;
  if (amount >= 1_000_000) return `${Number((amount / 1_000_000).toFixed(2))}M`;
  if (amount >= 1_000) return `${Number((amount / 1_000).toFixed(2))}K`;
  return amount.toLocaleString();
}

/** "2 min ago" / "3 h ago" / a date once it is older than a day. */
function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Hour-of-day label for the axis, in the viewer's locale. */
function hourLabel(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:00`;
}

/**
 * The family quota, drawn in the hero.
 *
 * The figures are family totals — every key this link has issued — because the
 * allowance is shared, so a per-recipient number would understate what the link
 * has actually spent. A row with no limit shows its running total and no fill.
 */
export function ShareQuotaPanel({
  policy,
  stats,
}: {
  readonly policy: ShareLinkPolicyData;
  readonly stats: ShareFamilyStatsData | null;
}): ReactElement {
  const rows: readonly { label: string; used: number; limit: number | null }[] = [
    { label: "Lifetime", used: stats?.totals?.totalTokens ?? 0, limit: policy.oneTimeLimit },
    { label: "Daily", used: stats?.totals?.todayTokens ?? 0, limit: policy.dailyLimit },
    { label: "Monthly", used: stats?.totals?.monthTokens ?? 0, limit: policy.monthlyLimit },
  ];
  const recipients = stats?.recipients;
  return (
    <div className="share-quota">
      {rows.map((row) => {
        const ratio = row.limit && row.limit > 0 ? Math.min(1, row.used / row.limit) : 0;
        const over = row.limit !== null && row.limit > 0 && row.used > row.limit;
        const tone = over ? "is-over" : ratio >= 0.8 ? "is-warn" : "";
        return (
          <div className="share-quota-row" key={row.label}>
            <span className="share-quota-label">{row.label}</span>
            <div
              className="share-quota-track"
              title={
                row.limit
                  ? `${compact(row.used)} of ${compact(row.limit)} used`
                  : `${compact(row.used)} used (no limit set)`
              }
            >
              <div className={`share-quota-fill ${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
            <span className="share-quota-value">
              <strong>{compact(row.used)}</strong>
              {row.limit ? ` / ${compact(row.limit)}` : " used"}
            </span>
          </div>
        );
      })}
      <div className="share-quota-meta">
        <span className="share-meta-pill">RPM {policy.requestsPerMinute ?? "unlimited"}</span>
        <span className="share-meta-pill">Concurrent {policy.maxConcurrentRequests ?? "unlimited"}</span>
        {recipients ? (
          <span className="share-meta-pill">
            {recipients.active} / {recipients.total} recipients active
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 24-bar activity strip; gaps in the window read as empty bars, not a gap. */
function HourlySparkline({
  hourly,
}: {
  readonly hourly: ShareFamilyStatsData["hourly"];
}): ReactElement {
  const max = Math.max(1, ...hourly.map((bucket) => bucket.requests));
  const slot = 10;
  const width = hourly.length * slot;
  const height = 44;
  return (
    <div>
      <svg
        className="share-sparkline"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Requests per hour over the last 24 hours"
      >
        {hourly.map((bucket, index) => {
          const barHeight = Math.round((bucket.requests / max) * (height - 4));
          return (
            <rect
              key={bucket.hour}
              className={`share-sparkline-bar${bucket.requests === 0 ? " is-empty" : ""}`}
              x={index * slot + 1}
              y={height - Math.max(2, barHeight)}
              width={slot - 3}
              height={Math.max(2, barHeight)}
              rx={1.5}
            />
          );
        })}
      </svg>
      <div className="share-hourly-axis">
        <span>{hourly.length ? hourLabel(hourly[0]!.hour) : ""}</span>
        <span>last 24h</span>
        <span>{hourly.length ? hourLabel(hourly[hourly.length - 1]!.hour) : ""}</span>
      </div>
    </div>
  );
}

/** A labelled count with a proportional bar, shared by the model and IP tables. */
function BarCell({
  value,
  max,
  label,
}: {
  readonly value: number;
  readonly max: number;
  readonly label: string;
}): ReactElement {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="share-stats-bar">
      <div className="share-stats-bar-track">
        <div className="share-stats-bar-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <span>{label}</span>
    </div>
  );
}

/**
 * Family activity: KPIs, a 24-hour strip, top models and top client IPs.
 *
 * Collapsed by default — the page's job is to hand out a key, and this is the
 * evidence behind the quota, not the thing the recipient came for. IPs arrive
 * already masked from the gateway; nothing here unmasks them.
 */
export function ShareStatsSection({
  stats,
  loading,
}: {
  readonly stats: ShareFamilyStatsData | null;
  readonly loading: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const totals = stats?.totals;
  const models = stats?.models ?? [];
  const ips = stats?.clientIps ?? [];
  const maxModelTokens = Math.max(1, ...models.map((model) => model.tokens));
  const maxIpRequests = Math.max(1, ...ips.map((ip) => ip.requests));

  return (
    <Card className="share-hud-card share-stats">
      <button
        type="button"
        className="share-stats-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          size={14}
          className={`share-stats-chevron${open ? " is-open" : ""}`}
          aria-hidden="true"
        />
        <span className="share-stats-title">STATS &amp; ACTIVITY</span>
        <span className="share-stats-summary">
          <span>{ips.length} IPs</span>
          <span>·</span>
          <span>{models.length} models</span>
          <span>·</span>
          <span>{compact(totals?.requests ?? 0)} req</span>
        </span>
      </button>

      {open ? (
        <div className="share-stats-body">
          {loading && !stats ? (
            <p className="share-stats-empty">Loading activity…</p>
          ) : !stats ? (
            <p className="share-stats-empty">Activity is unavailable right now.</p>
          ) : (
            <>
              <div className="share-stats-kpis">
                <div className="share-stat-tile">
                  <span className="share-stat-tile-label">Requests</span>
                  <span className="share-stat-tile-value">{compact(totals?.requests ?? 0)}</span>
                  <span className="share-stat-tile-detail">
                    {compact(totals?.errors ?? 0)} errors
                  </span>
                </div>
                <div className="share-stat-tile">
                  <span className="share-stat-tile-label">Tokens</span>
                  <span className="share-stat-tile-value">{compact(totals?.totalTokens ?? 0)}</span>
                  <span className="share-stat-tile-detail">all time</span>
                </div>
                <div className="share-stat-tile">
                  <span className="share-stat-tile-label">Last hour</span>
                  <span className="share-stat-tile-value">{compact(totals?.lastHourRequests ?? 0)}</span>
                  <span className="share-stat-tile-detail">requests in 60 min</span>
                </div>
                <div className="share-stat-tile">
                  <span className="share-stat-tile-label">Models</span>
                  <span className="share-stat-tile-value">{models.length}</span>
                  <span className="share-stat-tile-detail">in use</span>
                </div>
              </div>

              <HourlySparkline hourly={stats.hourly} />

              <section aria-label="Top models">
                <div className="share-section-heading">
                  <h3 className="share-stats-title">TOP MODELS</h3>
                </div>
                {models.length === 0 ? (
                  <p className="share-stats-empty">No model traffic yet.</p>
                ) : (
                  <table className="share-stats-table">
                    <thead>
                      <tr>
                        <th scope="col" aria-label="Rank" />
                        <th scope="col">Model</th>
                        <th scope="col" className="is-numeric">
                          Req
                        </th>
                        <th scope="col">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((model, index) => (
                        <tr key={`${model.providerId ?? ""}/${model.modelId}`}>
                          <td className="share-stats-rank">{index + 1}</td>
                          <td>
                            <span className="share-stats-model">
                              <code title={model.modelId}>{model.modelId}</code>
                              {model.providerId ? <span>{model.providerId}</span> : null}
                            </span>
                          </td>
                          <td className="is-numeric">{model.requests.toLocaleString()}</td>
                          <td>
                            <BarCell
                              value={model.tokens}
                              max={maxModelTokens}
                              label={compact(model.tokens)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section aria-label="Client IPs">
                <div className="share-section-heading">
                  <h3 className="share-stats-title">CLIENT IPS</h3>
                </div>
                {ips.length === 0 ? (
                  <p className="share-stats-empty">No client addresses recorded yet.</p>
                ) : (
                  <table className="share-stats-table">
                    <thead>
                      <tr>
                        <th scope="col">Address</th>
                        <th scope="col" className="is-numeric">
                          Req
                        </th>
                        <th scope="col">Tokens</th>
                        <th scope="col">Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ips.map((ip) => (
                        <tr key={ip.ip}>
                          <td>
                            <code>{ip.ip}</code>
                          </td>
                          <td className="is-numeric">{ip.requests.toLocaleString()}</td>
                          <td>
                            <BarCell value={ip.requests} max={maxIpRequests} label={compact(ip.tokens)} />
                          </td>
                          <td>{relativeTime(ip.lastSeenAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}
