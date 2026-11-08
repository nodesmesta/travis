import assert from "node:assert/strict";
import test from "node:test";
import { LiteApiBookingService } from "../dist/services/liteapi-booking-service.js";

// Everything here is FIXTURE data and in-memory stand-ins for the repository and the
// provider. What it locks: a confirmed hotel becomes an agenda item, the trip's
// location and a weather read — the three things whose absence left a paid booking
// with no itinerary, no place, and no agent input.

const TRIP = "00000000-0000-0000-0000-0000000000a1";
const USER = "00000000-0000-0000-0000-0000000000b1";
const BOOKING = "00000000-0000-0000-0000-0000000000c1";
const ATTEMPT = "00000000-0000-0000-0000-0000000000d1";

function tripRow(overrides = {}) {
  return {
    id: TRIP,
    user_id: USER,
    name: "Surabaya stay",
    destination_summary: "Surabaya, Indonesia",
    start_at: "2026-11-11T02:00:00+00:00",
    end_at: "2026-11-12T11:00:00+00:00",
    timezone: "Asia/Jakarta",
    status: "draft",
    source: "search",
    created_at: "2026-11-08T18:18:16+00:00",
    updated_at: "2026-11-08T18:18:16+00:00",
    ...overrides,
  };
}

class FakeRepo {
  constructor({ bookingType = "hotel" } = {}) {
    this.trip = tripRow();
    this.booking = {
      id: BOOKING,
      user_id: USER,
      trip_id: TRIP,
      booking_type: bookingType,
      status: "pending_payment",
      source_type: "liteapi_offer",
      source_id: ATTEMPT,
      provider_name: "liteapi",
      currency: "USD",
      subtotal: 4.01,
      tax: 0,
      total: 4.01,
      confirmation_code: null,
    };
    this.providerBooking = {
      id: ATTEMPT,
      booking_id: BOOKING,
      trip_id: TRIP,
      booking_type: bookingType,
      prebook_id: "prebook-fixture",
      client_reference: "travis-fixture",
      state: "prebooked",
      provider_status: "PREBOOKED",
      provider_booking_id: null,
      confirmation_code: null,
      checkin: "2026-11-11",
      checkout: "2026-11-12",
      metadata: { hotel_id: "lp123", hotel_name: "Hotel Fixture" },
    };
    this.agenda = [];
    this.points = [];
    this.legs = [];
  }

  async getTrip(tripId) {
    return tripId === this.trip.id ? this.trip : null;
  }

  async updateTripForBooking(tripId, patch) {
    this.trip = { ...this.trip, ...patch };
    return this.trip;
  }

  async getProviderBooking(id) {
    return id === this.providerBooking.id ? this.providerBooking : null;
  }

  async updateProviderBooking(id, tripId, patch) {
    this.providerBooking = { ...this.providerBooking, ...patch };
    return this.providerBooking;
  }

  async getBookingPayment() {
    return { id: "payment-1", status: "succeeded" };
  }

  async updateLocalBooking(id, tripId, patch) {
    this.booking = { ...this.booking, ...patch };
    return this.booking;
  }

  async findAgendaForProviderBooking(tripId, providerBookingId) {
    return (
      this.agenda.find(
        (item) => item.metadata.provider_booking_id === providerBookingId,
      ) ?? null
    );
  }

  async createAgendaItem(input) {
    const row = { id: `agenda-${this.agenda.length + 1}`, ...input };
    this.agenda.push(row);
    return row;
  }

  async updateAgendaItem(id, tripId, patch) {
    const row = this.agenda.find((item) => item.id === id);
    Object.assign(row, patch);
    return row;
  }

  async listContextPoints() {
    return this.points;
  }

  async listAgenda() {
    return [...this.agenda];
  }

  async listJourneyLegs() {
    return this.legs;
  }

  async createJourneyLeg(input) {
    const row = { id: `leg-${this.legs.length + 1}`, status: "planned", ...input };
    this.legs.push(row);
    return row;
  }

  async updateJourneyLeg(id, tripId, patch) {
    const row = this.legs.find((leg) => leg.id === id);
    Object.assign(row, patch);
    return row;
  }

