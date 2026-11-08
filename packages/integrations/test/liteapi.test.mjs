import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ExternalDataError, LiteApiClient } from "../dist/index.js";
import { lacks } from "./helpers.mjs";

// Both fixtures are trimmed copies of real LiteAPI sandbox answers recorded on
// 2026-11-08 (flights CGK to DPS on 2026-12-12; hotels in Jakarta for two nights).
const FLIGHTS = JSON.parse(
  readFileSync(new URL("./fixtures/liteapi-flights.json", import.meta.url)),
);
const HOTELS = JSON.parse(
  readFileSync(new URL("./fixtures/liteapi-hotels.json", import.meta.url)),
);

const KEY = "sand_test_key_that_must_never_leak";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that records the request and answers with `respond(request)`. */
function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond({ url: String(url), init });
  };
  return { calls, fetchImpl };
}

function client(fetchImpl, extra = {}) {
  return new LiteApiClient({ apiKey: KEY, fetchImpl, ...extra });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExternalDataError, String(error));
    return error;
  }
  assert.fail("expected the call to be rejected");
}

const flightRequest = {
  origin: "CGK",
  destination: "DPS",
  date: "2026-12-12",
  adults: 1,
  currency: "IDR",
};

const hotelRequest = {
  city: "Jakarta",
  country_code: "ID",
  checkin: "2026-12-12",
  checkout: "2026-12-14",
  adults: 1,
  currency: "IDR",
  guest_nationality: "ID",
};

test("a flight search sends one POST with the key in a header and nowhere else", async () => {
  const { calls, fetchImpl } = recorder(() => json(FLIGHTS));
  await client(fetchImpl).searchFlights(flightRequest);
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://api.liteapi.travel/v3.0/flights/rates");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-api-key"], KEY);
  lacks(url, KEY, "the key must not be in the URL");
  lacks(init.body, KEY, "the key must not be in the body");
  assert.deepEqual(JSON.parse(init.body), {
    legs: [{ origin: "CGK", destination: "DPS", date: "2026-12-12" }],
    adults: 1,
    currency: "IDR",
  });
});

test("flight journeys are normalized and sorted by price", async () => {
  const { fetchImpl } = recorder(() => json(FLIGHTS));
  const result = await client(fetchImpl).searchFlights(flightRequest);
  assert.equal(result.journeys.length, 3);
  assert.equal(result.total_found, 3);
  const prices = result.journeys.map((j) => j.cheapest.total.amount);
  assert.deepEqual(
    prices,
    [...prices].sort((a, b) => a - b),
  );
  const first = result.journeys[0];
  assert.equal(first.cheapest.total.currency, "IDR");
  assert.equal(first.stops, 0);
  assert.equal(first.segments[0].carrier_code, "QZ");
  assert.equal(first.segments[0].carrier_name, "Indonesia AirAsia");
  assert.equal(first.segments[0].origin_code, "CGK");
  assert.equal(first.segments[0].destination_code, "DPS");
  // Local airport time stays local: no offset is invented.
  assert.equal(first.segments[0].departs_local, "2026-12-12T17:40:00");
  assert.ok(!first.segments[0].departs_local.endsWith("Z"));
  // The offer expiry is a real instant.
  assert.ok(first.cheapest.expires_at.endsWith("Z"));
  assert.equal(first.cheapest.carry_on_included, true);
  assert.equal(first.cheapest.checked_bag_included, false);
  assert.ok(first.cheapest.offer_id.length > 20);
  assert.ok(Date.parse(result.retrieved_at) > 0);
});

test("the limit keeps the cheapest journeys and still reports how many were found", async () => {
  const { fetchImpl } = recorder(() => json(FLIGHTS));
  const result = await client(fetchImpl).searchFlights({
    ...flightRequest,
    limit: 2,
  });
  assert.equal(result.journeys.length, 2);
  assert.equal(result.total_found, 3);
});

