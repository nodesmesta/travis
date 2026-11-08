import { request } from "./api";
import type { AlertList, AlertView, JobList, JobView } from "./types-alerts";

const trip = (tripId: string) => `/trips/${encodeURIComponent(tripId)}`;

export function listAlerts(
  tripId: string,
  options: { includeDismissed?: boolean } = {},
): Promise<AlertList> {
  const query = options.includeDismissed ? "?include_dismissed=true" : "";
  return request(`${trip(tripId)}/alerts${query}`);
}

export function markAlertRead(
  tripId: string,
  alertId: string,
): Promise<{ request_id: string; alert: AlertView }> {
  return request(
    `${trip(tripId)}/alerts/${encodeURIComponent(alertId)}/read`,
    { method: "POST", body: "{}" },
    true,
  );
}

export function dismissAlert(
  tripId: string,
  alertId: string,
): Promise<{ request_id: string; alert: AlertView }> {
  return request(
    `${trip(tripId)}/alerts/${encodeURIComponent(alertId)}/dismiss`,
    { method: "POST", body: "{}" },
    true,
  );
}

export function listJobs(tripId: string, limit = 10): Promise<JobList> {
  return request(`${trip(tripId)}/jobs?limit=${limit}`);
}

export function rerunJob(
  tripId: string,
  jobId: string,
): Promise<{ request_id: string; job: JobView }> {
  return request(
    `${trip(tripId)}/jobs/${encodeURIComponent(jobId)}/rerun`,
    { method: "POST", body: "{}" },
    true,
  );
}
