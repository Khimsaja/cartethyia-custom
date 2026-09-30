import { useEffect, useRef, useState, type ReactElement } from "react";
import { Home, Moon, Sun, X } from "lucide-react";
import { useModalFocus } from "../../hooks/use-modal-focus";
import { Button } from "../../components/ui/button";
import { Card, CardBody } from "../../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { ClipboardButton } from "../../components/patterns/clipboard-button";
import { GithubBadge } from "../../components/patterns/github-badge";
import { readConsoleTheme, applyConsoleTheme, isDarkEffective, writeConsoleTheme, type ConsoleThemeChoice } from "../../shared/theme";
import { useShareData, type ShareFamilyStatsData, type ShareLinkData } from "../../hooks/share-data";
import { ShareQuotaPanel, ShareStatsSection } from "./stats";
import {
  deleteStoredShareKey,
  readStoredShareKey,
  writeStoredShareKey,
  type StoredShareKey,
} from "../../shared/share-key-storage";

interface IssueResult { key: string; keyId: string; keyPrefix: string; createdAt: string }
interface ApiError { error?: string | { code?: string; message?: string }; message?: string }
function message(payload: ApiError): string {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? payload.message ?? "Unable to generate an API key.";
}

export function tokenFromPathname(pathname: string): string {
  const path = pathname.replace(/\/$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Hint the recipient types: capped at 20 chars, only ~7 survive the label. */
const NAME_HINT_MAX_LENGTH = 20;

export function SharePage(): ReactElement {
  const path = typeof window === "undefined" ? "/share" : window.location.pathname.replace(/\/$/, "");
  const dataPath = `${path}/data`;
  const issuePath = `${path}/issue`;
  const linkToken = typeof window === "undefined" ? "" : tokenFromPathname(path);
  // The gateway cannot know the origin a share page is reached by — a tunnel, a
  // reverse proxy, or the operator's own public origin can all differ from the
  // request's view. The browser is the only party that knows for certain, so
  // the endpoint the recipient is told to call is derived here.
  const baseUrl = typeof window === "undefined" ? "" : window.location.origin;
  const state = useShareData<ShareLinkData>(dataPath);
  // Family activity for the stats section. Loaded alongside the policy so the
  // section is ready the moment the recipient expands it, and kept separate so
  // a stats failure never blocks the page or the key it hands out.
  const statsState = useShareData<ShareFamilyStatsData>(`${path}/stats`);
  const [secret, setSecret] = useState<IssueResult | null>(null);
  const [restoredSecret, setRestoredSecret] = useState<StoredShareKey | null>(null);
  // The recipient's display-name hint for the issued key. The backend keeps
  // only the first ~7 chars and appends its own random suffix, so a short
  // hint survives verbatim and a long one is trimmed, never rejected.
  const [nameHint, setNameHint] = useState("");
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueConflict, setIssueConflict] = useState(false);
  const [sharePopupOpen, setSharePopupOpen] = useState(false);
  const sharePopupRef = useRef<HTMLElement>(null);
  useModalFocus({ open: sharePopupOpen, mounted: sharePopupOpen, panelRef: sharePopupRef, onClose: () => setSharePopupOpen(false) });
  // Dark is the default reading of the share HUD; the toggle beside Home flips
  // the same `console-theme` preference the console uses.
  const [theme, setTheme] = useState<ConsoleThemeChoice>(() => readConsoleTheme("dark"));
  // The allowed-model list has two readings: the flat allowlist as written
  // ("raw") and the same set bucketed by provider ("grouped"). Raw is the
  // default because the exact id is what a client has to send.
  const [modelView, setModelView] = useState<"raw" | "grouped">("raw");
  useEffect(() => {
    document.title = "Cartethyia — Shared access";
    // The public share surface owns no theme of its own: it applies the console
    // `console-theme` preference through the same helper the console uses, so
    // both apps on this origin always resolve to the same tokens. The bootstrap
    // in `index.html` resolves the same key before the bundle loads, defaulting
    // an unset preference to dark on the share page.
    setTheme(readConsoleTheme("dark"));
    applyConsoleTheme(readConsoleTheme("dark"));
  }, []);
  const enrollment = state.data?.kind === "enroll" ? state.data : null;
  useEffect(() => {
    let active = true;
    setSecret(null);
    setRestoredSecret(null);
    setStorageWarning(null);
    // Only an enrollment link mints a key worth remembering: a handoff link is
    // re-read from the gateway on every visit, so a local copy would only go
    // stale, and an endpoint that rejects the link must not leave one behind.
    if (!linkToken || !enrollment) {
      if (state.error) {
        void deleteStoredShareKey(linkToken).catch(() => undefined);
      }
      return;
    }
    void readStoredShareKey(linkToken)
      .then((stored) => {
        if (active && stored) {
          setRestoredSecret(stored);
          setSecret(null);
        }
      })
      .catch(() => {
        if (active) {
          setStorageWarning("This browser could not read the stored key. Issue a new key only if this enrollment permits one.");
        }
      });
    return () => { active = false; };
  }, [linkToken, enrollment, state.error]);
  const issue = async () => {
    setIssueBusy(true);
    setIssueError(null);
    setStorageWarning(null);
    try {
      const response = await fetch(issuePath, { method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify(nameHint.trim() ? { nameHint: nameHint.trim().slice(0, NAME_HINT_MAX_LENGTH) } : {}) });
      const payload = await response.json() as IssueResult | ApiError;
      if (!response.ok) {
        if (response.status === 409) setIssueConflict(true);
        setIssueError(response.status === 409 ? "A recipient from this IP already has an active key for a share. This link cannot issue another key." : message(payload as ApiError));
        return;
      }
      const issued = payload as IssueResult;
      setRestoredSecret(null);
      setSecret(issued);
      if (!linkToken) return;
      try {
        await writeStoredShareKey(linkToken, {
          key: issued.key,
          keyId: issued.keyId,
          keyPrefix: issued.keyPrefix,
          createdAt: issued.createdAt,
        });
        setRestoredSecret({
          key: issued.key,
          keyId: issued.keyId,
          keyPrefix: issued.keyPrefix,
          createdAt: issued.createdAt,
        });
        setSecret(null);
      } catch {
        setStorageWarning("Your key was issued, but this browser could not save it. Copy it now: refreshing will not restore it.");
      }
    } catch {
      setIssueError("Unable to reach the Cartethyia gateway. Please try again.");
    } finally { setIssueBusy(false); }
  };
  const visibleSecret = restoredSecret ?? secret;
  const data = state.data;
  // Only an enrollment link can mint; a handoff link already carries its key.
  const canIssue =
    Boolean(enrollment?.canIssue) && !enrollment?.alreadyIssued && !issueConflict && !visibleSecret;
  const handoffKey = data?.kind === "handoff" ? data.key : null;
  const modelGroups = new Map<string, string[]>();
  for (const model of data?.modelAllowlist ?? []) {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "Other";
    const models = modelGroups.get(provider) ?? [];
    models.push(model);
    modelGroups.set(provider, models);
  }
  return (
    <div className="share-page">
      <header className="share-topbar">
        <div className="share-topbar-inner">
          <a className="share-brand" href="/">
            <span className="share-brand-mark" aria-hidden="true">
              <img
                src={`${import.meta.env.BASE_URL}favicon_love.webp`}
                alt=""
                width={34}
                height={34}
              />
            </span>
            <b>Cartethyia</b>
          </a>
          <div className="share-topbar-actions">
            <GithubBadge className="share-github-badge" />
            <button
              type="button"
              className="share-icon-button"
              onClick={() => {
                const next: ConsoleThemeChoice = isDarkEffective(theme) ? "light" : "dark";
                setTheme(next);
                writeConsoleTheme(next);
              }}
              aria-label="Toggle theme"
              aria-pressed={isDarkEffective(theme)}
              title={isDarkEffective(theme) ? "Switch to light mode" : "Switch to dark mode"}
            >
              {isDarkEffective(theme) ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <a href="/" className="share-home-link">
              <Home size={13} aria-hidden="true" /> Home
            </a>
          </div>
        </div>
      </header>
      <main className="share-main">
        {state.loading ? (
          <Card className="share-hud-card">
            <CardBody>
              <LoadingState label="Loading enrollment policy…" />
            </CardBody>
          </Card>
        ) : state.error ? (
          <Card className="share-hud-card">
            <CardBody>
              <ErrorState
                title="Link not available"
                message={state.error}
                onRetry={() => window.location.reload()}
              />
            </CardBody>
          </Card>
        ) : data ? (
          <>
            <Card className="share-hud-card share-hero">
              <p className="share-eyebrow">
                {data.kind === "handoff" ? "SHARED ACCESS / KEY" : "SHARED ACCESS / ENROLLMENT"}
              </p>
              <h1>{data.name || "Shared API access"}</h1>
              {data.kind === "handoff" ? (
                <p className="share-hero-description">
                  The API key for this gateway, provided through a share link. It is subject to the
                  limits below.
                </p>
              ) : null}
              <div className="share-hero-meta">
                {data.expiresAt ? (
                  <span className="share-meta-pill">
                    Link expires {new Date(data.expiresAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
              <ShareQuotaPanel policy={data} stats={statsState.data} />
            </Card>

            <div className="share-credentials">
              <Card className="share-hud-card share-endpoint">
                <h2 className="share-eyebrow">BASE URL</h2>
                <div className="share-endpoint-field">
                  <code>{baseUrl}/v1</code>
                  <ClipboardButton
                    value={`${baseUrl}/v1`}
                    size="sm"
                    variant="secondary"
                    label="Copy URL"
                    copiedLabel="Copied"
                    aria-label="Copy Base URL"
                  />
                </div>
                <p>Point your SDK, Opencode, Claude Code, Droid, and any other CLI</p>
                {data.sharePopup.enabled ? (
                  <button
                    type="button"
                    className="share-support-trigger"
                    onClick={() => setSharePopupOpen(true)}
                    aria-haspopup="dialog"
                    aria-label="Open popup"
                  >
                    <span className="share-support-icon" aria-hidden="true">♡</span>
                    <span>
                      <strong>{data.sharePopup.title || "More information"}</strong>
                    </span>
                    <span className="share-support-arrow" aria-hidden="true">↗</span>
                  </button>
                ) : null}
              </Card>
              <Card className="share-hud-card share-key-panel">
                <h2 className="share-eyebrow">YOUR API KEY</h2>
                {data.kind === "handoff" ? (
                  handoffKey ? (
                    <div className="share-issued-secret" role="status">
                      <p className="share-once-notice">REVEALED BY THE LINK OWNER</p>
                      <code>{handoffKey}</code>
                      <div className="share-secret-actions">
                        <ClipboardButton
                          value={handoffKey}
                          size="sm"
                          variant="primary"
                          label="Copy key"
                          copiedLabel="Copied"
                        />
                        <span>Prefix {data.keyPrefix ?? "—"}</span>
                      </div>
                      <p>
                        This link reveals the key itself, so anyone holding the URL can read it.
                        Keep the URL private; the link owner regenerates it to replace this key.
                      </p>
                    </div>
                  ) : (
                    <p className="share-key-placeholder">
                      This link can no longer reveal its key. Ask the link owner to regenerate it.
                    </p>
                  )
                ) : visibleSecret ? (
                  <div className="share-issued-secret" role="status">
                    <p className="share-once-notice">GENERATED ONCE · COPY AND KEEP IT</p>
                    <code>{visibleSecret.key}</code>
                    <div className="share-secret-actions">
                      <ClipboardButton
                        value={visibleSecret.key}
                        size="sm"
                        variant="primary"
                        label="Copy key"
                        copiedLabel="Copied"
                      />
                      <span>Key ID {visibleSecret.keyId.slice(0, 12)}…</span>
                    </div>
                    <p>
                      Saved in this browser while this enrollment link remains valid. It is not
                      shown again from another browser, and an expired, revoked, or unavailable
                      link does not restore a local copy.
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="share-key-placeholder">
                      {canIssue
                        ? "Issue a personal key to use the shared endpoint."
                        : "No key is available in this browser."}
                    </p>
                    {canIssue ? (
                      <>
                        <label className="share-name-field">
                          <span>Your name</span>
                          <input
                            type="text"
                            value={nameHint}
                            required
                            maxLength={NAME_HINT_MAX_LENGTH}
                            autoComplete="nickname"
                            onChange={(event) => setNameHint(event.target.value)}
                          />
                          <span className="share-name-hint">
                            Shown on your key (best kept to ~5 letters) — the gateway appends its own code.
                          </span>
                        </label>
                        <p className="share-name-required">Enter your name to generate a personal key.</p>
                        <Button
                          variant="primary"
                          size="sm"
                          loading={issueBusy}
                          disabled={issueBusy || !nameHint.trim()}
                          onClick={() => void issue()}
                        >
                          {issueBusy ? "Generating…" : "Generate API Key"}
                        </Button>
                      </>
                    ) : null}
                  </>
                )}
                {data.kind === "enroll" && !canIssue && !visibleSecret ? (
                  <p role="status" className="share-warning">
                    {enrollment?.alreadyIssued || issueConflict
                      ? "An active key has already been issued from this IP."
                      : issueError ?? "This enrollment link is not currently accepting key requests."}
                  </p>
                ) : null}
                {issueError && canIssue ? <p role="alert" className="form-error">{issueError}</p> : null}
                {storageWarning ? <p role="alert" className="form-error">{storageWarning}</p> : null}
              </Card>
            </div>

            {sharePopupOpen && data.sharePopup.enabled ? (
              <div
                className="share-support-overlay"
                role="presentation"
                onClick={(event) => {
                  if (event.target === event.currentTarget) setSharePopupOpen(false);
                }}
              >
                <section
                  ref={sharePopupRef}
                  tabIndex={-1}
                  className="share-support-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="share-support-title"
                >
                  <button type="button" className="share-support-close" onClick={() => setSharePopupOpen(false)} aria-label="Close popup">
                    <X size={18} aria-hidden="true" />
                  </button>
                  {data.sharePopup.hasImage ? (
                    <img
                      className="share-support-image"
                      src={`/share/${linkToken}/popup-image`}
                      alt=""
                    />
                  ) : (
                    <div className="share-support-image-placeholder" aria-hidden="true">
                      <span>♡</span>
                    </div>
                  )}
                  <div className="share-support-content">
                    <h2 id="share-support-title">{data.sharePopup.title || "More information"}</h2>
                    {data.sharePopup.body ? (
                      <p id="share-support-message" className="share-support-message">
                        {data.sharePopup.body}
                      </p>
                    ) : null}
                    <div className="share-support-actions">
                      <button type="button" className="share-support-dismiss" onClick={() => setSharePopupOpen(false)}>
                        Close
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            ) : null}
            {data.notes.title || data.notes.subtitle || data.notes.body ? (
              <Card className="share-hud-card share-notes">
                <h2 className="share-eyebrow">NOTES</h2>
                {data.notes.title ? <h3>{data.notes.title}</h3> : null}
                {data.notes.subtitle ? <p className="share-notes-subtitle">{data.notes.subtitle}</p> : null}
                {data.notes.body ? <p className="share-notes-body">{data.notes.body}</p> : null}
              </Card>
            ) : null}

            <ShareStatsSection stats={statsState.data} loading={statsState.loading} />

            <Card className="share-hud-card share-models">
              <div className="share-section-heading">
                <div>
                  <p className="share-eyebrow">MODEL ACCESS</p>
                  <h2>Allowed models</h2>
                </div>
                <div className="share-section-actions">
                  <div
                    className="share-view-switch"
                    role="tablist"
                    aria-label="Allowed model layout"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={modelView === "raw"}
                      className={modelView === "raw" ? "is-selected" : undefined}
                      onClick={() => setModelView("raw")}
                    >
                      Raw
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={modelView === "grouped"}
                      className={modelView === "grouped" ? "is-selected" : undefined}
                      onClick={() => setModelView("grouped")}
                    >
                      Grouped
                    </button>
                  </div>
                  {data.modelAllowlist.length ? (
                    <ClipboardButton
                      value={data.modelAllowlist.join(", ")}
                      size="sm"
                      variant="secondary"
                      label="Copy all"
                      copiedLabel="Copied"
                      aria-label="Copy all allowed models"
                    />
                  ) : null}
                </div>
              </div>
              {modelGroups.size ? (
                modelView === "raw" ? (
                  <ul className="share-model-list share-model-list-raw">
                    {data.modelAllowlist.map((model) => (
                      <li key={model}>
                        <code title={model}>{model}</code>
                        <ClipboardButton
                          value={model}
                          size="sm"
                          variant="secondary"
                          label="Copy"
                          copiedLabel="Copied"
                          aria-label={`Copy ${model}`}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="share-model-groups">
                    {[...modelGroups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, models]) => (
                      <section className="share-model-group" key={provider} aria-label={`${provider} models`}>
                        <div className="share-model-group-heading">
                          <h3>{provider}</h3>
                          <span>{models.length}</span>
                        </div>
                        <ul className="share-model-list">
                          {models.map((model) => (
                            <li key={model}>
                              <code title={model}>{provider === "Other" ? model : model.slice(provider.length + 1)}</code>
                              <ClipboardButton
                                value={model}
                                size="sm"
                                variant="secondary"
                                label="Copy"
                                copiedLabel="Copied"
                                aria-label={`Copy ${model}`}
                              />
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                )
              ) : (
                <p className="share-model-empty">Model access follows the share template policy.</p>
              )}
              {data.modelDenylist?.length ? (
                <p className="share-model-policy">Excluded models: {data.modelDenylist.join(", ")}</p>
              ) : null}
              {data.modelPrefix ? (
                <p className="share-model-policy">Required model prefix: {data.modelPrefix}</p>
              ) : null}
            </Card>
          </>
        ) : (
          <Card className="share-hud-card">
            <CardBody>
              <EmptyState
                title="No enrollment data"
                message="This enrollment link did not return usable policy data."
              />
            </CardBody>
          </Card>
        )}
      </main>
    </div>
  );
}
