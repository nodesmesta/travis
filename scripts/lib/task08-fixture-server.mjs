// FIXTURE SERVER for scripts/validate-task-08.mjs.
//
// It answers HERE and OpenWeather requests with bodies that follow the shapes in
// the official documentation (see packages/integrations/test/mobility-fixtures.mjs).
// The numbers are test data. Anything that came from this server is a fixture
// check of the adapter and engine wiring; it is NEVER reported as a live
// provider check.

import http from "node:http";

const MINUTE = 60_000;

function pairOf(value) {
  const [lat, lng] = String(value).split(",").map(Number);
  return { lat, lng };
}

function section({
  id,
  type,
  departure,
  arrival,
  from,
  to,
  summary,
  transport,
  extra = {},
}) {
  return {
    id,
    type,
    departure: {
      time: new Date(departure).toISOString(),
      place: { type: "place", location: from },
    },
    arrival: {
      time: new Date(arrival).toISOString(),
      place: { type: "place", location: to },
    },
    ...(summary ? { summary } : {}),
    ...(transport ? { transport } : {}),
    ...extra,
  };
}

function roadRoute(params, mode) {
  const departure = Date.parse(params.get("departureTime"));
  const from = pairOf(params.get("origin"));
  const to = pairOf(params.get("destination"));
  const minutes = mode === "pedestrian" ? 70 : 35;
  const base = mode === "pedestrian" ? 70 : 25;
  return {
    routes: [
      {
        id: `fixture-${mode}-route`,
        sections: [
          section({
            id: `fixture-${mode}-section`,
            type: mode === "pedestrian" ? "pedestrian" : "vehicle",
            departure,
            arrival: departure + minutes * MINUTE,
            from,
            to,
            summary: {
              duration: minutes * 60,
              length: mode === "pedestrian" ? 3100 : 4800,
              baseDuration: base * 60,
              typicalDuration: (base + 3) * 60,
            },
            transport: { mode },
          }),
        ],
      },
    ],
  };
}

function intermodalRoute(params) {
  const departure = Date.parse(params.get("departureTime"));
  const from = pairOf(params.get("origin"));
  const to = pairOf(params.get("destination"));
  const stop = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
  return {
    routes: [
      {
        id: "fixture-transit-route",
        sections: [
          section({
            id: "t0",
            type: "pedestrian",
            departure,
            arrival: departure + 8 * MINUTE,
            from,
            to: stop,
          }),
          {
            id: "t1",
            type: "transit",
            departure: {
              time: new Date(departure + 10 * MINUTE).toISOString(),
              place: {
                name: "Fixture Station A",
                type: "station",
                id: "fixture_a",
                location: stop,
              },
            },
            arrival: {
              time: new Date(departure + 35 * MINUTE).toISOString(),
              place: {
                name: "Fixture Station B",
                type: "station",
                id: "fixture_b",
                location: stop,
              },
            },
            transport: {
              mode: "regionalTrain",
              name: "Fixture Line 1",
              category: "RE",
              headsign: "Fixture Terminus",
            },
            agency: { id: "FIXOP", name: "Fixture Rail Operator" },
          },
          section({
            id: "t2",
            type: "pedestrian",
            departure: departure + 35 * MINUTE,
            arrival: departure + 38 * MINUTE,
            from: stop,
            to,
          }),
        ],
      },
    ],
  };
}

function flow() {
  return {
    sourceUpdated: new Date().toISOString(),
    results: [
      {
        location: { description: "Fixture road A", length: 300 },
        currentFlow: {
          speed: 5,
          speedUncapped: 5,
          freeFlow: 12,
          jamFactor: 6,
          confidence: 0.8,
          traversability: "open",
        },
      },
      {
        location: { description: "Fixture road B", length: 100 },
        currentFlow: {
          speed: 10,
          speedUncapped: 10,
          freeFlow: 11,
          jamFactor: 2,
          confidence: 0.8,
          traversability: "open",
        },
      },
    ],
  };
}

function incidents() {
  return {
    sourceUpdated: new Date().toISOString(),
    results: [
      {
        location: { description: "Fixture road A", length: 80 },
        incidentDetails: {
          id: "fixture-incident-1",
          originalId: "fixture-incident-1",
          type: "congestion",
          criticality: "minor",
          roadClosed: false,
          summary: { value: "Queuing traffic.", language: "en-US" },
        },
      },
    ],
  };
}

