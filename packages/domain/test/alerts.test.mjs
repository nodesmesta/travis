import assert from "node:assert/strict";
import test from "node:test";
import {
  ALERT_POLICY_V1,
  JobError,
  MOBILITY_POLICY_V1,
  deduplicationKey,
  evaluateDepartureReminder,
  evaluateTrafficRisk,
  evaluateWeatherRisk,
  findStaleReminders,
  floorToInterval,
  localIso,
  localLabel,
  parseJobPayload,
  planSchedule,
  zoneOffsetMinutes,
} from "../dist/index.js";

// Everything below is a FIXTURE: hand-written rule input, never provider output.
const TRIP = "00000000-0000-0000-0000-0000000000a1";
const LEG = "00000000-0000-0000-0000-0000000000b1";
const AGENDA = "00000000-0000-0000-0000-0000000000c1";
const POINT = "00000000-0000-0000-0000-0000000000d1";
const SOURCE = "00000000-0000-0000-0000-0000000000e1";
const NOW = new Date("2026-11-12T00:00:00.000Z");
const at = (minutes, from = NOW) =>
  new Date(from.getTime() + minutes * 60_000).toISOString();

const leg = (overrides = {}) => ({
  id: LEG,
  trip_id: TRIP,
  status: "planned",
  departure_at: at(60),
  arrival_deadline: at(120),
  origin_context_point_id: "o1",
  destination_context_point_id: "d1",
  origin_label: "Fixture Hotel",
  destination_label: "Fixture Hall",
  timezone: "Asia/Jakarta",
  origin_resolved: true,
  destination_resolved: true,
  ...overrides,
});

const traffic = (overrides = {}) => ({
  id: "t1",
  source_id: SOURCE,
  provider: "here_traffic_v7",
  traffic_level: "high",
  average_jam_factor: 7.4,
  max_jam_factor: 9,
  closed_segment_count: 0,
  incident_count: 2,
  segment_count: 40,
  retrieved_at: at(-2),
  expires_at: at(8),
  ...overrides,
});

const hourly = (offsetMinutes, overrides = {}) => ({
  at: at(offsetMinutes),
  granularity: "hourly",
  temperature_c: 27,
  precipitation_probability: 0.9,
  precipitation_mm: 5,
  wind_speed_ms: 4,
  visibility_m: 8000,
  condition_id: 502,
  condition: "Rain",
  description: "heavy intensity rain",
  ...overrides,
});

const agenda = (overrides = {}) => ({
  id: AGENDA,
  trip_id: TRIP,
  title: "Fixture Garden Walk",
  status: "planned",
  start_at: at(120),
  end_at: at(240),
  timezone: "Asia/Jakarta",
  context_point_id: POINT,
  context_label: "Fixture Garden",
  context_resolved: true,
  exposure: "outdoor",
  ...overrides,
});

const weather = (overrides = {}) => ({
  id: "w1",
  source_id: SOURCE,
  provider: "openweather_free_2_5",
  context_point_id: POINT,
  timezone: "Asia/Jakarta",
  observed_at: at(-5),
  current: null,
  hourly: [hourly(60), hourly(120), hourly(180)],
  daily: [],
  retrieved_at: at(-2),
  expires_at: at(28),
  ...overrides,
});

const ctx = { now: NOW };

// --- time zones -----------------------------------------------------------------

test("zone offsets follow the zone, including daylight saving changes", () => {
  assert.equal(zoneOffsetMinutes(NOW.getTime(), "Asia/Jakarta"), 420);
  assert.equal(zoneOffsetMinutes(NOW.getTime(), "Asia/Kolkata"), 330);
  assert.equal(zoneOffsetMinutes(NOW.getTime(), "America/New_York"), -300);
  assert.equal(zoneOffsetMinutes(NOW.getTime(), "UTC"), 0);
  // Europe/Berlin leaves summer time on 2026-10-25 at 01:00 UTC.
  assert.equal(
    zoneOffsetMinutes(Date.parse("2026-10-25T00:30:00Z"), "Europe/Berlin"),
    120,
  );
  assert.equal(
    zoneOffsetMinutes(Date.parse("2026-10-25T01:30:00Z"), "Europe/Berlin"),
    60,
  );
});

