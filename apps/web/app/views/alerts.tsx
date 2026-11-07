"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  dismissAlert,
  listAlerts,
  listJobs,
  markAlertRead,
  rerunJob,
} from "../../lib/api-alerts";
import type { AlertList, AlertView, JobView } from "../../lib/types-alerts";
import { AlertCard, JobRow, alertsError } from "./alerts-parts";
import type { ViewProps } from "./types";

/** Refresh every minute while the view is open, and when the window gets focus. */
const REFRESH_MS = 60_000;

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; list: AlertList };

/**
 * Alerts view (Segment 01, 6.9). Alerts exist only inside the application. A list that
 * could not be loaded is reported as unavailable, never as "no alerts".
 */
export default function AlertsView({ trip }: ViewProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestToken = useRef(0);

  const refresh = useCallback(async () => {
    const token = (requestToken.current += 1);
    try {
      const list = await listAlerts(trip.id, {
        includeDismissed: showDismissed,
      });
      if (token === requestToken.current) setLoad({ state: "ready", list });
    } catch (caught) {
      if (token === requestToken.current) {
        setLoad({ state: "error", message: alertsError(caught) });
      }
    }
    try {
      const result = await listJobs(trip.id, 8);
      if (token === requestToken.current) {
        setJobs(result.items);
        setJobsError(null);
      }
    } catch (caught) {
      if (token === requestToken.current) setJobsError(alertsError(caught));
    }
  }, [trip.id, showDismissed]);

  useEffect(() => {
    setLoad({ state: "loading" });
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  async function change(alert: AlertView, action: "read" | "dismiss") {
    setBusyId(alert.id);
    setActionError(null);
    setNotice(null);
    try {
      if (action === "read") await markAlertRead(trip.id, alert.id);
      else await dismissAlert(trip.id, alert.id);
      setNotice(
        action === "read" ? "Alert marked as read." : "Alert dismissed.",
      );
      await refresh();
    } catch (caught) {
      setActionError(alertsError(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function rerun(job: JobView) {
    setBusyId(job.id);
    setActionError(null);
    setNotice(null);
    try {
      await rerunJob(trip.id, job.id);
      setNotice(
        "The job was queued again as a new run. The earlier run keeps its record.",
      );
      await refresh();
    } catch (caught) {
      setActionError(alertsError(caught));
    } finally {
      setBusyId(null);
    }
  }

  const list = load.state === "ready" ? load.list : null;
  // Expired data is also filtered here, so a stale response can never show it.
  const visible = list
    ? list.items.filter((item) => item.freshness === "fresh")
    : [];

  return (
    <section className="panel alr-view" aria-labelledby="alerts-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">WHAT CHANGED</p>
          <h2 id="alerts-title">Alerts</h2>
          <p className="helper-text">
            Alerts appear here only. They come from checks of your journey legs
            and outdoor plans, and each one shows where the data came from and
            how fresh it is.
          </p>
        </div>
        {list ? (
          <span
            className="count-badge"
            aria-label={`${visible.length} active alerts`}
          >
            {visible.length}
          </span>
        ) : null}
      </div>

      <label className="alr-toggle">
        <input
          type="checkbox"
          checked={showDismissed}
          onChange={(event) => setShowDismissed(event.target.checked)}
        />
        Show dismissed alerts
      </label>

      <div aria-live="polite" className="alr-live">
        {notice ? (
          <div className="status-banner success" role="status">
            {notice}
          </div>
        ) : null}
        {actionError ? (
          <div className="status-banner error" role="alert">
            {actionError}
          </div>
        ) : null}
      </div>

      {load.state === "loading" ? (
        <p className="helper-text" role="status">
          Loading alerts…
        </p>
      ) : null}

      {load.state === "error" ? (
        <div className="empty-state" role="alert">
          <h3>Alerts are unavailable</h3>
          <p>{load.message}</p>
          <button
            className="button secondary"
            onClick={() => void refresh()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}

      {list && visible.length === 0 ? (
        <div className="empty-state">
          <h3>No active alerts</h3>
          <p>
            Nothing needs your attention right now. Alerts appear when a
            departure is near, traffic builds on the way, or weather threatens
            an outdoor plan.
          </p>
        </div>
      ) : null}

      {list && visible.length > 0 ? (
        <ul className="alr-list">
          {visible.map((alert) => (
            <li key={alert.id}>
              <AlertCard
                alert={alert}
                timeZone={trip.timezone}
                busy={busyId === alert.id}
                onRead={() => void change(alert, "read")}
                onDismiss={() => void change(alert, "dismiss")}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {list &&
      (list.hidden_expired_count > 0 || list.hidden_dismissed_count > 0) ? (
        <p className="helper-text" role="status">
          {list.hidden_expired_count > 0
            ? `${list.hidden_expired_count} alert${list.hidden_expired_count === 1 ? " is" : "s are"} hidden because the data behind ${list.hidden_expired_count === 1 ? "it has" : "them has"} expired. `
            : ""}
          {list.hidden_dismissed_count > 0
            ? `${list.hidden_dismissed_count} dismissed alert${list.hidden_dismissed_count === 1 ? " is" : "s are"} hidden.`
            : ""}
        </p>
      ) : null}

      <div className="alr-jobs" aria-labelledby="alerts-jobs-title">
        <h3 id="alerts-jobs-title">Background checks</h3>
        <p className="helper-text">
          A check that fails stays failed. It is never retried on its own and
          never replaced by old data; you can run it again yourself.
        </p>
        {jobsError ? (
          <div className="status-banner error" role="alert">
            Checks are unavailable: {jobsError}
          </div>
        ) : null}
        {!jobsError && jobs && jobs.length === 0 ? (
          <p className="helper-text">
            No background check has run for this trip yet.
          </p>
        ) : null}
        {jobs && jobs.length > 0 ? (
          <ul className="alr-job-list">
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                timeZone={trip.timezone}
                busy={busyId === job.id}
                onRerun={() => void rerun(job)}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
