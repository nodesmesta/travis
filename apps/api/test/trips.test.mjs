import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { AppError } from "../dist/errors.js";
import { parseCreateTripBody, tripRoutes } from "../dist/routes/trips.js";

// The database below is an in-memory FIXTURE that mimics the few Supabase
// query-builder calls `POST /trips` makes. It is not the real database; the
// real one is exercised by scripts/validate-task-trips.mjs.

const USER_A = "00000000-0000-0000-0000-0000000000a1";
const USER_B = "00000000-0000-0000-0000-0000000000b1";
const KEY = "trip-test-key-0000000001";

function fakeDatabase() {
  const tables = { idempotency_records: [], trips: [], activity_logs: [] };
  let counter = 0;
  const nextId = () => {
    counter += 1;
    return `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
  };
  const matches = (row, filters) =>
    filters.every(([column, value]) => row[column] === value);

  function builder(table) {
    const rows = tables[table];
    assert.ok(rows, `unexpected table ${table}`);
    let operation = "select";
    let payload;
    let single = null;
    const filters = [];
    function run() {
      if (operation === "insert") {
        const row = {
          id: nextId(),
          created_at: "2026-11-07T00:00:00+00:00",
          updated_at: "2026-11-07T00:00:00+00:00",
          ...payload,
        };
        if (table === "idempotency_records") {
          const duplicate = rows.some(
            (entry) =>
              entry.actor_user_id === row.actor_user_id &&
              entry.scope === row.scope &&
              entry.idempotency_key === row.idempotency_key,
          );
          if (duplicate) {
            return Promise.resolve({ data: null, error: { code: "23505" } });
          }
        }
        rows.push(row);
        return Promise.resolve({
          data: single ? row : null,
          error: null,
        });
      }
      if (operation === "update") {
        for (const row of rows.filter((entry) => matches(entry, filters))) {
          Object.assign(row, payload);
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (operation === "delete") {
        for (const row of rows.filter((entry) => matches(entry, filters))) {
          rows.splice(rows.indexOf(row), 1);
        }
        return Promise.resolve({ data: null, error: null });
      }
      const found = rows.filter((entry) => matches(entry, filters));
      return Promise.resolve({
        data: single ? (found[0] ?? null) : found,
        error: null,
      });
    }
    const api = {
      select: () => api,
      insert: (row) => {
        operation = "insert";
        payload = row;
        return api;
      },
      update: (row) => {
        operation = "update";
        payload = row;
        return api;
      },
      delete: () => {
        operation = "delete";
        return api;
      },
      eq: (column, value) => {
        filters.push([column, value]);
        return api;
      },
      maybeSingle: () => {
        single = "maybe";
        return run();
      },
      single: () => {
        single = "single";
        return run();
      },
      then: (resolve, reject) => run().then(resolve, reject),
    };
    return api;
  }
  return { tables, client: { from: builder } };
}

function call(
  database,
  userId,
  { body, key = KEY, method = "POST", path } = {},
) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Object.assign(Readable.from(chunks), {
    method,
    headers: key === null ? {} : { "idempotency-key": key },
  });
  const captured = { status: null, body: null };
  const response = {
    writeHead: (status) => {
      captured.status = status;
    },
    end: (text) => {
      captured.body = JSON.parse(text);
    },
  };
  const context = {
    request,
    response,
    requestId: "req-test",
    method,
    url: new URL(`http://localhost${path ?? "/api/v1/trips"}`),
    authenticate: async () => ({
      user: { id: userId },
      accessToken: "token",
      client: database.client,
    }),
  };
  return tripRoutes(context).then((handled) => ({ handled, ...captured }));
}

const valid = {
  name: "Jakarta Business Trip",
  destination_summary: "Jakarta, Indonesia",
  start_at: "2026-11-12T08:00:00+07:00",
  end_at: "2026-11-14T20:00:00+07:00",
  timezone: "Asia/Jakarta",
};

