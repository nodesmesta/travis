import assert from "node:assert/strict";
import test from "node:test";
import {
  ActivityDiscoveryPipeline,
  ExternalDataError,
  buildActivityDiscoveryQuery,
  classifyIndoorOutdoor,
  evidenceStatesDuration,
  extractJsonLdActivities,
  localityTerms,
  mentionsLocality,
  normalizeHereRestaurants,
  parseActivityClaims,
  restaurantFingerprint,
  validateActivityClaim,
  validateJsonLdActivity,
  weatherSensitivityFor,
} from "../dist/index.js";
import {
  FIXTURE_ACTIVITY_FAR_JSON_LD_PAGE,
  FIXTURE_ACTIVITY_JSON_LD_PAGE,
  FIXTURE_ACTIVITY_TEXT_PAGE,
  FIXTURE_HERE_BROWSE,
} from "./mobility-fixtures.mjs";
import { has } from "./helpers.mjs";

const restaurantQuery = {
  contextPointId: "context-1",
  latitude: -6.2147,
  longitude: 106.8097,
  radiusMeters: 1000,
  limit: 20,
};

test("restaurants: only places inside the radius, in a restaurant category, with an id, are kept", () => {
  const result = normalizeHereRestaurants(FIXTURE_HERE_BROWSE, restaurantQuery);
  assert.deepEqual(
    result.items.map((item) => item.provider_place_id),
    [
      "here:pds:place:fixture-restaurant-1",
      "here:pds:place:fixture-restaurant-2",
    ],
  );
  const reasons = Object.fromEntries(
    result.rejected.map((entry) => [entry.reason, entry.count]),
  );
  assert.equal(reasons["item is outside the requested radius"], 1);
  assert.equal(reasons["item is not in a restaurant category"], 1);
  assert.equal(reasons["item has no provider id, so it has no source"], 1);
});

test("restaurants: distance is computed from coordinates and sorted nearest first", () => {
  const [first, second] = normalizeHereRestaurants(
    FIXTURE_HERE_BROWSE,
    restaurantQuery,
  ).items;
  assert.ok(first.distance_meters < second.distance_meters);
  assert.ok(first.distance_meters > 0 && first.distance_meters < 1000);
  assert.equal(first.name, "Fixture Warung Satu");
  assert.equal(first.address, "Jl. Fixture 1, Jakarta, Indonesia");
  assert.deepEqual(first.cuisines, ["Indonesian"]);
  assert.equal(first.official_url, "https://warung-satu.example/menu");
});

test("restaurants: opening hours appear only when the provider returned them", () => {
  const [withHours, withoutHours] = normalizeHereRestaurants(
    FIXTURE_HERE_BROWSE,
    restaurantQuery,
  ).items;
  assert.deepEqual(withHours.opening_hours_text, ["Mon-Sun: 10:00 - 22:00"]);
  assert.equal(withoutHours.opening_hours_text, null);
  assert.equal(
    "is_open" in withHours,
    false,
    "isOpen describes the request moment and is not exposed",
  );
});

test("restaurants: a malformed answer is rejected and an empty answer is empty", () => {
  assert.throws(
    () => normalizeHereRestaurants({}, restaurantQuery),
    ExternalDataError,
  );
  const empty = normalizeHereRestaurants({ items: [] }, restaurantQuery);
  assert.deepEqual(empty.items, []);
});

test("restaurant fingerprints depend on the inputs that change the result", () => {
  const same = restaurantFingerprint(restaurantQuery);
  assert.equal(same, restaurantFingerprint({ ...restaurantQuery }));
  assert.notEqual(
    same,
    restaurantFingerprint({ ...restaurantQuery, radiusMeters: 2000 }),
  );
  assert.notEqual(
    same,
    restaurantFingerprint({ ...restaurantQuery, contextPointId: "context-2" }),
  );
});

// ---------------------------------------------------------------------------
// Activities

const activityInput = {
  requestId: "request-1",
  executionId: "execution-1",
  tripId: "trip-1",
  contextPointId: "context-1",
  contextLabel: "Jakarta Convention Center",
  contextAddress: "Jl. Gatot Subroto, Jakarta",
  destination: "Jakarta, Indonesia",
  contextLatitude: -6.2147,
  contextLongitude: 106.8097,
};

