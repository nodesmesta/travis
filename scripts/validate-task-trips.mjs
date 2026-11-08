// Validator for Trip setup (screen 6.3, `POST /trips`).
//
//   API_PORT=4112 node --env-file=.env.local apps/api/dist/index.js     # in another terminal
//   node --env-file=.env.local scripts/validate-task-trips.mjs          # or: npm run validate:trips
//
// The API base URL is API_BASE_URL when set, otherwise http://127.0.0.1:4112/api/v1.
// Every trip the script creates is named "[trips-validator] ..." and is removed,
// with its context points, agenda items, journey legs, activity logs, and
// idempotency records, when the script ends (also after a failure).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  api,
  check,
  demoToken,
  env,
  finish,
  otherUserToken,
  sql,
} from "./lib/validation.mjs";
import {
  VALIDATOR_PREFIX,
  cleanupTestTrips,
  countTestTrips,
} from "./lib/trips-cleanup.mjs";

env.API_BASE_URL ??= "http://127.0.0.1:4112/api/v1";
const startedAt = new Date(Date.now() - 5_000).toISOString();
const run = randomUUID().slice(0, 8);
const key = (label) => `trips-validator-${run}-${label}`;
const name = (label) => `${VALIDATOR_PREFIX}${label} ${run}`;

const demo = await demoToken();
const other = await otherUserToken();

const post = (path, token, label, body) =>
  api(path, token, { method: "POST", body, idempotencyKey: key(label) });

function assertErrorEnvelope(response, status, code) {
  assert.equal(response.status, status, response.text);
  const error = response.body?.error;
  assert.ok(error, `error envelope expected: ${response.text}`);
  assert.equal(typeof error.code, "string");
  assert.equal(typeof error.category, "string");
  assert.ok(error.message.length > 0, "message");
  assert.ok(error.request_id, "request_id");
  if (code) assert.equal(error.code, code, response.text);
}

function assertTripShape(trip) {
  for (const field of [
    "id",
    "user_id",
    "name",
    "destination_summary",
    "start_at",
    "end_at",
    "timezone",
    "status",
    "source",
    "created_at",
    "updated_at",
    "request_id",
  ]) {
    assert.ok(field in trip, `trip.${field} is missing`);
  }
}

const valid = {
  name: name("Main"),
  destination_summary: "Jakarta, Indonesia",
  start_at: "2026-11-12T08:00:00+07:00",
  end_at: "2026-11-14T20:00:00+07:00",
  timezone: "Asia/Jakarta",
};

let mainTrip;
let otherTrip;

