/**
 * Versioned alert policy. Every number the alert rules and the scheduler use
 * lives here, so a stored alert can be explained from its `policy_version`.
 * These are product values chosen for the demo, not provider facts. Change a
 * value only together with a new `version`: the version is part of every
 * deduplication key, so a new version creates new alerts on purpose.
 */
export interface AlertPolicy {
  version: string;
  /** A departure reminder fires this many minutes before departure. */
  departure_reminder_lead_minutes: number;
  /** Outdoor agenda items are watched for weather this many hours ahead. */
  weather_horizon_hours: number;
  /** Area traffic is evaluated for legs that depart within this many minutes. */
  traffic_horizon_minutes: number;
  /** How often a weather or traffic refresh slot opens while it is being watched. */
  weather_refresh_interval_minutes: number;
  traffic_refresh_interval_minutes: number;
  /** Reminders and refreshes are planned for departures within this many hours. */
  schedule_horizon_hours: number;
  /** Extra minutes suggested in a traffic alert, by traffic level. */
  traffic_extra_minutes: { medium: number; high: number };
}

export const ALERT_POLICY_V1: AlertPolicy = {
  version: "alerts-v1",
  departure_reminder_lead_minutes: 30,
  weather_horizon_hours: 12,
  traffic_horizon_minutes: 180,
  weather_refresh_interval_minutes: 20,
  traffic_refresh_interval_minutes: 8,
  schedule_horizon_hours: 24,
  traffic_extra_minutes: { medium: 5, high: 10 },
};