const ctx = {
  contextLabel: "Jakarta Convention Center",
  contextLatitude: -6.2147,
  contextLongitude: 106.8097,
  localityTerms: ["gatot", "subroto", "jakarta", "indonesia"],
  maxDistanceMeters: 25000,
};

test("activity query is built from structured context, not a user sentence", () => {
  const query = buildActivityDiscoveryQuery(activityInput);
  has(query.searchUrl, "https://www.google.com/search?q=");
  has(query.searchUrl, "Jakarta%20Convention%20Center");
  has(query.searchUrl, "brd_json=1");
  assert.equal(
    query.fingerprint,
    buildActivityDiscoveryQuery({ ...activityInput }).fingerprint,
  );
  assert.notEqual(
    query.fingerprint,
    buildActivityDiscoveryQuery({
      ...activityInput,
      contextPointId: "context-2",
    }).fingerprint,
  );
  assert.ok(query.localityTerms.includes("jakarta"));
  assert.ok(!query.localityTerms.includes("hotel"));
  assert.throws(
    () => buildActivityDiscoveryQuery({ ...activityInput, contextLabel: " " }),
    ExternalDataError,
  );
});

test("locality terms drop generic words and use the label only as a last resort", () => {
  assert.deepEqual(
    localityTerms({
      label: "Hotel Indonesia Kempinski",
      address: null,
      destination: null,
    }),
    ["indonesia", "kempinski"],
  );
  assert.deepEqual(
    localityTerms({
      label: "Hotel X",
      address: "Jl. Thamrin, Jakarta",
      destination: null,
    }),
    ["thamrin", "jakarta"],
  );
  assert.equal(mentionsLocality("Walk in Jakarta Old Town", ["jakarta"]), true);
  assert.equal(mentionsLocality("Walk in Jakartaville", ["jakarta"]), false);
  assert.equal(mentionsLocality("anything", []), false);
});

test("JSON-LD attraction inside the area is kept with source-given facts only", () => {
  const { activities, malformedBlocks } = extractJsonLdActivities(
    FIXTURE_ACTIVITY_JSON_LD_PAGE,
  );
  assert.equal(malformedBlocks, 0);
  assert.equal(activities.length, 1);
  const result = validateJsonLdActivity(activities[0], ctx);
  assert.equal(result.ok, true);
  assert.equal(result.activity.name, "Fixture National Museum");
  assert.equal(result.activity.activityType, "museum");
  assert.equal(
    result.activity.indoorOutdoor,
    "indoor",
    "museum is indoor under the documented type rule",
  );
  assert.deepEqual(result.activity.openingHoursText, ["Tu-Su 09:00-16:00"]);
  assert.equal(result.activity.recommendedDurationMinutes, null);
  assert.equal(result.activity.bookingRequired, null);
  assert.equal(result.activity.officialUrl, "https://fixture-museum.example/");
});

test("JSON-LD attraction with distant coordinates or no tie to the place is rejected", () => {
  const far = extractJsonLdActivities(FIXTURE_ACTIVITY_FAR_JSON_LD_PAGE)
    .activities[0];
  const farResult = validateJsonLdActivity(far, ctx);
  assert.equal(farResult.ok, false);
  has(farResult.reason, "too far");
  const elsewhere = {
    ...extractJsonLdActivities(FIXTURE_ACTIVITY_JSON_LD_PAGE).activities[0],
    addressText: "Bandung",
    name: "Museum",
  };
  const elsewhereResult = validateJsonLdActivity(elsewhere, ctx);
  assert.equal(elsewhereResult.ok, false);
  has(elsewhereResult.reason, "not tied to the requested place");
});

test("malformed JSON-LD is reported and not guessed", () => {
  const html = `<script type="application/ld+json">{ not json</script><p>x</p>`;
  assert.deepEqual(extractJsonLdActivities(html), {
    activities: [],
    malformedBlocks: 1,
  });
});

const walkClaim = {
  name: "Fixture Old Town Walk",
  locationName: "Jakarta",
  activityType: "walk",
  indoorOutdoor: "outdoor",
  durationMinutes: 120,
  bookingRequired: "yes",
  openingHoursText: "",
  evidence:
    "Fixture Old Town Walk is an outdoor guided walk in Jakarta. The walk takes 2 hours. Booking is required for groups.",
};

