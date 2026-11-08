"use client";

import { useCallback, useEffect, useState } from "react";
import { listAlerts } from "../../lib/api-alerts";
import type { AlertView } from "../../lib/types-alerts";
import { SeverityBadge, alertsError, severityRank } from "./alerts-parts";

type State =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; alerts: AlertView[] };

const REFRESH_MS = 60_000;

/**
 * Active alerts for the dashboard sidebar (Segment 01, 6.4). It counts alerts that are not
 * dismissed and whose data has not expired. When the alerts cannot be loaded it says so.
 */
export default function ActiveAlertsSummary({
  tripId,
  onOpen,
}: {
  tripId: string;
  onOpen: () => void;
}) {
  const [state, setState] = useState<State>({ state: "loading" });

  const refresh = useCallback(async () => {
    try {
      const list = await listAlerts(tripId);
      setState({
        state: "ready",
        alerts: list.items.filter((item) => item.freshness === "fresh"),
      });
    } catch (caught) {
      setState({ state: "error", message: alertsError(caught) });
    }
  }, [tripId]);

  useEffect(() => {
    setState({ state: "loading" });
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const alerts = state.state === "ready" ? state.alerts : [];
  const top = [...alerts].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  )[0];
  const unread = alerts.filter((item) => item.status === "unread").length;

  return (
    <section className="alr-summary" aria-labelledby="alr-summary-title">
      <h3 id="alr-summary-title">Active alerts</h3>
      {state.state === "loading" ? <p role="status">Checking alerts…</p> : null}
      {state.state === "error" ? (
        <p role="alert">Alerts are unavailable. {state.message}</p>
      ) : null}
      {state.state === "ready" && alerts.length === 0 ? (
        <p role="status">No active alerts.</p>
      ) : null}
      {state.state === "ready" && top ? (
        <>
          <p role="status">
            <strong>{alerts.length}</strong> active
            {unread > 0 ? `, ${unread} unread` : ""}
          </p>
          <SeverityBadge severity={top.severity} />
          <p className="alr-summary-title">{top.title}</p>
        </>
      ) : null}
      <button className="button secondary wide" onClick={onOpen} type="button">
        Open alerts
      </button>
    </section>
  );
}
