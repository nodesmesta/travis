import assert from "node:assert/strict";

const required = [
  "TASK02_SUPABASE_URL",
  "TASK02_ANON_KEY",
  "TASK02_API_BASE_URL",
  "TASK02_OWNER_EMAIL",
  "TASK02_OWNER_PASSWORD",
  "TASK02_NON_OWNER_EMAIL",
  "TASK02_NON_OWNER_PASSWORD",
];
for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const supabaseUrl = process.env.TASK02_SUPABASE_URL;
const anonKey = process.env.TASK02_ANON_KEY;
const apiBaseUrl = process.env.TASK02_API_BASE_URL;
const ownerEmail = process.env.TASK02_OWNER_EMAIL;
const ownerPassword = process.env.TASK02_OWNER_PASSWORD;
const nonOwnerEmail = process.env.TASK02_NON_OWNER_EMAIL;
const nonOwnerPassword = process.env.TASK02_NON_OWNER_PASSWORD;

async function login(email, password) {
  const response = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.access_token;
}

async function rest(path, token, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  assert.equal(
    response.ok,
    true,
    `${response.status}: ${JSON.stringify(body)}`,
  );
  return body;
}

async function api(path, token, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
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

const ownerToken = await login(ownerEmail, ownerPassword);
const nonOwnerToken = await login(nonOwnerEmail, nonOwnerPassword);
const tripId = "00000000-0000-0000-0000-000000000001";

const ownerTrips = await rest(
  `/trips?select=id,user_id&id=eq.${tripId}`,
  ownerToken,
);
const nonOwnerTrips = await rest(
  `/trips?select=id&id=eq.${tripId}`,
  nonOwnerToken,
);
assert.equal(ownerTrips.length, 1);
assert.equal(nonOwnerTrips.length, 0);

const ownerContextPoints = await rest(
  `/context_points?select=id&trip_id=eq.${tripId}`,
  ownerToken,
);
const nonOwnerContextPoints = await rest(
  `/context_points?select=id&trip_id=eq.${tripId}`,
  nonOwnerToken,
);
assert.equal(ownerContextPoints.length, 3);
assert.equal(nonOwnerContextPoints.length, 0);

const ownerUpdate = await rest(`/trips?id=eq.${tripId}`, ownerToken, {
  method: "PATCH",
  headers: {
    "content-type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify({ name: "Jakarta Business Trip" }),
});
const nonOwnerUpdate = await rest(`/trips?id=eq.${tripId}`, nonOwnerToken, {
  method: "PATCH",
  headers: {
    "content-type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify({ name: "Must Not Change" }),
});
assert.equal(ownerUpdate.length, 1);
assert.equal(nonOwnerUpdate.length, 0);

const apiMe = await api("/auth/me", ownerToken);
assert.equal(apiMe.status, 200);
assert.equal(apiMe.body.user.email, ownerEmail);

const apiTrips = await api("/trips", ownerToken);
assert.equal(apiTrips.status, 200);
assert.equal(apiTrips.body.items.length, 1);

const apiContextPoints = await api(
  `/trips/${tripId}/context-points`,
  ownerToken,
);
assert.equal(apiContextPoints.status, 200);
assert.equal(apiContextPoints.body.items.length, 3);

const apiOwnerUpdate = await api(`/trips/${tripId}`, ownerToken, {
  method: "PATCH",
  body: JSON.stringify({ name: "Jakarta Business Trip" }),
});
assert.equal(apiOwnerUpdate.status, 200);

const apiNonOwnerRead = await api(`/trips/${tripId}`, nonOwnerToken);
assert.equal(apiNonOwnerRead.status, 404);
assert.equal(apiNonOwnerRead.body.error.code, "RESOURCE_NOT_FOUND");

console.log(
  JSON.stringify({
    auth: "ok",
    rls_owner_trip_rows: ownerTrips.length,
    rls_non_owner_trip_rows: nonOwnerTrips.length,
    rls_owner_context_rows: ownerContextPoints.length,
    rls_non_owner_context_rows: nonOwnerContextPoints.length,
    rls_owner_update_rows: ownerUpdate.length,
    rls_non_owner_update_rows: nonOwnerUpdate.length,
    api_owner_context_rows: apiContextPoints.body.items.length,
    api_non_owner_read_status: apiNonOwnerRead.status,
  }),
);