test("activity claim: every kept attribute is found in the page excerpt", () => {
  const result = validateActivityClaim(
    walkClaim,
    FIXTURE_ACTIVITY_TEXT_PAGE,
    ctx,
  );
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.activity.indoorOutdoor, "outdoor");
  assert.equal(result.activity.recommendedDurationMinutes, 120);
  assert.equal(result.activity.bookingRequired, true);
  assert.equal(result.activity.openingHoursText, null);
  assert.equal(result.activity.activityType, "walk");
});

test("activity claim: attributes without evidence become unknown instead of the model's value", () => {
  const claim = {
    ...walkClaim,
    indoorOutdoor: "indoor",
    durationMinutes: 45,
    activityType: "helicopter",
    evidence: "Fixture Old Town Walk is a guided walk in Jakarta.",
  };
  const page = `${FIXTURE_ACTIVITY_TEXT_PAGE}\nFixture Old Town Walk is a guided walk in Jakarta.`;
  const result = validateActivityClaim(claim, page, ctx);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.activity.indoorOutdoor, "unknown");
  assert.equal(result.activity.recommendedDurationMinutes, null);
  assert.equal(result.activity.bookingRequired, null);
  assert.equal(result.activity.activityType, null);
});

test("activity claim: opening hours are kept only when the excerpt is on the page", () => {
  const aquarium = {
    name: "Fixture Aquarium Visit",
    locationName: "Jakarta",
    activityType: "",
    indoorOutdoor: "indoor",
    durationMinutes: 0,
    bookingRequired: "unknown",
    openingHoursText: "Daily 09:00-17:00",
    evidence:
      "Fixture Aquarium Visit in Jakarta is an indoor experience. Opening hours: Daily 09:00-17:00.",
  };
  const kept = validateActivityClaim(aquarium, FIXTURE_ACTIVITY_TEXT_PAGE, ctx);
  assert.equal(kept.ok, true, kept.reason);
  assert.deepEqual(kept.activity.openingHoursText, ["Daily 09:00-17:00"]);
  assert.equal(kept.activity.indoorOutdoor, "indoor");
  const invented = validateActivityClaim(
    { ...aquarium, openingHoursText: "Daily 06:00-23:00" },
    FIXTURE_ACTIVITY_TEXT_PAGE,
    ctx,
  );
  assert.equal(invented.ok, true);
  assert.equal(invented.activity.openingHoursText, null);
});

test("activity claim: invented evidence, wrong place, or other text is rejected", () => {
  const invented = validateActivityClaim(
    {
      ...walkClaim,
      evidence: "Fixture Old Town Walk is free and open all night in Jakarta.",
    },
    FIXTURE_ACTIVITY_TEXT_PAGE,
    ctx,
  );
  assert.equal(invented.ok, false);
  has(invented.reason, "evidence excerpt was not found");
  const unknownName = validateActivityClaim(
    { ...walkClaim, name: "Made Up Tour" },
    FIXTURE_ACTIVITY_TEXT_PAGE,
    ctx,
  );
  assert.equal(unknownName.ok, false);
  const elsewhere = validateActivityClaim(
    walkClaim,
    FIXTURE_ACTIVITY_TEXT_PAGE,
    { ...ctx, localityTerms: ["bandung"] },
  );
  assert.equal(elsewhere.ok, false);
  has(elsewhere.reason, "not tied to the requested place");
  const wrongLocation = validateActivityClaim(
    { ...walkClaim, locationName: "Surabaya" },
    FIXTURE_ACTIVITY_TEXT_PAGE,
    ctx,
  );
  assert.equal(wrongLocation.ok, false);
  has(wrongLocation.reason, "location was not found");
});