test("localIso writes the same instant on the wall clock of the zone", () => {
  const ms = Date.parse("2026-11-12T00:15:00Z");
  assert.equal(localIso(ms, "Asia/Jakarta"), "2026-11-12T07:15:00+07:00");
  assert.equal(localIso(ms, "America/New_York"), "2026-11-11T19:15:00-05:00");
  assert.equal(localIso(ms, "UTC"), "2026-11-12T00:15:00+00:00");
  assert.equal(
    localIso(Date.parse("2026-10-25T01:30:00Z"), "Europe/Berlin"),
    "2026-10-25T02:30:00+01:00",
  );
  assert.equal(
    localLabel(Date.parse("2026-11-12T00:45:00Z"), "Asia/Jakarta"),
    "Thu 12 Nov, 07:45 (UTC+07:00)",
  );
});

test("an invalid time zone fails with JOB_PAYLOAD_INVALID", () => {
  assert.throws(
    () => localIso(NOW.getTime(), "Mars/Olympus"),
    (error) =>
      error instanceof JobError && error.code === "JOB_PAYLOAD_INVALID",
  );
});

test("the traffic horizon matches the mobility policy so the two cannot drift", () => {
  assert.equal(
    ALERT_POLICY_V1.traffic_horizon_minutes,
    MOBILITY_POLICY_V1.traffic_live_horizon_minutes,
  );
});

// --- departure reminder ---------------------------------------------------------

test("departure reminder is created from the journey leg alone, without a provider claim", () => {
  const result = evaluateDepartureReminder(
    { leg: leg(), plannedDepartureAt: at(60) },
    ctx,
  );
  assert.equal(result.decision, "create_alert");
  const alert = result.alert;
  assert.equal(alert.alert_type, "departure_reminder");
  assert.equal(alert.severity, "info");
  assert.deepEqual(alert.source_ids, []);
  assert.equal(alert.internal_source.provider, "travis_journey_leg");
  assert.equal(alert.retrieved_at, NOW.toISOString());
  assert.equal(alert.expires_at, at(60));
  assert.ok(alert.factual_summary.includes("07:00"), alert.factual_summary);
  assert.ok(!alert.factual_summary.toLowerCase().includes("traffic"));
  assert.ok(!alert.recommendation_summary.toLowerCase().includes("traffic"));
  assert.ok(alert.recommendation_summary.includes("60 minutes"));
  assert.equal(alert.journey_leg_id, LEG);
  assert.equal(alert.policy_version, "alerts-v1");
});

test("departure reminder is not created when the schedule changed, the leg left, or the leg is not planned", () => {
  const changed = evaluateDepartureReminder(
    { leg: leg({ departure_at: at(90) }), plannedDepartureAt: at(60) },
    ctx,
  );
  assert.deepEqual(changed.reason_codes, ["SCHEDULE_CHANGED"]);
  const passed = evaluateDepartureReminder(
    { leg: leg({ departure_at: at(-1) }), plannedDepartureAt: at(-1) },
    ctx,
  );
  assert.deepEqual(passed.reason_codes, ["DEPARTURE_ALREADY_PASSED"]);
  const cancelled = evaluateDepartureReminder(
    { leg: leg({ status: "cancelled" }), plannedDepartureAt: at(60) },
    ctx,
  );
  assert.deepEqual(cancelled.reason_codes, ["LEG_NOT_PLANNED"]);
  for (const result of [changed, passed, cancelled])
    assert.equal(result.decision, "no_action");
});