const rejects400 = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.statusCode, 400);
    if (code) assert.equal(error.code, code);
    return true;
  });

test("creates a draft trip owned by the signed-in user and logs it", async () => {
  const database = fakeDatabase();
  const result = await call(database, USER_A, { body: valid });
  assert.equal(result.handled, true);
  assert.equal(result.status, 201);
  assert.equal(result.body.status, "draft");
  assert.equal(result.body.user_id, USER_A);
  assert.equal(result.body.name, "Jakarta Business Trip");
  assert.equal(result.body.timezone, "Asia/Jakarta");
  assert.equal(result.body.start_at, valid.start_at);
  assert.equal(result.body.source, "user_input");
  assert.equal(result.body.request_id, "req-test");
  assert.equal(database.tables.trips.length, 1);
  assert.equal(database.tables.activity_logs.length, 1);
  const log = database.tables.activity_logs[0];
  assert.equal(log.action, "trip.created");
  assert.equal(log.actor_user_id, USER_A);
  assert.equal(log.resource_id, result.body.id);
});

test("two users each own only the trip they created", async () => {
  const database = fakeDatabase();
  const a = await call(database, USER_A, { body: valid });
  const b = await call(database, USER_B, { body: valid });
  assert.notEqual(a.body.id, b.body.id);
  assert.equal(a.body.user_id, USER_A);
  assert.equal(b.body.user_id, USER_B);
});

test("a body cannot choose the owner, the status, or any other field", async () => {
  const database = fakeDatabase();
  for (const extra of [
    { user_id: USER_B },
    { status: "active" },
    { id: "x" },
    { created_at: "2020-01-01T00:00:00Z" },
  ]) {
    await rejects400(
      call(database, USER_A, { body: { ...valid, ...extra } }),
      "TRIP_INVALID",
    );
  }
  assert.equal(database.tables.trips.length, 0);
});

test("replaying the same Idempotency-Key returns the same trip once", async () => {
  const database = fakeDatabase();
  const first = await call(database, USER_A, { body: valid });
  const second = await call(database, USER_A, { body: valid });
  assert.equal(second.status, 201);
  assert.equal(second.body.id, first.body.id);
  assert.equal(database.tables.trips.length, 1);
  assert.equal(database.tables.activity_logs.length, 1);
});

test("the same key with a different body is a conflict", async () => {
  const database = fakeDatabase();
  await call(database, USER_A, { body: valid });
  await assert.rejects(
    call(database, USER_A, { body: { ...valid, name: "Another trip" } }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "IDEMPOTENCY_CONFLICT");
      return true;
    },
  );
  assert.equal(database.tables.trips.length, 1);
});

test("a different key creates a second trip", async () => {
  const database = fakeDatabase();
  await call(database, USER_A, { body: valid });
  await call(database, USER_A, {
    body: valid,
    key: "trip-test-key-0000000002",
  });
  assert.equal(database.tables.trips.length, 2);
});

test("a missing or short Idempotency-Key is rejected before anything is written", async () => {
  const database = fakeDatabase();
  await rejects400(
    call(database, USER_A, { body: valid, key: null }),
    "IDEMPOTENCY_KEY_INVALID",
  );
  await rejects400(
    call(database, USER_A, { body: valid, key: "short" }),
    "IDEMPOTENCY_KEY_INVALID",
  );
  assert.equal(database.tables.trips.length, 0);
});