test("a flight request is refused before any call when the input is invalid", async () => {
  const { calls, fetchImpl } = recorder(() => json(FLIGHTS));
  const c = client(fetchImpl);
  const bad = [
    { ...flightRequest, origin: "cgk1" },
    { ...flightRequest, destination: "DP" },
    { ...flightRequest, destination: "CGK" },
    { ...flightRequest, date: "12-12-2026" },
    { ...flightRequest, date: "2026-02-30" },
    { ...flightRequest, adults: 0 },
    { ...flightRequest, currency: "rp" },
  ];
  for (const request of bad) {
    const error = await rejection(c.searchFlights(request));
    assert.equal(error.code, "EXTERNAL_QUERY_INVALID", JSON.stringify(request));
  }
  assert.equal(calls.length, 0, "no request may be sent for invalid input");
});

test("airport codes are accepted in lower case and normalized", async () => {
  const { calls, fetchImpl } = recorder(() => json(FLIGHTS));
  await client(fetchImpl).searchFlights({
    ...flightRequest,
    origin: " cgk ",
    destination: "dps",
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.legs[0].origin, "CGK");
  assert.equal(body.legs[0].destination, "DPS");
});

test("hotels are joined with their details, priced, and sorted", async () => {
  const { calls, fetchImpl } = recorder(() => json(HOTELS));
  const result = await client(fetchImpl).searchHotels(hotelRequest);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.liteapi.travel/v3.0/hotels/rates");
  assert.equal(JSON.parse(calls[0].init.body).currency, "IDR");
  assert.equal(result.sandbox, true);
  assert.equal(result.hotels.length, 3);
  const prices = result.hotels.map((h) => h.cheapest.total.amount);
  assert.deepEqual(
    prices,
    [...prices].sort((a, b) => a - b),
  );
  const entry = result.hotels[0];
  assert.ok(entry.hotel.name.length > 0);
  assert.equal(typeof entry.hotel.latitude, "number");
  assert.equal(typeof entry.hotel.longitude, "number");
  assert.equal(entry.cheapest.total.currency, "IDR");
  assert.ok(
    ["refundable", "non_refundable", "unknown"].includes(
      entry.cheapest.refundable,
    ),
  );
  assert.ok(entry.cheapest.offer_id.length > 20);
});

test("a hotel limit trims our answer instead of being sent to the provider", async () => {
  const { calls, fetchImpl } = recorder(() => json(HOTELS));
  const result = await client(fetchImpl).searchHotels({
    ...hotelRequest,
    limit: 1,
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal("limit" in body, false);
  assert.equal(result.hotels.length, 1);
  assert.equal(result.total_found, 3);
});

test("a hotel price with no matching hotel details is dropped, not guessed", async () => {
  const body = structuredClone(HOTELS);
  body.hotels = body.hotels.slice(1);
  const { fetchImpl } = recorder(() => json(body));
  const result = await client(fetchImpl).searchHotels(hotelRequest);
  assert.equal(result.hotels.length, 2);
});

test("a hotel request is refused before any call when the input is invalid", async () => {
  const { calls, fetchImpl } = recorder(() => json(HOTELS));
  const c = client(fetchImpl);
  const bad = [
    { ...hotelRequest, city: "  " },
    { ...hotelRequest, country_code: "IDN" },
    { ...hotelRequest, checkout: "2026-12-12" },
    { ...hotelRequest, checkin: "soon" },
    { ...hotelRequest, adults: 0 },
    { ...hotelRequest, guest_nationality: "id" },
  ];
  for (const request of bad) {
    const error = await rejection(c.searchHotels(request));
    assert.equal(error.code, "EXTERNAL_QUERY_INVALID", JSON.stringify(request));
  }
  assert.equal(calls.length, 0);
});

test("a missing key fails without any network call", async () => {
  const { calls, fetchImpl } = recorder(() => json(FLIGHTS));
  const c = new LiteApiClient({ apiKey: undefined, fetchImpl });
  assert.equal(c.configured, false);
  const error = await rejection(c.searchFlights(flightRequest));
  assert.equal(error.code, "EXTERNAL_CONFIGURATION_MISSING");
  assert.equal(calls.length, 0);
});

test("provider failures become structured errors", async () => {
  // 4xx answers that cannot succeed by repeating stay single-shot; transient
  // ones are retried because a rate search is safe to repeat.
  const cases = [
    [401, "EXTERNAL_PROVIDER_REJECTED", 1],
    [403, "EXTERNAL_PROVIDER_REJECTED", 1],
    [400, "EXTERNAL_QUERY_INVALID", 1],
    [429, "EXTERNAL_PROVIDER_RATE_LIMITED", 3],
    [500, "EXTERNAL_PROVIDER_ERROR", 3],
    [503, "EXTERNAL_PROVIDER_ERROR", 3],
  ];
  for (const [status, code, attempts] of cases) {
    const { calls, fetchImpl } = recorder(() =>
      json({ error: { code: 1, description: "x" } }, status),
    );
    const error = await rejection(
      client(fetchImpl).searchFlights(flightRequest),
    );
    assert.equal(error.code, code, `HTTP ${status}`);
    assert.equal(error.provider, "liteapi");
    assert.equal(calls.length, attempts, `HTTP ${status} attempts`);
    lacks(JSON.stringify(error.details ?? {}), KEY);
    lacks(error.message, KEY);
  }
});

test("a provider validation error keeps its code, description and field for the form", async () => {
  const { fetchImpl } = recorder(() =>
    json(
      {
        error: {
          code: 43002,
          description:
            "The airline requires a travel document for every passenger on this offer.",
          key: "bodyRequest",
          message: "prebook validation error",
        },
      },
      400,
    ),
  );
  const error = await rejection(client(fetchImpl).searchFlights(flightRequest));
  assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
  assert.equal(error.details.provider_status, 400);
  assert.equal(error.details.provider_error.code, 43002);
  assert.equal(error.details.provider_error.field, "bodyRequest");
  assert.ok(
    error.details.provider_error.description.includes("travel document"),
  );
});

test("an error body that is not the documented shape is not passed on", async () => {
  const { fetchImpl } = recorder(
    () =>
      new Response(
        "<html><body>Traceback (most recent call last)</body></html>",
        {
          status: 400,
          headers: { "content-type": "text/html" },
        },
      ),
  );
  const error = await rejection(client(fetchImpl).searchFlights(flightRequest));
  assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
  assert.equal(error.details.provider_error, null);
  lacks(JSON.stringify(error.details), "Traceback");
});

test("a slow provider is cut off by the timeout", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const abort = new Error("aborted");
        abort.name = "AbortError";
        reject(abort);
      });
    });
  const error = await rejection(
    client(fetchImpl, { timeoutMs: 20 }).searchFlights(flightRequest),
  );
  assert.equal(error.code, "EXTERNAL_PROVIDER_TIMEOUT");
  assert.equal(error.retryable, true);
});