test("deduplication key is stable for the same condition and changes with level, window, zone, and policy", () => {
  const first = evaluateDepartureReminder(
    { leg: leg(), plannedDepartureAt: at(60) },
    ctx,
  ).alert;
  const later = evaluateDepartureReminder(
    { leg: leg(), plannedDepartureAt: at(60) },
    { now: new Date(at(5)) },
  ).alert;
  assert.equal(first.deduplication_key, later.deduplication_key);
  assert.equal(
    first.deduplication_key,
    `${TRIP}:${LEG}:departure_reminder:info:2026-11-12T08:00:00+07:00:alerts-v1`,
  );
  const base = {
    tripId: TRIP,
    entityId: LEG,
    alertType: "traffic_risk",
    level: "medium",
    windowMs: Date.parse("2026-11-12T01:00:00Z"),
    timeZone: "Asia/Jakarta",
    policyVersion: "alerts-v1",
  };
  const key = deduplicationKey(base);
  assert.notEqual(key, deduplicationKey({ ...base, level: "high" }));
  assert.notEqual(
    key,
    deduplicationKey({ ...base, windowMs: base.windowMs + 60_000 }),
  );
  assert.notEqual(
    key,
    deduplicationKey({ ...base, timeZone: "Asia/Singapore" }),
  );
  assert.notEqual(
    key,
    deduplicationKey({ ...base, policyVersion: "alerts-v2" }),
  );
});

// --- traffic risk ---------------------------------------------------------------

test("traffic risk alert keeps facts and recommendation apart and carries source, retrieval, and expiry", () => {
  const result = evaluateTrafficRisk({ leg: leg(), snapshot: traffic() }, ctx);
  assert.equal(result.decision, "create_alert");
  const alert = result.alert;
  assert.equal(alert.alert_type, "traffic_risk");
  assert.equal(alert.severity, "high");
  assert.deepEqual(alert.source_ids, [SOURCE]);
  assert.equal(alert.retrieved_at, at(-2));
  assert.equal(
    alert.expires_at,
    at(8),
    "expiry is the earlier of snapshot expiry and departure",
  );
  assert.ok(alert.factual_summary.includes("7.4"));
  assert.ok(alert.factual_summary.includes("2 reported incidents"));
  assert.ok(!alert.factual_summary.includes("Consider"));
  assert.ok(alert.recommendation_summary.includes("10 minutes earlier"));
  assert.ok(!alert.recommendation_summary.includes("7.4"));
  assert.deepEqual(alert.reason_codes, [
    "TRAFFIC_LEVEL_HIGH",
    "TRAFFIC_INCIDENTS_PRESENT",
  ]);
  assert.ok(alert.deduplication_key.includes(":traffic_risk:high:"));
});

test("traffic medium maps to a medium alert and the level is part of the key", () => {
  const medium = evaluateTrafficRisk(
    {
      leg: leg(),
      snapshot: traffic({ traffic_level: "medium", incident_count: 0 }),
    },
    ctx,
  ).alert;
  const high = evaluateTrafficRisk(
    { leg: leg(), snapshot: traffic() },
    ctx,
  ).alert;
  assert.equal(medium.severity, "medium");
  assert.notEqual(medium.deduplication_key, high.deduplication_key);
});

test("an expired traffic snapshot never creates an alert", () => {
  const result = evaluateTrafficRisk(
    { leg: leg(), snapshot: traffic({ expires_at: at(-1) }) },
    ctx,
  );
  assert.equal(result.decision, "blocked");
  assert.equal(result.error_code, "JOB_PROVIDER_DATA_EXPIRED");
  const exactly = evaluateTrafficRisk(
    { leg: leg(), snapshot: traffic({ expires_at: NOW.toISOString() }) },
    ctx,
  );
  assert.equal(
    exactly.decision,
    "blocked",
    "expiry at the current instant already counts as expired",
  );
});

test("a missing traffic snapshot blocks instead of reporting that traffic is fine", () => {
  const result = evaluateTrafficRisk({ leg: leg(), snapshot: null }, ctx);
  assert.equal(result.decision, "blocked");
  assert.equal(result.error_code, "JOB_PRECONDITION_FAILED");
});