test("invalid input is a structured 400 and writes nothing", async () => {
  const database = fakeDatabase();
  const cases = [
    ["start_at without an offset", { start_at: "2026-11-12T08:00:00" }],
    ["end_at without an offset", { end_at: "2026-11-14T20:00:00" }],
    ["date only", { start_at: "2026-11-12" }],
    ["space instead of T", { start_at: "2026-11-12 08:00:00+07:00" }],
    ["a day that does not exist", { start_at: "2026-02-30T08:00:00+07:00" }],
    ["month 13", { start_at: "2026-13-01T08:00:00+07:00" }],
    ["hour 25", { start_at: "2026-11-12T25:00:00+07:00" }],
    ["text instead of a date", { start_at: "tomorrow" }],
    [
      "end before start",
      {
        start_at: "2026-11-14T08:00:00+07:00",
        end_at: "2026-11-12T08:00:00+07:00",
      },
    ],
    [
      "end equal to start",
      { start_at: "2026-11-12T08:00:00+07:00", end_at: "2026-11-12T01:00:00Z" },
    ],
    ["unknown timezone", { timezone: "Mars/Olympus" }],
    ["UTC offset as timezone", { timezone: "+07:00" }],
    ["negative offset as timezone", { timezone: "-05:00" }],
    ["blank timezone", { timezone: "   " }],
    ["blank name", { name: "   " }],
    ["name over 160 characters", { name: "x".repeat(161) }],
    [
      "destination over 500 characters",
      { destination_summary: "x".repeat(501) },
    ],
    ["unknown source", { source: "somewhere_else" }],
    ["name is not text", { name: 12 }],
    ["start_at is not text", { start_at: 12 }],
    ["unknown field", { colour: "red" }],
  ];
  for (const [label, patch] of cases) {
    await assert.rejects(
      call(database, USER_A, { body: { ...valid, ...patch } }),
      (error) => {
        assert.ok(error instanceof AppError, `${label}: ${String(error)}`);
        assert.equal(error.statusCode, 400, label);
        assert.ok(error.message.length > 0, label);
        return true;
      },
      label,
    );
  }
  assert.equal(database.tables.trips.length, 0);
  assert.equal(database.tables.idempotency_records.length, 0);
});

test("a missing name or timezone, and a body that is not an object, are rejected", async () => {
  const database = fakeDatabase();
  const { name: _name, ...withoutName } = valid;
  const { timezone: _timezone, ...withoutTimezone } = valid;
  await rejects400(call(database, USER_A, { body: withoutName }));
  await rejects400(call(database, USER_A, { body: withoutTimezone }));
  await rejects400(call(database, USER_A, { body: ["not", "an", "object"] }));
  await rejects400(call(database, USER_A, {}), "REQUEST_BODY_INVALID");
});

test("dates and destination are optional; blank values are stored as null", async () => {
  const database = fakeDatabase();
  const minimal = await call(database, USER_A, {
    body: { name: "  Quick trip  ", timezone: "Asia/Singapore" },
  });
  assert.equal(minimal.status, 201);
  assert.equal(minimal.body.name, "Quick trip");
  assert.equal(minimal.body.start_at, null);
  assert.equal(minimal.body.end_at, null);
  assert.equal(minimal.body.destination_summary, null);

  const blank = await call(database, USER_A, {
    key: "trip-test-key-0000000003",
    body: {
      name: "Blank fields",
      timezone: "Asia/Tokyo",
      destination_summary: "   ",
      start_at: "",
    },
  });
  assert.equal(blank.body.destination_summary, null);
  assert.equal(blank.body.start_at, null);
});

test("accepts Z and negative offsets and a real leap day", () => {
  const parsed = parseCreateTripBody({
    name: "Leap",
    timezone: "America/New_York",
    start_at: "2028-02-29T09:00:00-05:00",
    end_at: "2028-03-01T09:00:00Z",
    source: "imported_booking",
  });
  assert.equal(parsed.startAt, "2028-02-29T09:00:00-05:00");
  assert.equal(parsed.source, "imported_booking");
  assert.throws(() =>
    parseCreateTripBody({
      name: "No leap day",
      timezone: "UTC",
      start_at: "2026-02-29T09:00:00Z",
    }),
  );
});

test("other methods and paths are left to the next route module", async () => {
  const database = fakeDatabase();
  assert.equal(
    (await call(database, USER_A, { method: "GET", body: valid })).handled,
    false,
  );
  assert.equal(
    (await call(database, USER_A, { body: valid, path: "/api/v1/trips/x" }))
      .handled,
    false,
  );
});