test("no-booking wording gives an explicit false and the weather rule is documented", () => {
  const page =
    "Fixture Free Garden in Jakarta is an outdoor garden. No booking needed, walk-in only.";
  const result = validateActivityClaim(
    {
      ...walkClaim,
      name: "Fixture Free Garden",
      evidence: page,
      durationMinutes: 0,
      bookingRequired: "yes",
    },
    page,
    ctx,
  );
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.activity.bookingRequired, false);
  assert.equal(weatherSensitivityFor("outdoor"), "high");
  assert.equal(weatherSensitivityFor("indoor"), "low");
  assert.equal(weatherSensitivityFor("both"), "medium");
  assert.equal(weatherSensitivityFor("unknown"), "unknown");
  assert.equal(classifyIndoorOutdoor("indoor and outdoor areas"), "both");
  assert.equal(classifyIndoorOutdoor("a place"), "unknown");
});

test("duration evidence accepts hours, minutes, decimals, and hour plus minute", () => {
  assert.equal(evidenceStatesDuration("The tour takes 2 hours.", 120), true);
  assert.equal(evidenceStatesDuration("Allow 90 minutes", 90), true);
  assert.equal(evidenceStatesDuration("about 1.5 hours", 90), true);
  assert.equal(evidenceStatesDuration("1 hour 30 minutes in total", 90), true);
  assert.equal(evidenceStatesDuration("a 3-hour cruise", 180), true);
  assert.equal(evidenceStatesDuration("2 jam", 120), true);
  assert.equal(evidenceStatesDuration("The tour takes 2 hours.", 90), false);
  assert.equal(
    evidenceStatesDuration("opens at 10 and closes at 18", 10),
    false,
  );
  assert.equal(evidenceStatesDuration("2 hours", 0), false);
});

test("model answers that are not an activities array are rejected, malformed items are counted", () => {
  assert.throws(() => parseActivityClaims({}), ExternalDataError);
  const parsed = parseActivityClaims({
    activities: [
      {
        ...walkClaim,
        name: "A",
        location_name: "L",
        activity_type: "",
        indoor_outdoor: "unknown",
        duration_minutes: 0,
        booking_required: "unknown",
        opening_hours_text: "",
        evidence: "A in L",
      },
      { name: 1 },
    ],
  });
  assert.equal(parsed.claims.length, 1);
  assert.equal(parsed.malformed, 1);
});

// ---------------------------------------------------------------------------
// Pipeline

const NOW = "2026-11-07T10:00:00.000Z";
const options = { maxPages: 4, pageMaxChars: 15000, pageConcurrency: 2 };

function search(...links) {
  return JSON.stringify({
    organic: links.map((link, index) => ({
      title: `Result ${index}`,
      link,
      description: "d",
    })),
  });
}

function fakeClient(serp, pages) {
  const calls = [];
  return {
    calls,
    serpZone: "serp",
    unlockerZone: "unlocker",
    async fetchText(zone, url) {
      calls.push({ zone, url });
      if (zone === "serp") {
        if (serp instanceof Error) throw serp;
        return serp;
      }
      const page = pages[url];
      if (page instanceof Error) throw page;
      if (page === undefined) throw new Error(`unexpected page ${url}`);
      return page;
    },
  };
}

const claimsFor = (claims) => ({
  extract: async () => ({ claims, malformed: 0 }),
});

test("pipeline: JSON-LD and model-read pages become sourced items with an expiry", async () => {
  const query = buildActivityDiscoveryQuery(activityInput);
  const client = fakeClient(
    search("https://museum.example/a", "https://guide.example/b"),
    {
      "https://museum.example/a": FIXTURE_ACTIVITY_JSON_LD_PAGE,
      "https://guide.example/b": FIXTURE_ACTIVITY_TEXT_PAGE,
    },
  );
  const result = await new ActivityDiscoveryPipeline(
    client,
    claimsFor([walkClaim]),
    options,
  ).run(query, NOW, 24);
  assert.equal(result.status, "ok");
  assert.equal(result.freshness, "fresh");
  assert.equal(result.expiresAt, "2026-11-08T10:00:00.000Z");
  assert.deepEqual(result.items.map((item) => item.name).sort(), [
    "Fixture National Museum",
    "Fixture Old Town Walk",
  ]);
  for (const item of result.items) {
    assert.ok(item.sourceKeys.length >= 1);
    assert.ok(
      result.sources.some((source) => source.sourceKey === item.sourceKeys[0]),
    );
  }
  const walk = result.items.find(
    (item) => item.name === "Fixture Old Town Walk",
  );
  assert.equal(walk.weatherSensitivity, "high");
  assert.equal(walk.recommendedDurationMinutes, 120);
  const museum = result.items.find(
    (item) => item.name === "Fixture National Museum",
  );
  assert.equal(museum.weatherSensitivity, "low");
  assert.equal(museum.officialUrl, "https://fixture-museum.example/");
  assert.equal(walk.officialUrl, null);
  assert.ok(
    result.limitations.some((text) =>
      text.includes("Walking distance is not verified"),
    ),
  );
});