test("low and unknown traffic create no alert, and a far departure is not evaluated", () => {
  const low = evaluateTrafficRisk(
    { leg: leg(), snapshot: traffic({ traffic_level: "low" }) },
    ctx,
  );
  const unknown = evaluateTrafficRisk(
    { leg: leg(), snapshot: traffic({ traffic_level: "unknown" }) },
    ctx,
  );
  const far = evaluateTrafficRisk(
    { leg: leg({ departure_at: at(600) }), snapshot: traffic() },
    ctx,
  );
  const gone = evaluateTrafficRisk(
    { leg: leg({ departure_at: at(-5) }), snapshot: traffic() },
    ctx,
  );
  assert.deepEqual(low.reason_codes, ["TRAFFIC_LEVEL_LOW"]);
  assert.deepEqual(unknown.reason_codes, ["TRAFFIC_LEVEL_UNKNOWN"]);
  assert.deepEqual(far.reason_codes, ["TRAFFIC_OUTSIDE_LIVE_HORIZON"]);
  assert.deepEqual(gone.reason_codes, ["LEG_ALREADY_DEPARTED"]);
  for (const result of [low, unknown, far, gone])
    assert.equal(result.decision, "no_action");
});

// --- weather risk ---------------------------------------------------------------

test("rain before an outdoor activity creates a weather alert from a fresh snapshot", () => {
  const result = evaluateWeatherRisk(
    { agenda: agenda(), snapshot: weather() },
    ctx,
  );
  assert.equal(result.decision, "create_alert");
  const alert = result.alert;
  assert.equal(alert.alert_type, "weather_risk");
  assert.equal(alert.severity, "high");
  assert.equal(alert.agenda_item_id, AGENDA);
  assert.deepEqual(alert.source_ids, [SOURCE]);
  assert.equal(alert.retrieved_at, at(-2));
  assert.equal(alert.expires_at, at(28));
  assert.ok(alert.factual_summary.includes("heavy intensity rain"));
  assert.ok(alert.factual_summary.includes("90% chance of precipitation"));
  assert.ok(alert.recommendation_summary.includes("rain protection"));
  assert.ok(
    alert.recommendation_summary.includes("itinerary has not been changed"),
  );
  assert.ok(!alert.factual_summary.includes("itinerary has not been changed"));
  assert.ok(alert.reason_codes.includes("WEATHER_PRECIPITATION"));
});

test("an expired or missing weather snapshot never creates an alert", () => {
  const expired = evaluateWeatherRisk(
    { agenda: agenda(), snapshot: weather({ expires_at: at(-1) }) },
    ctx,
  );
  assert.equal(expired.decision, "blocked");
  assert.equal(expired.error_code, "JOB_PROVIDER_DATA_EXPIRED");
  const missing = evaluateWeatherRisk(
    { agenda: agenda(), snapshot: null },
    ctx,
  );
  assert.equal(missing.decision, "blocked");
  assert.equal(missing.error_code, "JOB_PRECONDITION_FAILED");
});

test("weather is only judged for outdoor, active, upcoming agenda items", () => {
  const indoor = evaluateWeatherRisk(
    { agenda: agenda({ exposure: "indoor" }), snapshot: weather() },
    ctx,
  );
  const unrecorded = evaluateWeatherRisk(
    { agenda: agenda({ exposure: null }), snapshot: weather() },
    ctx,
  );
  const cancelled = evaluateWeatherRisk(
    { agenda: agenda({ status: "cancelled" }), snapshot: weather() },
    ctx,
  );
  const ended = evaluateWeatherRisk(
    {
      agenda: agenda({ start_at: at(-120), end_at: at(-60) }),
      snapshot: weather(),
    },
    ctx,
  );
  const far = evaluateWeatherRisk(
    {
      agenda: agenda({ start_at: at(60 * 20), end_at: at(60 * 21) }),
      snapshot: weather(),
    },
    ctx,
  );
  assert.deepEqual(indoor.reason_codes, ["EXPOSURE_INDOOR"]);
  assert.deepEqual(unrecorded.reason_codes, ["EXPOSURE_NOT_RECORDED"]);
  assert.deepEqual(cancelled.reason_codes, ["AGENDA_NOT_ACTIVE"]);
  assert.deepEqual(ended.reason_codes, ["AGENDA_ALREADY_ENDED"]);
  assert.deepEqual(far.reason_codes, ["WEATHER_OUTSIDE_HORIZON"]);
  for (const result of [indoor, unrecorded, cancelled, ended, far])
    assert.equal(result.decision, "no_action");
});