  async findContextPointForPlace(tripId, externalPlaceId) {
    return (
      this.points.find((point) => point.external_place_id === externalPlaceId) ??
      null
    );
  }

  async createContextPoint(input) {
    const row = { id: `point-${this.points.length + 1}`, ...input };
    this.points.push(row);
    return row;
  }

  async updateContextPoint(id, tripId, patch) {
    const row = this.points.find((point) => point.id === id);
    Object.assign(row, patch);
    return row;
  }
}

function hotelClient(overrides = {}) {
  return {
    async bookHotel() {
      return {
        booking_id: "3n358Jsn3",
        state: "confirmed",
        provider_status: "CONFIRMED",
        confirmation_code: "test",
        hotel_id: "lp123",
        hotel_name: "Hotel Fixture",
        checkin: "2026-11-11",
        checkout: "2026-11-12",
        total: { amount: 4.01, currency: "USD" },
        free_cancellation_until: null,
        sandbox: true,
        ...overrides,
      };
    },
  };
}

const hotelPlaces = {
  async hotel() {
    return {
      type: "hotel",
      label: "Hotel Fixture",
      address: "Jl. Fixture 1",
      latitude: -6.145248,
      longitude: 106.815206,
      externalPlaceId: "lp123",
    };
  },
  async airport() {
    return null;
  },
};

function followUpRecorder() {
  const calls = [];
  return {
    calls,
    port: {
      async weatherAt(input) {
        calls.push(input);
      },
    },
  };
}

test("a confirmed hotel becomes an agenda item, a place, and a weather read", async () => {
  const repo = new FakeRepo();
  const followUps = followUpRecorder();
  const service = new LiteApiBookingService(
    repo,
    hotelClient(),
    hotelPlaces,
    followUps.port,
  );

  const result = await service.bookHotel({
    userId: USER,
    tripId: TRIP,
    providerBookingId: ATTEMPT,
    holder: { first_name: "Ayu", last_name: "Fixture", email: "ayu@example.com", phone: "+628123456789" },
    guests: [{ first_name: "Ayu", last_name: "Fixture", email: "ayu@example.com" }],
  });

  assert.equal(result.booking.status, "confirmed");
  assert.equal(repo.agenda.length, 1, "the stay is on the itinerary");
  const item = repo.agenda[0];
  assert.equal(item.type, "hotel_check_in");
  assert.equal(item.source, "external_provider");
  assert.equal(item.status, "confirmed");
  assert.equal(item.metadata.indoor_outdoor, "indoor");
  assert.equal(item.metadata.confirmation_code, "test");
  assert.equal(item.context_point_id, repo.points[0].id, "the stay points at the place");

  assert.equal(repo.points.length, 1, "the trip gained exactly one location");
  const point = repo.points[0];
  assert.equal(point.type, "hotel");
  assert.equal(point.external_place_id, "lp123");
  assert.equal(point.resolution_status, "resolved");
  assert.equal(point.latitude, -6.145248);
  assert.equal(point.source, "booking_import");
  assert.equal(point.timezone, "Asia/Jakarta");

  assert.equal(repo.trip.status, "active", "a paid booking leaves the draft state");
  assert.equal(followUps.calls.length, 1, "the weather read was queued");
  assert.equal(followUps.calls[0].contextPointId, point.id);
});

test("a place the provider cannot describe still leaves the stay on the itinerary", async () => {
  const repo = new FakeRepo();
  const followUps = followUpRecorder();
  const service = new LiteApiBookingService(
    repo,
    hotelClient(),
    {
      async hotel() {
        throw new Error("Provider timeout");
      },
      async airport() {
        return null;
      },
    },
    followUps.port,
  );

  await service.bookHotel({
    userId: USER,
    tripId: TRIP,
    providerBookingId: ATTEMPT,
    holder: { first_name: "Ayu", last_name: "Fixture", email: "ayu@example.com", phone: "+628123456789" },
    guests: [{ first_name: "Ayu", last_name: "Fixture", email: "ayu@example.com" }],
  });

  assert.equal(repo.agenda.length, 1, "the ticket is real, so the stay is kept");
  assert.equal(repo.agenda[0].context_point_id, null);
  assert.equal(repo.agenda[0].metadata.context_error, "Provider timeout");
  assert.equal(repo.points.length, 0);
  assert.equal(followUps.calls.length, 0, "no place means no weather read");
});