test("an answer over the size limit is refused", async () => {
  const { fetchImpl } = recorder(() => json(FLIGHTS));
  const error = await rejection(
    client(fetchImpl, { maxResponseBytes: 500 }).searchFlights(flightRequest),
  );
  assert.equal(error.code, "EXTERNAL_RESPONSE_INVALID");
});

test("malformed answers are refused instead of defaulted", async () => {
  const broken = [
    [{}, "no data"],
    [{ data: [] }, "empty data"],
    [{ data: [{ journeys: "nope" }] }, "journeys not a list"],
    [{ data: [{ journeys: [{ segments: [] }] }] }, "journey without segments"],
  ];
  for (const [body, label] of broken) {
    const { fetchImpl } = recorder(() => json(body));
    const error = await rejection(
      client(fetchImpl).searchFlights(flightRequest),
    );
    assert.equal(error.code, "EXTERNAL_RESPONSE_INVALID", label);
  }

  const noPrice = structuredClone(FLIGHTS);
  delete noPrice.data[0].journeys[0].cheapestOffer.pricing;
  const { fetchImpl: priceless } = recorder(() => json(noPrice));
  const error = await rejection(client(priceless).searchFlights(flightRequest));
  assert.equal(error.code, "EXTERNAL_RESPONSE_INVALID");

  const notJson = recorder(() => new Response("not json", { status: 200 }));
  const parse = await rejection(
    client(notJson.fetchImpl).searchFlights(flightRequest),
  );
  assert.equal(parse.code, "EXTERNAL_RESPONSE_INVALID");
});