test("pipeline: zero valid activities is an empty result, never a made-up one", async () => {
  const query = buildActivityDiscoveryQuery(activityInput);
  const client = fakeClient(search("https://guide.example/b"), {
    "https://guide.example/b": FIXTURE_ACTIVITY_TEXT_PAGE,
  });
  const result = await new ActivityDiscoveryPipeline(
    client,
    claimsFor([]),
    options,
  ).run(query, NOW, 24);
  assert.equal(result.status, "empty");
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.sources, []);
});

test("pipeline: a search failure is thrown with its stage, with no retry", async () => {
  const query = buildActivityDiscoveryQuery(activityInput);
  const failure = new ExternalDataError(
    "EXTERNAL_PROVIDER_TIMEOUT",
    "bright_data",
    "timed out",
    504,
    true,
  );
  const client = fakeClient(failure, {});
  const pipeline = new ActivityDiscoveryPipeline(
    client,
    claimsFor([]),
    options,
  );
  await assert.rejects(pipeline.run(query, NOW, 24), (error) => {
    assert.equal(error.code, "EXTERNAL_PROVIDER_TIMEOUT");
    assert.equal(error.details.stage, "search");
    return true;
  });
  assert.equal(client.calls.length, 1);
});

test("pipeline: when every page fails the first error is thrown, partial failures are reported", async () => {
  const query = buildActivityDiscoveryQuery(activityInput);
  const failure = new ExternalDataError(
    "EXTERNAL_PROVIDER_ERROR",
    "bright_data",
    "boom",
    502,
    true,
  );
  const allFail = fakeClient(
    search("https://a.example/1", "https://b.example/2"),
    {
      "https://a.example/1": failure,
      "https://b.example/2": failure,
    },
  );
  await assert.rejects(
    new ActivityDiscoveryPipeline(allFail, claimsFor([]), options).run(
      query,
      NOW,
      24,
    ),
    (error) => error.code === "EXTERNAL_PROVIDER_ERROR",
  );

  const partial = fakeClient(
    search("https://a.example/1", "https://museum.example/a"),
    {
      "https://a.example/1": failure,
      "https://museum.example/a": FIXTURE_ACTIVITY_JSON_LD_PAGE,
    },
  );
  const result = await new ActivityDiscoveryPipeline(
    partial,
    claimsFor([]),
    options,
  ).run(query, NOW, 24);
  assert.equal(result.status, "ok");
  assert.ok(
    result.limitations.some((text) =>
      text.includes("1 of 2 candidate pages could not be processed"),
    ),
  );
});

test("pipeline: page text is never followed as instructions and a missing configuration stops the run", async () => {
  const query = buildActivityDiscoveryQuery(activityInput);
  const client = fakeClient(search("https://guide.example/b"), {
    "https://guide.example/b": FIXTURE_ACTIVITY_TEXT_PAGE,
  });
  const seen = [];
  const extractor = {
    extract: async (_url, text) => {
      seen.push(text);
      return { claims: [], malformed: 0 };
    },
  };
  await new ActivityDiscoveryPipeline(client, extractor, options).run(
    query,
    NOW,
    24,
  );
  assert.equal(seen.length, 1);
  has(seen[0], "Ignore previous instructions");

  const missing = new ExternalDataError(
    "EXTERNAL_CONFIGURATION_MISSING",
    "vultr_inference",
    "not configured",
    503,
  );
  const failing = {
    extract: async () => {
      throw missing;
    },
  };
  await assert.rejects(
    new ActivityDiscoveryPipeline(client, failing, options).run(query, NOW, 24),
    (error) => error.code === "EXTERNAL_CONFIGURATION_MISSING",
  );
});