test("a calm forecast creates no alert and no all-clear claim", () => {
  const calm = hourly(120, {
    precipitation_probability: 0.05,
    precipitation_mm: 0,
    wind_speed_ms: 2,
    visibility_m: 10000,
    condition_id: 800,
    condition: "Clear",
    description: "clear sky",
  });
  const result = evaluateWeatherRisk(
    { agenda: agenda(), snapshot: weather({ hourly: [calm] }) },
    ctx,
  );
  assert.equal(result.decision, "no_action");
  assert.deepEqual(result.reason_codes, ["WEATHER_LEVEL_LOW"]);
});

test("a forecast that does not reach the start of the activity creates nothing", () => {
  const result = evaluateWeatherRisk(
    {
      agenda: agenda(),
      snapshot: weather({ hourly: [hourly(-600)], daily: [] }),
    },
    ctx,
  );
  assert.equal(result.decision, "no_action");
  assert.deepEqual(result.reason_codes, ["FORECAST_NOT_AVAILABLE_FOR_TIME"]);
});

// --- scheduling -----------------------------------------------------------------

const schedule = (overrides = {}) =>
  planSchedule({
    now: NOW,
    tripId: TRIP,
    tripStatus: "confirmed",
    legs: [leg()],
    agenda: [],
    ...overrides,
  });

test("a departure inside the horizon plans a reminder at the lead time, keyed by local wall clock time", () => {
  const plan = schedule();
  const reminder = plan.jobs.find(
    (job) => job.job_type === "departure_reminder",
  );
  assert.ok(reminder);
  assert.equal(
    reminder.run_at,
    at(30),
    "30 minutes before a departure in 60 minutes is 30 minutes from now",
  );
});

test("reminder due time is departure minus the lead, and clamped to now when that moment has passed", () => {
  const far = schedule({ legs: [leg({ departure_at: at(120) })] }).jobs.find(
    (j) => j.job_type === "departure_reminder",
  );
  assert.equal(far.run_at, at(90));
  assert.equal(
    far.idempotency_key,
    `trip:${TRIP}:leg:${LEG}:departure_reminder:2026-11-12T08:30:00+07:00`,
  );
  assert.equal(far.payload.scheduled_at, at(90));
  const soon = schedule({ legs: [leg({ departure_at: at(10) })] }).jobs.find(
    (j) => j.job_type === "departure_reminder",
  );
  assert.equal(soon.run_at, NOW.toISOString());
  assert.equal(
    soon.idempotency_key,
    `trip:${TRIP}:leg:${LEG}:departure_reminder:2026-11-12T06:40:00+07:00`,
  );
});

test("the same moment gives the same keys, and the zone changes the written key but not the due instant", () => {
  const a = schedule({ legs: [leg({ departure_at: at(120) })] });
  const b = schedule({ legs: [leg({ departure_at: at(120) })] });
  assert.deepEqual(a, b);
  const jakarta = a.jobs.find((j) => j.job_type === "departure_reminder");
  const newYork = schedule({
    legs: [leg({ departure_at: at(120), timezone: "America/New_York" })],
  }).jobs.find((j) => j.job_type === "departure_reminder");
  assert.equal(jakarta.run_at, newYork.run_at);
  assert.ok(jakarta.idempotency_key.endsWith("2026-11-12T08:30:00+07:00"));
  assert.ok(newYork.idempotency_key.endsWith("2026-11-11T20:30:00-05:00"));
});