// ---------------------------------------------------------------------------
// Booking. Fixtures are copies of the answers the sandbox gave on 2026-11-08.

const BOOKING = JSON.parse(
  readFileSync(new URL("./fixtures/liteapi-booking.json", import.meta.url)),
);

const holder = {
  first_name: "Sandbox",
  last_name: "Tester",
  email: "sandbox.tester@example.com",
  phone: "+6281200000000",
};

const passenger = {
  type: "adult",
  title: "MR",
  first_name: "Sandbox",
  last_name: "Tester",
  birthday: "1990-01-15",
  gender: "M",
  nationality: "ID",
  document: {
    type: "passport",
    number: "X0000000",
    issue_country: "ID",
    expiry: "2031-01-01",
  },
};

const flightPrebookRequest = {
  offer_id: "offer-1",
  purpose: "BUSINESS",
  contact: {
    first_name: "Sandbox",
    last_name: "Tester",
    email: "sandbox.tester@example.com",
    phone_country_code: "62",
    phone_number: "81200000000",
  },
  passengers: [passenger],
};

test("a hotel prebook asks for no card payment and reports price movement", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.hotelPrebook));
  const result = await client(fetchImpl).prebookHotel({ offer_id: "offer-1" });
  assert.equal(calls[0].url, "https://book.liteapi.travel/v3.0/rates/prebook");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    offerId: "offer-1",
    usePaymentSdk: false,
  });
  assert.equal(result.prebook_id, "rpagt_hh3");
  assert.equal(result.total.currency, "IDR");
  assert.equal(result.checkin, "2026-12-12");
  assert.equal(result.checkout, "2026-12-14");
  assert.equal(result.price_difference_percent, 0);
  assert.equal(result.cancellation_changed, false);
});

test("a hotel booking pays with the account test card and carries no card data", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.hotelBooking));
  const result = await client(fetchImpl).bookHotel({
    prebook_id: "rpagt_hh3",
    client_reference: "tf-abc",
    holder,
    guests: [
      {
        occupancy_number: 1,
        first_name: "Sandbox",
        last_name: "Tester",
        email: "sandbox.tester@example.com",
      },
    ],
  });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.payment, { method: "ACC_CREDIT_CARD" });
  assert.equal(body.prebookId, "rpagt_hh3");
  assert.equal(body.clientReference, "tf-abc");
  assert.equal(body.guests[0].occupancyNumber, 1);
  // The method name contains "card", so look for card DATA fields, not the word.
  assert.deepEqual(Object.keys(body.payment), ["method"]);
  const text = JSON.stringify(body).toLowerCase();
  for (const forbidden of [
    "billinginfo",
    "creditcardnumber",
    "creditcardidentifier",
    "cvv",
    "expirationmonth",
    "holdername",
  ]) {
    lacks(text, forbidden);
  }
  assert.equal(result.booking_id, "_5XLCOI4h");
  assert.equal(result.state, "confirmed");
  assert.equal(result.confirmation_code, "test");
  assert.equal(
    result.hotel_name,
    "Aston Kartika Grogol Hotel & Conference Center",
  );
  assert.equal(result.total.amount, 1827964.43);
  assert.equal(result.sandbox, true);
  assert.equal(result.free_cancellation_until, "2026-12-07T09:00:00.000Z");
});

test("a hotel booking is refused without a phone number, a guest, or a prebook id", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.hotelBooking));
  const c = client(fetchImpl);
  const guest = {
    occupancy_number: 1,
    first_name: "A",
    last_name: "B",
    email: "a@b.co",
  };
  const bad = [
    { prebook_id: "p", holder: { ...holder, phone: " " }, guests: [guest] },
    { prebook_id: "p", holder, guests: [] },
    { prebook_id: " ", holder, guests: [guest] },
    {
      prebook_id: "p",
      holder: { ...holder, email: "not-an-email" },
      guests: [guest],
    },
  ];
  for (const request of bad) {
    const error = await rejection(c.bookHotel(request));
    assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
  }
  assert.equal(calls.length, 0);
});