function browse(params) {
  const center = pairOf(params.get("at"));
  const at = (dLat, dLng) => ({
    lat: center.lat + dLat,
    lng: center.lng + dLng,
  });
  return {
    items: [
      {
        title: "Fixture Warung Satu",
        id: "here:pds:place:fixture-restaurant-1",
        resultType: "place",
        address: { label: "Jl. Fixture 1, Jakarta, Indonesia" },
        position: at(0.0006, 0.0004),
        categories: [
          { id: "100-1000-0000", name: "Restaurant", primary: true },
        ],
        foodTypes: [{ id: "101-000", name: "Indonesian" }],
        contacts: [{ www: [{ value: "https://warung-satu.example/menu" }] }],
        openingHours: [
          { text: ["Mon-Sun: 10:00 - 22:00"], isOpen: true, structured: [] },
        ],
      },
      {
        title: "Fixture Cafe Dua",
        id: "here:pds:place:fixture-restaurant-2",
        resultType: "place",
        address: { label: "Jl. Fixture 2, Jakarta, Indonesia" },
        position: at(0.0012, 0.0006),
        categories: [{ id: "100-1000-0004", name: "Coffee Shop" }],
      },
      {
        title: "Fixture Far Restaurant",
        id: "here:pds:place:fixture-restaurant-far",
        resultType: "place",
        position: at(0.03, 0.03),
        categories: [{ id: "100-1000-0000", name: "Restaurant" }],
      },
    ],
  };
}

/** OpenWeather current weather (`/data/2.5/weather`) as the free plan answers it. */
function currentWeather(params) {
  const now = Math.floor(Date.now() / 1000);
  return {
    coord: { lat: Number(params.get("lat")), lon: Number(params.get("lon")) },
    weather: [
      { id: 801, main: "Clouds", description: "few clouds", icon: "02d" },
    ],
    main: { temp: 30, humidity: 70 },
    visibility: 9000,
    wind: { speed: 3 },
    clouds: { all: 20 },
    dt: now,
    timezone: 25200,
    cod: 200,
  };
}

/** OpenWeather 5 day / 3 hour forecast (`/data/2.5/forecast`): 40 points. */
function forecast(params) {
  const now = Math.floor(Date.now() / 1000);
  const slot = now - (now % 10800);
  return {
    cod: "200",
    message: 0,
    cnt: 40,
    list: Array.from({ length: 40 }, (_, index) => ({
      dt: slot + (index + 1) * 10800,
      main: { temp: 29 },
      weather: [
        { id: 801, main: "Clouds", description: "few clouds", icon: "02d" },
      ],
      clouds: { all: 20 },
      wind: { speed: 3 },
      visibility: 10000,
      pop: 0.2,
    })),
    city: {
      coord: { lat: Number(params.get("lat")), lon: Number(params.get("lon")) },
      timezone: 25200,
    },
  };
}

/**
 * Starts the server on a free port. `fail(service)` makes the next request for
 * that service answer HTTP 500, so a validator can check provider-failure handling.
 */
export async function startFixtureServer() {
  const counters = {
    router: 0,
    intermodal: 0,
    flow: 0,
    incidents: 0,
    browse: 0,
    weather: 0,
    weather_current: 0,
  };
  const failures = new Set();
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    let service = null;
    let body = null;
    if (url.pathname === "/here/router/v8/routes") {
      service = "router";
      body = () =>
        roadRoute(url.searchParams, url.searchParams.get("transportMode"));
    } else if (url.pathname === "/here/intermodal/v8/routes") {
      service = "intermodal";
      body = () => intermodalRoute(url.searchParams);
    } else if (url.pathname === "/here/traffic/v7/flow") {
      service = "flow";
      body = flow;
    } else if (url.pathname === "/here/traffic/v7/incidents") {
      service = "incidents";
      body = incidents;
    } else if (url.pathname === "/here/browse/v1/browse") {
      service = "browse";
      body = () => browse(url.searchParams);
    } else if (url.pathname === "/owm/data/2.5/weather") {
      service = "weather_current";
      body = () => currentWeather(url.searchParams);
    } else if (url.pathname === "/owm/data/2.5/forecast") {
      // One snapshot is one current-weather request plus one forecast request.
      // The forecast request is the one counted as "a weather provider call".
      service = "weather";
      body = () => forecast(url.searchParams);
    }
    if (!service || !body) {
      send(404, { error: "unknown fixture route" });
      return;
    }
    counters[service] += 1;
    requests.push({ service, query: Object.fromEntries(url.searchParams) });
    if (failures.has(service)) {
      failures.delete(service);
      send(500, { error: "fixture failure" });
      return;
    }
    send(200, body());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    counters,
    requests,
    fail(service) {
      failures.add(service);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