test("moving the departure creates a new key, so the old reminder is not reused", () => {
  const before = schedule({ legs: [leg({ departure_at: at(120) })] }).jobs.find(
    (j) => j.job_type === "departure_reminder",
  );
  const after = schedule({ legs: [leg({ departure_at: at(150) })] }).jobs.find(
    (j) => j.job_type === "departure_reminder",
  );
  assert.notEqual(before.idempotency_key, after.idempotency_key);
});

test("the daylight saving change moves the local key, not the due instant", () => {
  const berlinNow = new Date("2026-10-24T22:00:00.000Z");
  const departure = "2026-10-25T01:30:00.000Z";
  const plan = planSchedule({
    now: berlinNow,
    tripId: TRIP,
    tripStatus: "active",
    legs: [leg({ departure_at: departure, timezone: "Europe/Berlin" })],
    agenda: [],
  });
  const reminder = plan.jobs.find((j) => j.job_type === "departure_reminder");
  assert.equal(reminder.run_at, "2026-10-25T01:00:00.000Z");
  assert.ok(
    reminder.idempotency_key.endsWith("2026-10-25T02:00:00+01:00"),
    reminder.idempotency_key,
  );
});

test("traffic refresh opens one slot per interval, only inside the live horizon with resolved places", () => {
  const first = schedule().jobs.find((j) => j.job_type === "refresh_traffic");
  assert.ok(first);
  const sameSlot = planSchedule({
    now: new Date(at(3)),
    tripId: TRIP,
    tripStatus: "confirmed",
    legs: [leg({ departure_at: at(60) })],
    agenda: [],
  }).jobs.find((j) => j.job_type === "refresh_traffic");
  assert.equal(
    sameSlot.idempotency_key,
    first.idempotency_key,
    "a restart inside the same slot reuses the key",
  );
  const nextSlot = planSchedule({
    now: new Date(at(9)),
    tripId: TRIP,
    tripStatus: "confirmed",
    legs: [leg({ departure_at: at(60) })],
    agenda: [],
  }).jobs.find((j) => j.job_type === "refresh_traffic");
  assert.notEqual(nextSlot.idempotency_key, first.idempotency_key);
  const far = schedule({ legs: [leg({ departure_at: at(60 * 10) })] });
  assert.equal(
    far.jobs.some((j) => j.job_type === "refresh_traffic"),
    false,
  );
  const unresolved = schedule({ legs: [leg({ destination_resolved: false })] });
  assert.equal(
    unresolved.jobs.some((j) => j.job_type === "refresh_traffic"),
    false,
  );
  assert.deepEqual(unresolved.skipped, [
    { entity: "journey_leg", id: LEG, reason: "CONTEXT_UNRESOLVED" },
  ]);
});

test("weather refresh is planned once per place for any agenda item inside the horizon", () => {
  const second = { ...agenda(), id: "00000000-0000-0000-0000-0000000000c2" };
  const plan = schedule({
    legs: [],
    agenda: [agenda(), second, agenda({ id: "x", exposure: "indoor" })],
  });
  const refreshes = plan.jobs.filter((j) => j.job_type === "refresh_weather");
  assert.equal(refreshes.length, 1, "one read per place, however many items use it");
  assert.deepEqual(refreshes[0].payload, { context_point_id: POINT });
});

test("an indoor stay still gets the forecast for its place", () => {
  const plan = schedule({
    legs: [],
    agenda: [agenda({ exposure: "indoor" })],
  });
  const refreshes = plan.jobs.filter((j) => j.job_type === "refresh_weather");
  assert.equal(refreshes.length, 1);
  assert.deepEqual(refreshes[0].payload, { context_point_id: POINT });
});

