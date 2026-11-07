import assert from "node:assert/strict";

const required = [
  "TASK03_SUPABASE_URL",
  "TASK03_ANON_KEY",
  "TASK03_API_BASE_URL",
  "TASK03_EMAIL",
  "TASK03_PASSWORD",
];
for (const name of required) {
  if (!process.env[name])
    throw new Error(`Missing required environment variable: ${name}`);
}

async function login() {
  const response = await fetch(
    `${process.env.TASK03_SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: process.env.TASK03_ANON_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: process.env.TASK03_EMAIL,
        password: process.env.TASK03_PASSWORD,
      }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.access_token;
}

async function call(path, token, options = {}) {
  const response = await fetch(`${process.env.TASK03_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  return { status: response.status, body };
}

const token = await login();
const trips = await call("/trips", token);
assert.equal(trips.status, 200);
const tripId = trips.body.items[0].id;
const points = await call(`/trips/${tripId}/context-points`, token);
assert.equal(points.status, 200);
const hotel = points.body.items.find((item) => item.type === "hotel").id;
const venue = points.body.items.find((item) => item.type === "conference").id;

const createBody = {
  type: "restaurant",
  label: "Task 03 clarification point",
  timezone: "Asia/Jakarta",
};
const created = await call(`/trips/${tripId}/context-points`, token, {
  method: "POST",
  headers: { "idempotency-key": "task03-validator-context" },
  body: JSON.stringify(createBody),
});
assert.equal(created.status, 202);
assert.equal(created.body.kind, "awaiting_clarification");
const replay = await call(`/trips/${tripId}/context-points`, token, {
  method: "POST",
  headers: { "idempotency-key": "task03-validator-context" },
  body: JSON.stringify(createBody),
});
assert.equal(replay.body.context_point.id, created.body.context_point.id);
const contextId = created.body.context_point.id;

const resolved = await call(
  `/trips/${tripId}/context-points/${contextId}/resolve`,
  token,
  {
    method: "POST",
    headers: { "idempotency-key": "task03-validator-resolve" },
    body: JSON.stringify({
      latitude: -6.2,
      longitude: 106.8,
      timezone: "Asia/Jakarta",
      external_place_id: "task03-validator-place",
    }),
  },
);
assert.equal(resolved.status, 200);

const confirmedContext = await call(
  `/trips/${tripId}/context-points/${contextId}/confirm`,
  token,
  {
    method: "POST",
    headers: { "idempotency-key": "task03-validator-confirm" },
  },
);
assert.equal(confirmedContext.status, 200);

const agenda = await call(`/trips/${tripId}/agenda-items`, token, {
  method: "POST",
  headers: { "idempotency-key": "task03-validator-agenda" },
  body: JSON.stringify({
    title: "Task 03 event",
    type: "event",
    context_point_id: contextId,
    start_at: "2026-11-12T19:00:00+07:00",
    end_at: "2026-11-12T21:00:00+07:00",
    timezone: "Asia/Jakarta",
    source: "event_discovery",
  }),
});
assert.equal(agenda.status, 201);
assert.equal(agenda.body.status, "suggested");
const planned = await call(
  `/trips/${tripId}/agenda-items/${agenda.body.id}/plan`,
  token,
  { method: "POST", headers: { "idempotency-key": "task03-validator-plan" } },
);
assert.equal(planned.status, 200);
const confirmedAgenda = await call(
  `/trips/${tripId}/agenda-items/${agenda.body.id}/confirm`,
  token,
  {
    method: "POST",
    headers: { "idempotency-key": "task03-validator-agenda-confirm" },
  },
);
assert.equal(confirmedAgenda.status, 200);

const leg = await call(`/trips/${tripId}/journey-legs`, token, {
  method: "POST",
  headers: { "idempotency-key": "task03-validator-leg" },
  body: JSON.stringify({
    origin_context_point_id: hotel,
    destination_context_point_id: venue,
    departure_at: "2026-11-12T07:00:00+07:00",
    arrival_deadline: "2026-11-12T08:00:00+07:00",
    related_agenda_id: agenda.body.id,
  }),
});
assert.equal(leg.status, 201);
const started = await call(
  `/trips/${tripId}/journey-legs/${leg.body.id}/start`,
  token,
  { method: "POST", headers: { "idempotency-key": "task03-validator-start" } },
);
assert.equal(started.status, 200);
const completed = await call(
  `/trips/${tripId}/journey-legs/${leg.body.id}/complete`,
  token,
  {
    method: "POST",
    headers: { "idempotency-key": "task03-validator-complete" },
  },
);
assert.equal(completed.status, 200);

console.log(
  JSON.stringify({
    clarification: created.body.kind,
    idempotency_replay: replay.body.context_point.id === contextId,
    context_confirmation: confirmedContext.body.confirmation_status,
    agenda_confirmation: confirmedAgenda.body.status,
    journey_completion: completed.body.status,
  }),
);