test("booking the same hotel twice reuses one location", async () => {
  const repo = new FakeRepo();
  const service = new LiteApiBookingService(repo, hotelClient(), hotelPlaces);

  const book = (providerBookingId) =>
    service.bookHotel({
      userId: USER,
      tripId: TRIP,
      providerBookingId,
      holder: { first_name: "Ayu", last_name: "Fixture", email: "ayu@example.com", phone: "+628123456789" },
      guests: [{ first_name: "Ayu", last_name: "Fixture", email: "ayu@example.com" }],
    });

  await book(ATTEMPT);
  repo.providerBooking = {
    ...repo.providerBooking,
    id: "attempt-2",
    state: "prebooked",
  };
  await book("attempt-2");

  assert.equal(repo.points.length, 1, "one location for one hotel");
  assert.equal(repo.agenda.length, 2, "two stays, two agenda items");
});

test("a flight and a stay plan the airport transfers without asking", async () => {
  const repo = new FakeRepo();
  const places = {
    async hotel() {
      return {
        type: "hotel",
        label: "Hotel Fixture",
        address: null,
        latitude: -6.2,
        longitude: 106.8,
        externalPlaceId: "lp123",
      };
    },
    async airport(iata) {
      const coords = { CGK: [-6.125, 106.655], SUB: [-7.38, 112.787] };
      const found = coords[iata];
      if (!found) return null;
      return {
        type: "airport",
        label: `${iata} airport`,
        address: null,
        latitude: found[0],
        longitude: found[1],
        externalPlaceId: iata,
      };
    },
  };
  const service = new LiteApiBookingService(repo, hotelClient(), places);

  await service.bookHotel({
    userId: USER,
    tripId: TRIP,
    providerBookingId: ATTEMPT,
    holder: { first_name: "Ayu", last_name: "Fixture", email: "ayu@example.com", phone: "+628123456789" },
    guests: [{ first_name: "Ayu", last_name: "Fixture", email: "ayu@example.com" }],
  });

  repo.providerBooking = {
    ...repo.providerBooking,
    id: "flight-attempt",
    booking_type: "flight",
    state: "prebooked",
    checkin: null,
    checkout: null,
    metadata: {
      schedule: {
        segments: [
          {
            origin_code: "CGK",
            origin_name: null,
            destination_code: "SUB",
            destination_name: null,
            departs_at: "2026-11-11T08:00",
            arrives_at: "2026-11-11T09:25",
            carrier_name: "Garuda",
            flight_number: "GA123",
          },
        ],
      },
    },
  };
  const flightClient = {
    async bookFlight() {
      return {
        booking_id: "FL-1",
        booking_reference: "QK7X2",
        state: "confirmed",
        provider_status: "CONFIRMED",
        total: { amount: 120, currency: "USD" },
        ticket_deadline: null,
        passengers: [],
      };
    },
  };
  const flightService = new LiteApiBookingService(repo, flightClient, places);

  await flightService.bookFlight({
    userId: USER,
    tripId: TRIP,
    providerBookingId: "flight-attempt",
  });

  assert.equal(repo.agenda.length, 2, "the stay and the flight are both on the trip");
  assert.equal(repo.legs.length, 2, "there and back are planned");
  const hotelPoint = repo.points.find((point) => point.type === "hotel");
  const arrivalLeg = repo.legs.find((leg) => leg.destination_context_point_id === hotelPoint.id);
  const departureLeg = repo.legs.find((leg) => leg.origin_context_point_id === hotelPoint.id);
  assert.ok(arrivalLeg, "the airport to the hotel leg exists");
  assert.ok(departureLeg, "the hotel back to the airport leg exists");
  assert.equal(
    Date.parse(arrivalLeg.departure_at),
    Date.parse("2026-11-11T09:25:00+07:00") + 60 * 60_000,
    "lands, then an hour to leave the airport",
  );
  assert.equal(
    Date.parse(departureLeg.departure_at),
    Date.parse("2026-11-11T08:00:00+07:00") - 180 * 60_000,
    "leaves three hours before the flight",
  );
});
