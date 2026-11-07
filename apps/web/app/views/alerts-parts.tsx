"use client";

import { ApiClientError } from "../../lib/api";
import type {
  AlertSeverity,
  AlertType,
  AlertView,
  JobStatus,
  JobType,
  JobView,
} from "../../lib/types-alerts";

/** Time in the zone of the trip, so a reminder reads the way the traveller's clock does. */
export function when(
  value: string | null | undefined,
  timeZone: string,
): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

/** Message for a failed call. A provider or server failure says so instead of showing an empty list. */
export function alertsError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401)
      return "Your session has expired. Please sign in again.";
    if (error.status === 404)
      return "This trip is no longer available to your account.";
    if (error.status === 409) return error.message;
    if (error.status === 429)
      return "Too many requests. Wait a moment and try again.";
    if (error.status >= 500) {
      return `The alert service did not answer (${error.code}). Nothing is shown because nothing could be checked; try again.`;
    }
    return `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

const SEVERITY: Record<
  AlertSeverity,
  { label: string; glyph: string; meaning: string }
> = {
  info: { label: "Info", glyph: "i", meaning: "for your information" },
  low: { label: "Low", glyph: "▽", meaning: "keep an eye on it" },
  medium: { label: "Medium", glyph: "△", meaning: "worth acting on" },
  high: { label: "High", glyph: "▲", meaning: "act soon" },
  critical: { label: "Critical", glyph: "■", meaning: "act now" },
};

const TYPE_LABEL: Record<AlertType, string> = {
  departure_reminder: "Departure reminder",
  traffic_risk: "Traffic",
  weather_risk: "Weather",
};

/** Severity is written out as text and a shape, never as colour alone. */
export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const entry = SEVERITY[severity];
  return (
    <span className={`alr-severity ${severity}`}>
      <span aria-hidden="true">{entry.glyph}</span>
      <span>
        Severity: {entry.label}
        <span className="alr-visually-hidden"> ({entry.meaning})</span>
      </span>
    </span>
  );
}

export function severityRank(severity: AlertSeverity): number {
  return ["info", "low", "medium", "high", "critical"].indexOf(severity);
}

export function typeLabel(type: AlertType): string {
  return TYPE_LABEL[type];
}

export function AlertCard({
  alert,
  timeZone,
  busy,
  onRead,
  onDismiss,
}: {
  alert: AlertView;
  timeZone: string;
  busy: boolean;
  onRead: () => void;
  onDismiss: () => void;
}) {
  const headingId = `alert-${alert.id}`;
  return (
    <article
      className={`alr-card ${alert.status} sev-${alert.severity}`}
      aria-labelledby={headingId}
    >
      <div className="alr-top">
        <SeverityBadge severity={alert.severity} />
        <span className="tag sage">{typeLabel(alert.alert_type)}</span>
        <span className="alr-state">
          {alert.status === "unread"
            ? "Unread"
            : alert.status === "read"
              ? "Read"
              : "Dismissed"}
        </span>
      </div>
      <h3 id={headingId}>{alert.title}</h3>
      <dl className="alr-text">
        <div>
          <dt>What we found</dt>
          <dd>{alert.factual_summary}</dd>
        </div>
        <div>
          <dt>What you can do</dt>
          <dd>{alert.recommendation_summary}</dd>
        </div>
      </dl>
      <p className="alr-times">
        <span>Checked {when(alert.retrieved_at, timeZone)}</span>
        <span>Valid until {when(alert.expires_at, timeZone)}</span>
      </p>
      <details className="source-details">
        <summary>Source and freshness</summary>
        {alert.sources.length === 0 ? (
          <small>Source metadata is not available.</small>
        ) : null}
        {alert.sources.map((source) => (
          <div className="source-row" key={source.id}>
            <span>
              {source.title ?? source.provider} · {source.provider} ·{" "}
              {source.freshness}
            </span>
            <small>Retrieved {when(source.retrieved_at, timeZone)}</small>
            {source.url ? (
              <a href={source.url} target="_blank" rel="noreferrer">
                Open source ↗
              </a>
            ) : null}
          </div>
        ))}
      </details>
      {alert.status !== "dismissed" ? (
        <div className="button-row">
          {alert.status === "unread" ? (
            <button
              className="button secondary"
              disabled={busy}
              onClick={onRead}
              type="button"
              aria-label={`Mark as read: ${alert.title}`}
            >
              Mark as read
            </button>
          ) : null}
          <button
            className="button ghost"
            disabled={busy}
            onClick={onDismiss}
            type="button"
            aria-label={`Dismiss: ${alert.title}`}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </article>
  );
}

const JOB_TYPE_LABEL: Record<JobType, string> = {
  refresh_weather: "Weather refresh",
  refresh_traffic: "Traffic refresh",
  evaluate_alerts: "Alert check",
  departure_reminder: "Departure reminder",
  generate_invoice: "Invoice creation",
  send_invoice_email: "Invoice email",
};

const JOB_STATUS_TEXT: Record<JobStatus, string> = {
  queued: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

function outcomeText(job: JobView): string | null {
  const outcome = job.result_summary?.outcome;
  if (typeof outcome !== "string") return null;
  const names: Record<string, string> = {
    alert_created: "Alert created",
    alert_deduplicated: "Alert already existed",
    no_action: "Nothing to report",
    snapshot_refreshed: "Data refreshed",
    cancelled: "Cancelled before it started",
  };
  return names[outcome] ?? outcome;
}

export function JobRow({
  job,
  timeZone,
  busy,
  onRerun,
}: {
  job: JobView;
  timeZone: string;
  busy: boolean;
  onRerun: () => void;
}) {
  const problem = job.status === "failed" || job.status === "interrupted";
  return (
    <li className={`alr-job ${job.status}`}>
      <div className="alr-job-main">
        <strong>{JOB_TYPE_LABEL[job.job_type]}</strong>
        <span className={`alr-job-status ${problem ? "problem" : ""}`}>
          Status: {JOB_STATUS_TEXT[job.status]}
        </span>
        <small>{when(job.completed_at ?? job.run_at, timeZone)}</small>
      </div>
      {outcomeText(job) && !problem ? <small>{outcomeText(job)}</small> : null}
      {problem ? (
        <small className="alr-job-error">
          {job.error_message ?? "The job did not finish."} (
          {job.error_code ?? "UNKNOWN"}). Nothing was estimated and nothing was
          retried.
        </small>
      ) : null}
      {job.parent_job_id ? <small>Run again of an earlier job</small> : null}
      {job.can_rerun ? (
        <button
          className="button secondary"
          disabled={busy}
          onClick={onRerun}
          type="button"
          aria-label={`Run again: ${JOB_TYPE_LABEL[job.job_type]}`}
        >
          Run again
        </button>
      ) : null}
    </li>
  );
}