test("a hotel cancellation reports the fee and the refund", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.hotelCancel));
  const result = await client(fetchImpl).cancelHotelBooking("_5XLCOI4h");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(
    calls[0].url,
    "https://book.liteapi.travel/v3.0/bookings/_5XLCOI4h",
  );
  assert.equal(result.state, "cancelled");
  assert.equal(result.fee.amount, 0);
  assert.equal(result.refund.amount, 1827964.43);
});

test("a booking id is encoded into the path and cannot escape it", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.hotelBooking));
  await client(fetchImpl).getHotelBooking("a/b?c=d#e");
  assert.equal(
    calls[0].url,
    "https://book.liteapi.travel/v3.0/bookings/a%2Fb%3Fc%3Dd%23e",
  );
  const { calls: none, fetchImpl: other } = recorder(() => json({}));
  const error = await rejection(client(other).getHotelBooking("  "));
  assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
  assert.equal(none.length, 0);
});

test("a flight prebook sends the passenger as the airline needs and no Stripe step", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.flightPrebook));
  const result = await client(fetchImpl).prebookFlight(flightPrebookRequest);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(
    calls[0].url,
    "https://api.liteapi.travel/v3.0/flights/prebooks",
  );
  assert.equal(body.usePaymentSdk, false);
  assert.equal(body.travelPurpose, "BUSINESS");
  assert.equal(body.contact.phoneCountryCode, "62");
  assert.equal(body.passengers[0].passengerType, 0);
  assert.equal(body.passengers[0].title, "MR");
  assert.equal(body.passengers[0].birthday, "1990-01-15");
  assert.equal(body.passengers[0].documentNumber, "X0000000");
  assert.equal(result.prebook_id, "01a1b9bf-839a-7629-9a88-0ac8c7059d96");
  assert.equal(result.total.currency, "IDR");
});

test("a flight prebook without a document is sent without one, so the airline can ask", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.flightPrebook));
  const { document: _omit, ...withoutDocument } = passenger;
  await client(fetchImpl).prebookFlight({
    ...flightPrebookRequest,
    passengers: [withoutDocument],
  });
  const sent = JSON.parse(calls[0].init.body).passengers[0];
  assert.equal("documentNumber" in sent, false);
  assert.equal("documentType" in sent, false);
});

test("a flight prebook is refused before any call when a passenger is invalid", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.flightPrebook));
  const c = client(fetchImpl);
  const bad = [
    { ...flightPrebookRequest, passengers: [] },
    {
      ...flightPrebookRequest,
      passengers: [{ ...passenger, birthday: "1990-02-30" }],
    },
    {
      ...flightPrebookRequest,
      passengers: [{ ...passenger, nationality: "id" }],
    },
    {
      ...flightPrebookRequest,
      passengers: [
        { ...passenger, document: { ...passenger.document, expiry: "soon" } },
      ],
    },
    {
      ...flightPrebookRequest,
      contact: { ...flightPrebookRequest.contact, phone_number: "12" },
    },
    {
      ...flightPrebookRequest,
      contact: { ...flightPrebookRequest.contact, phone_country_code: "+62" },
    },
    { ...flightPrebookRequest, offer_id: " " },
  ];
  for (const request of bad) {
    const error = await rejection(c.prebookFlight(request));
    assert.equal(
      error.code,
      "EXTERNAL_QUERY_INVALID",
      JSON.stringify(request).slice(0, 80),
    );
  }
  assert.equal(calls.length, 0);
});

