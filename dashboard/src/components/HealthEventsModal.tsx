import { Activity, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { DataTable } from "./ui/layout";
import { Inline } from "./ui/inline";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { useAccountHealthEvents, useRecoverAccount } from "../hooks/providers";

/**
 * The account health & error log dialog shared by the Quota page and provider detail.
 */
export interface AccountHealthSummary {
  readonly providerId: string;
  readonly accountId: string;
  /** Dialog title suffix — the account's label, name, or a short id. */
  readonly title: string;
  readonly status: string;
  /** Error category badge, when the account's last failure has one. */
  readonly errorCategory?: string | undefined;
  /** Operator-facing error text, already sanitized by the backend. */
  readonly errorMessage?: string | undefined;
  /** Empty-state copy differs by page: the Quota view also lists check-ins. */
  readonly emptyMessage: string;
}

/** Recovery is offered for the one transient state the backend can recover. */
function isRecoverable(status: string): boolean {
  return status === "cooldown";
}

function statusTone(status: string): "ok" | "disabled" | "warn" {
  if (status === "active") return "ok";
  if (status === "disabled") return "disabled";
  return "warn";
}

export function HealthEventsModal({
  summary,
  onClose,
}: {
  readonly summary: AccountHealthSummary;
  readonly onClose: () => void;
}): ReactNode {
  const { providerId, accountId, title, status, errorCategory, errorMessage } = summary;
  const query = useAccountHealthEvents(providerId, accountId);
  const recover = useRecoverAccount();
  const events = query.data ?? [];

  return (
    <Dialog open={true} onClose={onClose} title={`Health & Error Log — ${title}`} size="xl">
      <div style={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            borderRadius: "10px",
            background: "var(--surface-2)",
            border: "1px solid var(--inner-border)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Inline gap="8px" style={{ flexWrap: "wrap" }}>
              <span style={{ fontSize: "13px", fontWeight: 600 }}>Account status:</span>
              <Badge tone={statusTone(status)} dot>{status.toUpperCase()}</Badge>
              {errorCategory ? (
                <Badge tone="warn" title={errorMessage ?? undefined}>{errorCategory}</Badge>
              ) : null}
            </Inline>
            {errorMessage ? (
              <p style={{ fontSize: "11.5px", color: "var(--red)", marginTop: "4px", overflowWrap: "anywhere" }}>
                {errorMessage}
              </p>
            ) : null}
          </div>
          {isRecoverable(status) ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<RotateCcw size={12} className={recover.isPending ? "animate-spin" : ""} />}
              disabled={recover.isPending}
              onClick={() => recover.mutate({ providerId, accountId }, { onSuccess: () => void query.refetch() })}
            >
              {recover.isPending ? "Recovering..." : "Recover Now"}
            </Button>
          ) : null}
        </div>

        <div style={{ minWidth: 0 }}>
          <h4
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--text-secondary)",
              marginBottom: "8px",
            }}
          >
            Transition Events & Audit ({events.length})
          </h4>
          {query.isPending ? (
            <LoadingState label="Loading health events..." />
          ) : query.isError ? (
            <ErrorState message="Failed to load health events" onRetry={() => void query.refetch()} />
          ) : events.length === 0 ? (
            <EmptyState title="No health events recorded" message={summary.emptyMessage} icon={<Activity size={20} />} />
          ) : (
            <div
              style={{
                maxHeight: "min(55dvh, 480px)",
                overflow: "auto",
                border: "1px solid var(--inner-border)",
                borderRadius: "8px",
              }}
            >
              <DataTable headers={["Timestamp", "From → To", "Model", "Category", "Reason / Details"]}>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td style={{ fontSize: "11px", color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                      {new Date(ev.createdAt).toLocaleString()}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                        {ev.fromStatus ?? "new"} →{" "}
                      </span>
                      <Badge tone={statusTone(ev.toStatus)}>{ev.toStatus}</Badge>
                    </td>
                    <td style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
                      {ev.modelId ?? "—"}
                    </td>
                    <td style={{ fontSize: "11.5px", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                      {ev.errorCategory ?? "—"}
                    </td>
                    <td style={{ fontSize: "11px", color: "var(--text-primary)", minWidth: "220px", maxWidth: "520px", overflowWrap: "anywhere" }}>
                      {ev.reason ?? "—"}
                    </td>
                  </tr>
                ))}
              </DataTable>
            </div>
          )}
        </div>

        <Inline justify="flex-end" gap="0px">
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </Inline>
      </div>
    </Dialog>
  );
}