try {
  await check(
    "POST /trips creates a draft trip owned by the caller (201)",
    async () => {
      const created = await post("/trips", demo, "create", valid);
      assert.equal(created.status, 201, created.text);
      assertTripShape(created.body);
      mainTrip = created.body;
      assert.equal(mainTrip.status, "draft");
      assert.equal(mainTrip.source, "user_input");
      assert.equal(mainTrip.name, valid.name);
      assert.equal(mainTrip.destination_summary, "Jakarta, Indonesia");
      assert.equal(mainTrip.timezone, "Asia/Jakarta");
      assert.equal(Date.parse(mainTrip.start_at), Date.parse(valid.start_at));
      assert.equal(Date.parse(mainTrip.end_at), Date.parse(valid.end_at));
      const owner = await sql(
        `select user_id from public.trips where id = '${mainTrip.id}';`,
      );
      assert.equal(owner, mainTrip.user_id);
      const list = await api("/trips", demo);
      assert.ok(list.body.items.some((trip) => trip.id === mainTrip.id));
      const log = await sql(
        `select count(*) from public.activity_logs where action = 'trip.created' and resource_id::text = '${mainTrip.id}';`,
      );
      assert.equal(log, "1", "one trip.created activity log");
    },
  );

  await check(
    "a trip with only name and timezone is valid; blanks become null",
    async () => {
      const created = await post("/trips", demo, "minimal", {
        name: name("Minimal"),
        timezone: "Asia/Singapore",
        destination_summary: "  ",
      });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.start_at, null);
      assert.equal(created.body.end_at, null);
      assert.equal(created.body.destination_summary, null);
    },
  );

  await check(
    "replaying the Idempotency-Key returns the same trip, stored once",
    async () => {
      const again = await post("/trips", demo, "create", valid);
      assert.equal(again.status, 201, again.text);
      assert.equal(again.body.id, mainTrip.id);
      const count = await sql(
        `select count(*) from public.trips where name = '${valid.name}';`,
      );
      assert.equal(count, "1");
      const logs = await sql(
        `select count(*) from public.activity_logs where action = 'trip.created' and resource_id::text = '${mainTrip.id}';`,
      );
      assert.equal(logs, "1");
    },
  );

  await check(
    "the same key with a different body is a 409 conflict",
    async () => {
      const conflict = await post("/trips", demo, "create", {
        ...valid,
        name: name("Different"),
      });
      assertErrorEnvelope(conflict, 409, "IDEMPOTENCY_CONFLICT");
    },
  );

  await check("a missing or short Idempotency-Key is a 400", async () => {
    const missing = await fetch(`${env.API_BASE_URL}/trips`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${demo}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(valid),
    });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.error.code, "IDEMPOTENCY_KEY_INVALID");
    assert.ok(missingBody.error.request_id);
    const short = await api("/trips", demo, {
      method: "POST",
      body: valid,
      idempotencyKey: "short",
    });
    assertErrorEnvelope(short, 400, "IDEMPOTENCY_KEY_INVALID");
  });

  await check(
    "invalid input is a structured 400 and creates nothing",
    async () => {
      const cases = [
        ["start_at without offset", { start_at: "2026-11-12T08:00:00" }],
        ["end_at without offset", { end_at: "2026-11-14T20:00:00" }],
        [
          "end before start",
          {
            start_at: "2026-11-14T08:00:00+07:00",
            end_at: "2026-11-12T08:00:00+07:00",
          },
        ],
        [
          "end equals start",
          {
            start_at: "2026-11-12T08:00:00+07:00",
            end_at: "2026-11-12T08:00:00+07:00",
          },
        ],
        ["day that does not exist", { start_at: "2026-02-30T08:00:00+07:00" }],
        ["unknown timezone", { timezone: "Mars/Olympus" }],
        ["UTC offset as timezone", { timezone: "+07:00" }],
        ["blank name", { name: "   " }],
        [
          "name over 160 characters",
          { name: `${VALIDATOR_PREFIX}${"x".repeat(160)}` },
        ],
        ["unknown field", { colour: "red" }],
        ["owner chosen by the client", { user_id: randomUUID() }],
        ["status chosen by the client", { status: "active" }],
        ["unknown source", { source: "nowhere" }],
      ];
      const failures = [];
      for (const [label, patch] of cases) {
        const response = await post("/trips", demo, `invalid-${label}`, {
          ...valid,
          name: name(`invalid ${label}`),
          ...patch,
        });
        try {
          assertErrorEnvelope(response, 400);
        } catch (error) {
          failures.push(`${label}: ${error.message}`);
        }
      }
      assert.deepEqual(failures, []);
      const stored = await sql(
        `select count(*) from public.trips where position('${VALIDATOR_PREFIX}invalid' in name) = 1 and created_at >= '${startedAt}';`,
      );
      assert.equal(stored, "0", "no invalid trip was stored");
      const noName = await post("/trips", demo, "no-name", { timezone: "UTC" });
      assertErrorEnvelope(noName, 400);
      const noTimezone = await post("/trips", demo, "no-timezone", {
        name: name("no timezone"),
      });
      assertErrorEnvelope(noTimezone, 400);
    },
  );

  await check("a request without a token is a 401", async () => {
    const response = await fetch(`${env.API_BASE_URL}/trips`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key("anonymous"),
      },
      body: JSON.stringify(valid),
    });
    assert.equal(response.status, 401);
  });

  await check("PATCH changes a draft trip and rejects bad values", async () => {
    const renamed = await api(`/trips/${mainTrip.id}`, demo, {
      method: "PATCH",
      body: { name: name("Main renamed"), destination_summary: "Jakarta" },
    });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.name, name("Main renamed"));
    assert.equal(renamed.body.destination_summary, "Jakarta");
    for (const [label, body] of [
      ["no offset", { start_at: "2026-11-12T08:00:00" }],
      ["end before start", { end_at: "2026-11-11T08:00:00+07:00" }],
      ["day that does not exist", { start_at: "2026-02-30T08:00:00+07:00" }],
      ["offset timezone", { timezone: "+07:00" }],
      ["unknown timezone", { timezone: "Mars/Olympus" }],
      ["status", { status: "active" }],
      ["empty body", {}],
    ]) {
      const response = await api(`/trips/${mainTrip.id}`, demo, {
        method: "PATCH",
        body,
      });
      try {
        assertErrorEnvelope(response, 400);
      } catch (error) {
        throw new Error(`${label}: ${error.message}`);
      }
    }
    const cleared = await api(`/trips/${mainTrip.id}`, demo, {
      method: "PATCH",
      body: { start_at: null, end_at: null },
    });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.start_at, null);
    const restored = await api(`/trips/${mainTrip.id}`, demo, {
      method: "PATCH",
      body: {
        start_at: valid.start_at,
        end_at: valid.end_at,
        timezone: "Asia/Jakarta",
      },
    });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(Date.parse(restored.body.end_at), Date.parse(valid.end_at));
  });

  await check("another user cannot read, change, or use the trip", async () => {
    const otherList = await api("/trips", other);
    assert.equal(otherList.status, 200);
    assert.ok(!otherList.body.items.some((trip) => trip.id === mainTrip.id));
    const read = await api(`/trips/${mainTrip.id}`, other);
    assertErrorEnvelope(read, 404, "RESOURCE_NOT_FOUND");
    const patch = await api(`/trips/${mainTrip.id}`, other, {
      method: "PATCH",
      body: { name: name("stolen") },
    });
    assertErrorEnvelope(patch, 404, "RESOURCE_NOT_FOUND");
    const transition = await post(
      `/trips/${mainTrip.id}/transition`,
      other,
      "foreign-transition",
      {
        status: "confirmed",
      },
    );
    assertErrorEnvelope(transition, 404, "RESOURCE_NOT_FOUND");
    const contexts = await api(`/trips/${mainTrip.id}/context-points`, other);
    assertErrorEnvelope(contexts, 404, "RESOURCE_NOT_FOUND");
    const addContext = await post(
      `/trips/${mainTrip.id}/context-points`,
      other,
      "foreign-context",
      {
        type: "hotel",
        label: "Foreign hotel",
        timezone: "Asia/Jakarta",
      },
    );
    assertErrorEnvelope(addContext, 404, "RESOURCE_NOT_FOUND");
    const addAgenda = await post(
      `/trips/${mainTrip.id}/agenda-items`,
      other,
      "foreign-agenda",
      {
        title: "Foreign meeting",
        type: "meeting",
        start_at: "2026-11-12T09:00:00+07:00",
        end_at: "2026-11-12T10:00:00+07:00",
        timezone: "Asia/Jakarta",
      },
    );
    assertErrorEnvelope(addAgenda, 404, "RESOURCE_NOT_FOUND");
    const row = await sql(
      `select name from public.trips where id = '${mainTrip.id}';`,
    );
    assert.notEqual(row, name("stolen"));
    assert.equal(row.includes("stolen"), false);
  });

  await check(
    "the same Idempotency-Key from another user makes that user's own trip",
    async () => {
      const created = await post("/trips", other, "create", {
        ...valid,
        name: name("Other user"),
      });
      assert.equal(created.status, 201, created.text);
      otherTrip = created.body;
      assert.notEqual(otherTrip.id, mainTrip.id);
      assert.notEqual(otherTrip.user_id, mainTrip.user_id);
      const mine = await api("/trips", demo);
      assert.ok(!mine.body.items.some((trip) => trip.id === otherTrip.id));
      const read = await api(`/trips/${otherTrip.id}`, demo);
      assertErrorEnvelope(read, 404, "RESOURCE_NOT_FOUND");
    },
  );

  await check(
    "status transitions follow draft → confirmed → active → completed",
    async () => {
      const created = await post("/trips", demo, "transition-trip", {
        name: name("Transitions"),
        timezone: "Asia/Jakarta",
      });
      assert.equal(created.status, 201, created.text);
      const id = created.body.id;
      const skip = await post(`/trips/${id}/transition`, demo, "skip-active", {
        status: "active",
      });
      assertErrorEnvelope(skip, 409, "DOMAIN_STATE_INVALID");
      const bad = await post(`/trips/${id}/transition`, demo, "bad-status", {
        status: "draft",
      });
      assertErrorEnvelope(bad, 400);
      const confirmed = await post(
        `/trips/${id}/transition`,
        demo,
        "to-confirmed",
        { status: "confirmed" },
      );
      assert.equal(confirmed.status, 200, confirmed.text);
      assert.equal(confirmed.body.status, "confirmed");
      assertTripShape(confirmed.body);
      assert.equal(confirmed.body.name, name("Transitions"));
      const replay = await post(
        `/trips/${id}/transition`,
        demo,
        "to-confirmed",
        { status: "confirmed" },
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.body.status, "confirmed");
      const twice = await post(
        `/trips/${id}/transition`,
        demo,
        "to-confirmed-again",
        { status: "confirmed" },
      );
      assertErrorEnvelope(twice, 409, "DOMAIN_STATE_INVALID");
      const active = await post(`/trips/${id}/transition`, demo, "to-active", {
        status: "active",
      });
      assert.equal(active.body.status, "active");
      const completed = await post(
        `/trips/${id}/transition`,
        demo,
        "to-completed",
        { status: "completed" },
      );
      assert.equal(completed.body.status, "completed");
      const back = await post(
        `/trips/${id}/transition`,
        demo,
        "back-to-confirmed",
        { status: "confirmed" },
      );
      assertErrorEnvelope(back, 409, "DOMAIN_STATE_INVALID");
      const read = await api(`/trips/${id}`, demo);
      assert.equal(read.body.status, "completed");
    },
  );

  const ids = {};
  await check(
    "context points: resolved, awaiting clarification, resolve, confirm, archive",
    async () => {
      const base = `/trips/${mainTrip.id}/context-points`;
      const hotel = await post(base, demo, "cp-hotel", {
        type: "hotel",
        label: "Validator Hotel",
        address: "Jl. Validator 1",
        latitude: -6.1951,
        longitude: 106.8231,
        timezone: "Asia/Jakarta",
        external_place_id: `validator-hotel-${run}`,
      });
      assert.equal(hotel.status, 201, hotel.text);
      assert.equal(hotel.body.kind, "created");
      assert.equal(hotel.body.context_point.resolution_status, "resolved");
      assert.equal(hotel.body.context_point.confirmation_status, "unconfirmed");
      ids.hotel = hotel.body.context_point.id;

      const meeting = await post(base, demo, "cp-meeting", {
        type: "meeting",
        label: "Validator Meeting Room",
        timezone: "Asia/Jakarta",
      });
      assert.equal(meeting.status, 202, meeting.text);
      assert.equal(meeting.body.kind, "awaiting_clarification");
      assert.equal(meeting.body.context_point.resolution_status, "unresolved");
      assert.ok(meeting.body.clarification);
      ids.meeting = meeting.body.context_point.id;

      const earlyConfirm = await post(
        `${base}/${ids.meeting}/confirm`,
        demo,
        "cp-early-confirm",
        {},
      );
      assertErrorEnvelope(earlyConfirm, 400, "CONTEXT_POINT_INVALID");

      const incomplete = await post(
        `${base}/${ids.meeting}/resolve`,
        demo,
        "cp-incomplete",
        {
          latitude: -6.2,
          longitude: 106.8,
          timezone: "Asia/Jakarta",
        },
      );
      assertErrorEnvelope(incomplete, 400);

      const resolved = await post(
        `${base}/${ids.meeting}/resolve`,
        demo,
        "cp-resolve",
        {
          latitude: -6.2088,
          longitude: 106.8456,
          timezone: "Asia/Jakarta",
          external_place_id: `validator-meeting-${run}`,
          address: "Jl. Validator 2",
        },
      );
      assert.equal(resolved.status, 200, resolved.text);
      assert.equal(resolved.body.resolution_status, "resolved");
      assert.equal(resolved.body.latitude, -6.2088);

      const confirmed = await post(
        `${base}/${ids.meeting}/confirm`,
        demo,
        "cp-confirm",
        {},
      );
      assert.equal(confirmed.status, 200, confirmed.text);
      assert.equal(confirmed.body.confirmation_status, "confirmed");

      const airport = await post(base, demo, "cp-airport", {
        type: "airport",
        label: "Validator Airport",
        latitude: -6.1256,
        longitude: 106.6559,
        timezone: "Asia/Jakarta",
        external_place_id: `validator-airport-${run}`,
      });
      assert.equal(airport.status, 201, airport.text);
      ids.airport = airport.body.context_point.id;

      const spare = await post(base, demo, "cp-spare", {
        type: "custom_location",
        label: "Validator Spare",
        timezone: "Asia/Jakarta",
      });
      assert.equal(spare.status, 202, spare.text);
      const archived = await post(
        `${base}/${spare.body.context_point.id}/archive`,
        demo,
        "cp-archive",
        {},
      );
      assert.equal(archived.status, 200, archived.text);
      assert.equal(archived.body.status, "archived");

      const list = await api(base, demo);
      assert.equal(list.status, 200);
      assert.equal(list.body.items.length, 4);
    },
  );

  await check("context point input errors are structured 400s", async () => {
    const base = `/trips/${mainTrip.id}/context-points`;
    const cases = [
      [
        "unknown type",
        { type: "spaceport", label: "X", timezone: "Asia/Jakarta" },
      ],
      ["blank label", { type: "hotel", label: " ", timezone: "Asia/Jakarta" }],
      [
        "unknown timezone",
        { type: "hotel", label: "X", timezone: "Mars/Olympus" },
      ],
      [
        "latitude without longitude",
        { type: "hotel", label: "X", timezone: "Asia/Jakarta", latitude: 1 },
      ],
      [
        "latitude out of range",
        {
          type: "hotel",
          label: "X",
          timezone: "Asia/Jakarta",
          latitude: 95,
          longitude: 10,
          external_place_id: "x",
        },
      ],
    ];
    for (const [label, body] of cases) {
      const response = await post(base, demo, `cp-bad-${label}`, body);
      try {
        assertErrorEnvelope(response, 400);
      } catch (error) {
        throw new Error(`${label}: ${error.message}`);
      }
    }
    const foreign = await post(
      `${base}/${ids.hotel}/archive`,
      other,
      "cp-foreign-archive",
      {},
    );
    assert.ok([403, 404].includes(foreign.status), foreign.text);
  });

  await check(
    "agenda items: create, validate, confirm, complete, cancel",
    async () => {
      const base = `/trips/${mainTrip.id}/agenda-items`;
      const created = await post(base, demo, "agenda", {
        title: "Validator meeting",
        type: "meeting",
        start_at: "2026-11-13T09:00:00+07:00",
        end_at: "2026-11-13T10:30:00+07:00",
        timezone: "Asia/Jakarta",
        context_point_id: ids.meeting,
      });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.status, "planned");
      assert.equal(created.body.source, "user_input");
      assert.equal(created.body.context_point_id, ids.meeting);
      ids.agenda = created.body.id;
      for (const [label, patch] of [
        ["no offset", { start_at: "2026-11-13T09:00:00" }],
        ["end before start", { end_at: "2026-11-13T08:00:00+07:00" }],
        ["bad type", { type: "party" }],
        ["bad timezone", { timezone: "Mars/Olympus" }],
      ]) {
        const response = await post(base, demo, `agenda-bad-${label}`, {
          title: "Bad",
          type: "meeting",
          start_at: "2026-11-13T09:00:00+07:00",
          end_at: "2026-11-13T10:30:00+07:00",
          timezone: "Asia/Jakarta",
          ...patch,
        });
        try {
          assertErrorEnvelope(response, 400);
        } catch (error) {
          throw new Error(`${label}: ${error.message}`);
        }
      }
      const confirmed = await post(
        `${base}/${ids.agenda}/confirm`,
        demo,
        "agenda-confirm",
        {},
      );
      assert.equal(confirmed.body.status, "confirmed");
      const completed = await post(
        `${base}/${ids.agenda}/complete`,
        demo,
        "agenda-complete",
        {},
      );
      assert.equal(completed.body.status, "completed");
      const second = await post(base, demo, "agenda-2", {
        title: "Validator dinner",
        type: "meal",
        start_at: "2026-11-13T19:00:00+07:00",
        end_at: "2026-11-13T20:30:00+07:00",
        timezone: "Asia/Jakarta",
      });
      assert.equal(second.status, 201, second.text);
      const cancelled = await post(
        `${base}/${second.body.id}/cancel`,
        demo,
        "agenda-cancel",
        {},
      );
      assert.equal(cancelled.body.status, "cancelled");
      const list = await api(base, demo);
      assert.equal(list.body.items.length, 2);
    },
  );

  await check(
    "journey legs: origin and destination are chosen, never defaulted",
    async () => {
      const base = `/trips/${mainTrip.id}/journey-legs`;
      const created = await post(base, demo, "leg", {
        origin_context_point_id: ids.airport,
        destination_context_point_id: ids.hotel,
        departure_at: "2026-11-12T09:00:00+07:00",
        arrival_deadline: "2026-11-12T11:00:00+07:00",
        related_agenda_id: ids.agenda,
      });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.origin_context_point_id, ids.airport);
      assert.equal(created.body.destination_context_point_id, ids.hotel);
      assert.equal(created.body.status, "planned");
      const reversed = await post(base, demo, "leg-reversed", {
        origin_context_point_id: ids.hotel,
        destination_context_point_id: ids.airport,
        departure_at: "2026-11-14T16:00:00+07:00",
      });
      assert.equal(reversed.status, 201, reversed.text);
      assert.equal(reversed.body.origin_context_point_id, ids.hotel);
      for (const [label, body] of [
        [
          "same origin and destination",
          {
            origin_context_point_id: ids.hotel,
            destination_context_point_id: ids.hotel,
            departure_at: "2026-11-12T09:00:00+07:00",
          },
        ],
        [
          "no offset",
          {
            origin_context_point_id: ids.hotel,
            destination_context_point_id: ids.airport,
            departure_at: "2026-11-12T09:00:00",
          },
        ],
        [
          "missing destination",
          {
            origin_context_point_id: ids.hotel,
            departure_at: "2026-11-12T09:00:00+07:00",
          },
        ],
        [
          "deadline before departure",
          {
            origin_context_point_id: ids.hotel,
            destination_context_point_id: ids.airport,
            departure_at: "2026-11-12T09:00:00+07:00",
            arrival_deadline: "2026-11-12T08:00:00+07:00",
          },
        ],
      ]) {
        const response = await post(base, demo, `leg-bad-${label}`, body);
        try {
          assertErrorEnvelope(response, 400);
        } catch (error) {
          throw new Error(`${label}: ${error.message}`);
        }
      }
      const list = await api(base, demo);
      assert.equal(list.body.items.length, 2);
      const started = await post(
        `${base}/${created.body.id}/start`,
        demo,
        "leg-start",
        {},
      );
      assert.equal(started.body.status, "in_progress");
      const cancelled = await post(
        `${base}/${created.body.id}/cancel`,
        demo,
        "leg-cancel",
        {},
      );
      assert.equal(cancelled.body.status, "cancelled");
    },
  );

  await check("a journey leg needs resolved context points", async () => {
    const unresolved = await post(
      `/trips/${mainTrip.id}/context-points`,
      demo,
      "cp-unresolved",
      {
        type: "station",
        label: "Validator Station",
        timezone: "Asia/Jakarta",
      },
    );
    assert.equal(unresolved.status, 202, unresolved.text);
    const leg = await post(
      `/trips/${mainTrip.id}/journey-legs`,
      demo,
      "leg-unresolved",
      {
        origin_context_point_id: unresolved.body.context_point.id,
        destination_context_point_id: ids.hotel,
        departure_at: "2026-11-12T09:00:00+07:00",
      },
    );
    assertErrorEnvelope(leg, 400, "JOURNEY_LEG_INVALID");
  });
} finally {
  let removed = -1;
  let cleanupError = null;
  try {
    removed = await cleanupTestTrips([VALIDATOR_PREFIX], startedAt);
  } catch (error) {
    cleanupError = error;
  }
  await check("test data is removed", async () => {
    if (cleanupError) throw cleanupError;
    assert.ok(
      removed >= 4,
      `expected at least 4 test trips, removed ${removed}`,
    );
    assert.equal(await countTestTrips([VALIDATOR_PREFIX], startedAt), 0);
    const leftovers = await sql(
      `select count(*) from public.idempotency_records where position('trips-validator-${run}' in idempotency_key) = 1;`,
    );
    assert.equal(leftovers, "0", "idempotency records of the run");
  });
}

finish();