test("an airline that wants a travel document is reported with its own words", async () => {
  const { fetchImpl } = recorder(() =>
    json(
      {
        error: {
          code: 43002,
          description:
            "The airline requires a travel document for every passenger on this offer.",
          key: "bodyRequest",
        },
      },
      400,
    ),
  );
  const error = await rejection(
    client(fetchImpl).prebookFlight(flightPrebookRequest),
  );
  assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
  assert.equal(error.details.provider_error.code, 43002);
});

test("a flight booking pays with the account test card", async () => {
  const { calls, fetchImpl } = recorder(() =>
    json(BOOKING.flightBookingCreated, 201),
  );
  const result = await client(fetchImpl).bookFlight({ prebook_id: "pre-1" });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    prebookId: "pre-1",
    payment: { method: "ACC_CREDIT_CARD" },
  });
  assert.equal(result.booking_id, "01a1b8c8-60dd-703d-aeeb-f5617cfa04ab");
  assert.equal(result.state, "pending");
  assert.equal(result.provider_status, "PENDING_CONFIRMATION");
});

test("a flight booking read after ticketing is confirmed and has a reference", async () => {
  const { fetchImpl } = recorder(() => json(BOOKING.flightBooking));
  const result = await client(fetchImpl).getFlightBooking("id-1");
  assert.equal(result.state, "confirmed");
  assert.equal(result.booking_reference, "FH-26B-X3DW2923");
  assert.equal(result.total.amount, 1033821.31);
  assert.ok(result.ticket_deadline.endsWith("Z"));
});

test("the passport number never leaves the adapter; only its last four characters do", async () => {
  const { fetchImpl } = recorder(() => json(BOOKING.flightBooking));
  const result = await client(fetchImpl).getFlightBooking("id-1");
  assert.equal(result.passengers.length, 1);
  assert.equal(result.passengers[0].document_last4, "0000");
  assert.equal(result.passengers[0].first_name.toLowerCase(), "sandbox");
  const serialized = JSON.stringify(result);
  lacks(serialized, "X0000000", "the full document number must not be carried");
  assert.ok(!("documentNumber" in result.passengers[0]));
});

test("a status the adapter has not seen is reported as unknown, not as a success", async () => {
  const odd = structuredClone(BOOKING.flightBooking);
  odd.data[0].status = "SOMETHING_NEW";
  const { fetchImpl } = recorder(() => json(odd));
  const result = await client(fetchImpl).getFlightBooking("id-1");
  assert.equal(result.state, "unknown");
  assert.equal(result.provider_status, "SOMETHING_NEW");
});

test("a flight cancellation quote says what is refunded and what is kept", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.flightQuote));
  const quote = await client(fetchImpl).quoteFlightCancellation("id-1");
  assert.equal(calls[0].init.method, "GET");
  assert.ok(calls[0].url.endsWith("/flights/bookings/id-1/cancellations"));
  assert.equal(quote.refund.amount, 892116.02);
  assert.equal(quote.penalty.amount, 123254.08);
  assert.equal(quote.refundable, true);
  assert.equal(quote.confidence, "estimated");
});

test("a flight cancellation is only a request: the result says accepted, not cancelled", async () => {
  const { calls, fetchImpl } = recorder(() => json(BOOKING.flightCancel, 202));
  const result = await client(fetchImpl).cancelFlightBooking("id-1");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(result.accepted, true);
  assert.equal(result.refund.amount, 892116.02);
  assert.equal(result.fee.amount, 123254.08);
  assert.ok(
    !("state" in result),
    "a cancellation request must not claim a final state",
  );
});

test("a second cancellation while one is pending is a provider conflict, not success", async () => {
  const { calls, fetchImpl } = recorder(() =>
    json(
      {
        error: {
          code: 49007,
          description:
            "a cancellation is already in progress (awaiting confirmation)",
          key: "bodyRequest",
        },
      },
      409,
    ),
  );
  const error = await rejection(client(fetchImpl).cancelFlightBooking("id-1"));
  assert.equal(error.code, "EXTERNAL_PROVIDER_ERROR");
  assert.equal(error.details.provider_status, 409);
  assert.equal(calls.length, 1, "no retry");
});