test("an agenda item without a resolved place plans no weather and says why", () => {
  const plan = schedule({
    legs: [],
    agenda: [agenda({ context_resolved: false })],
  });
  assert.equal(plan.jobs.some((j) => j.job_type === "refresh_weather"), false);
  assert.deepEqual(plan.skipped, [
    { entity: "agenda_item", id: AGENDA, reason: "CONTEXT_UNRESOLVED" },
  ]);
});

test("draft and completed trips, cancelled legs, and past departures get no jobs", () => {
  assert.deepEqual(schedule({ tripStatus: "draft" }).jobs, []);
  assert.deepEqual(schedule({ tripStatus: "completed" }).jobs, []);
  assert.deepEqual(schedule({ legs: [leg({ status: "cancelled" })] }).jobs, []);
  assert.deepEqual(
    schedule({ legs: [leg({ departure_at: at(-10) })] }).jobs,
    [],
  );
  assert.deepEqual(
    schedule({ legs: [leg({ departure_at: at(60 * 48) })] }).jobs,
    [],
  );
});

test("queued reminders for a changed or cancelled leg are reported stale", () => {
  const queued = [
    {
      id: "1",
      job_type: "departure_reminder",
      payload: { journey_leg_id: LEG, departure_at: at(60) },
    },
    {
      id: "2",
      job_type: "departure_reminder",
      payload: { journey_leg_id: LEG, departure_at: at(30) },
    },
    {
      id: "3",
      job_type: "departure_reminder",
      payload: { journey_leg_id: "gone", departure_at: at(60) },
    },
    { id: "4", job_type: "refresh_traffic", payload: { journey_leg_id: LEG } },
  ];
  assert.deepEqual(findStaleReminders(queued, [leg()]), [
    { id: "2", reason: "DEPARTURE_CHANGED" },
    { id: "3", reason: "LEG_NO_LONGER_PLANNED" },
  ]);
  assert.deepEqual(
    findStaleReminders(queued.slice(0, 1), [leg({ status: "cancelled" })]),
    [{ id: "1", reason: "LEG_NO_LONGER_PLANNED" }],
  );
});

test("floorToInterval aligns an instant to the start of its slot", () => {
  assert.equal(
    new Date(
      floorToInterval(Date.parse("2026-11-12T00:13:00Z"), 8),
    ).toISOString(),
    "2026-11-12T00:08:00.000Z",
  );
});

// --- payload --------------------------------------------------------------------

test("job payloads are checked strictly", () => {
  assert.deepEqual(
    parseJobPayload("refresh_weather", { context_point_id: POINT }).payload,
    { context_point_id: POINT },
  );
  assert.throws(
    () => parseJobPayload("refresh_weather", { context_point_id: "nope" }),
    (e) => e.code === "JOB_PAYLOAD_INVALID",
  );
  assert.throws(
    () =>
      parseJobPayload("refresh_weather", { context_point_id: POINT, extra: 1 }),
    (e) => e.code === "JOB_PAYLOAD_INVALID",
  );
  assert.throws(
    () => parseJobPayload("send_email", {}),
    (e) => e.code === "JOB_PAYLOAD_INVALID",
  );
  assert.throws(
    () => parseJobPayload("refresh_traffic", []),
    (e) => e.code === "JOB_PAYLOAD_INVALID",
  );
  assert.throws(
    () =>
      parseJobPayload("evaluate_alerts", {
        trigger_job_id: LEG,
        journey_leg_id: LEG,
        context_point_id: POINT,
      }),
    (e) => e.code === "JOB_PAYLOAD_INVALID",
  );
  assert.equal(
    parseJobPayload("evaluate_alerts", {
      trigger_job_id: LEG,
      journey_leg_id: LEG,
    }).payload.context_point_id,
    null,
  );
  assert.throws(
    () =>
      parseJobPayload("departure_reminder", {
        journey_leg_id: LEG,
        departure_at: "later",
        scheduled_at: at(0),
        policy_version: "alerts-v1",
      }),
    (e) => e.code === "JOB_PAYLOAD_INVALID",
  );
});