test("a provider error that only has a message is still passed on", async () => {
  const { fetchImpl } = recorder(() =>
    json(
      {
        error: {
          code: 4005,
          message: "duplicate booking attempt with existing client reference",
        },
      },
      400,
    ),
  );
  const error = await rejection(
    client(fetchImpl).bookHotel({
      prebook_id: "p",
      holder,
      guests: [
        {
          occupancy_number: 1,
          first_name: "A",
          last_name: "B",
          email: "a@b.co",
        },
      ],
    }),
  );
  assert.equal(error.details.provider_error.code, 4005);
  assert.ok(error.details.provider_error.description.includes("duplicate"));
});

test("a cancellation that carries charges is still a cancellation", async () => {
  const body = structuredClone(BOOKING.hotelBooking);
  body.data.status = "CANCELLED_WITH_CHARGES";
  const { fetchImpl } = recorder(() => json(body));
  const result = await client(fetchImpl).getHotelBooking("x");
  assert.equal(result.state, "cancelled");
  assert.equal(result.provider_status, "CANCELLED_WITH_CHARGES");
});

test("a flight verify posts the offer id and reads the binding price", async () => {
  const { calls, fetchImpl } = recorder(() =>
    json({
      data: [
        {
          journey: {
            journeyKey: "26b2fa3085dc22b2",
            pricing: { display: { total: 1423.42, currency: "USD" } },
          },
          changes: {
            messages: ["Price changed since search"],
            pricing: { old: { total: 1399 }, new: { total: 1423.42 } },
          },
        },
      ],
    }),
  );
  const result = await client(fetchImpl).verifyFlight("offer-1");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://api.liteapi.travel/v3.0/flights/verify");
  assert.equal(body.offerId, "offer-1");
  assert.equal(result.offer_id, "offer-1");
  assert.equal(result.journey_key, "26b2fa3085dc22b2");
  assert.equal(result.total.amount, 1423.42);
  assert.equal(result.total.currency, "USD");
  assert.equal(result.changed, true);
  assert.deepEqual(result.messages, ["Price changed since search"]);
});

test("a flight verify without a changes block is reported as unchanged", async () => {
  const { fetchImpl } = recorder(() =>
    json({
      data: [
        {
          journey: {
            journeyKey: "abc",
            pricing: { display: { total: 99.5, currency: "EUR" } },
          },
        },
      ],
    }),
  );
  const result = await client(fetchImpl).verifyFlight("offer-2");
  assert.equal(result.changed, false);
  assert.deepEqual(result.messages, []);
  assert.equal(result.total.amount, 99.5);
});

test("a blank offer id is refused before the verify call", async () => {
  const { calls, fetchImpl } = recorder(() => json({ data: [] }));
  const error = await rejection(client(fetchImpl).verifyFlight("  "));
  assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
  assert.equal(calls.length, 0);
});

const LOOKED_UP_BOOKING = {
  bookingId: "bk_123",
  status: "CONFIRMED",
  hotelConfirmationCode: "CNF-9",
  checkin: "2026-11-12",
  checkout: "2026-11-14",
  price: 62.69,
  currency: "USD",
};

test("a booking is looked up by the client reference we stored", async () => {
  const { calls, fetchImpl } = recorder(() =>
    json({ data: [LOOKED_UP_BOOKING] }),
  );
  const result =
    await client(fetchImpl).findHotelBookingByClientReference("travelflow-abc");
  assert.equal(
    calls[0].url,
    "https://book.liteapi.travel/v3.0/bookings?clientReference=travelflow-abc&timeout=10",
  );
  assert.equal(result?.booking_id, "bk_123");
  assert.equal(result?.confirmation_code, "CNF-9");
  assert.equal(result?.state, "confirmed");
  assert.equal(result?.total.amount, 62.69);
});

test("a missing booking by client reference is reported as null, not an error", async () => {
  const { fetchImpl } = recorder(() => json({ data: [] }));
  const result =
    await client(fetchImpl).findHotelBookingByClientReference(
      "travelflow-none",
    );
  assert.equal(result, null);
});
