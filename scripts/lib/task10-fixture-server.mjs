// FIXTURE SERVER for scripts/validate-task-10.mjs.
//
// It answers the HERE Traffic API v7 and OpenWeather current-weather and 5 day / 3 hour forecast requests that the
// worker makes, with bodies that follow the shapes in the official documentation. The
// numbers are test data that the validator sets for each scenario. Anything that came
// from this server is a FIXTURE check of the worker wiring. It is NEVER reported as a
// live provider check.

import http from "node:http";

const HOUR = 3600;

function flowBody(level) {
  // Length-weighted average jam factor: low 1, medium 5, high 8.
  const jam = { low: 1, medium: 5, high: 8 }[level];
  return {
    sourceUpdated: new Date().toISOString(),
    results: [
      {
        location: { description: "Fixture road A", length: 400 },
        currentFlow: {
          speed: 6,
          speedUncapped: 6,
          freeFlow: 12,
          jamFactor: jam,
          confidence: 0.8,
          traversability: "open",
        },
      },
    ],
  };
}

function incidentsBody(level) {
  if (level === "low")
    return { sourceUpdated: new Date().toISOString(), results: [] };
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

function weatherConditions(mode) {
  return mode === "rain"
    ? [
        {
          id: 502,
          main: "Rain",
          description: "heavy intensity rain",
          icon: "10d",
        },
      ]
    : [{ id: 800, main: "Clear", description: "clear sky", icon: "01d" }];
}

function currentBody(params, mode) {
  const now = Math.floor(Date.now() / 1000);
  return {
    coord: { lat: Number(params.get("lat")), lon: Number(params.get("lon")) },
    weather: weatherConditions(mode),
    main: { temp: 29 },
    visibility: 10000,
    wind: { speed: 3 },
    ...(mode === "rain" ? { rain: { "1h": 5 } } : {}),
    dt: now,
    timezone: 25200,
    cod: 200,
  };
}

/** 40 points, three hours apart, starting with the slot that contains now. */
function forecastBody(params, mode) {
  const now = Math.floor(Date.now() / 1000);
  const slot = now - (now % (3 * HOUR));
  const rain = mode === "rain";
  return {
    cod: "200",
    message: 0,
    cnt: 40,
    list: Array.from({ length: 40 }, (_, index) => ({
      dt: slot + index * 3 * HOUR,
      main: { temp: 29 },
      weather: weatherConditions(mode),
      wind: { speed: 3 },
      visibility: 10000,
      pop: rain ? 0.9 : 0.05,
      ...(rain ? { rain: { "3h": 15 } } : {}),
    })),
    city: {
      coord: { lat: Number(params.get("lat")), lon: Number(params.get("lon")) },
      timezone: 25200,
    },
  };
}

/**
 * Starts the server on a free port.
 *   setTraffic("low" | "medium" | "high"), setWeather("clear" | "rain")
 *   failAlways(service) / recover(service): answer HTTP 500 until recovered
 *   hold(service, ms): delay the next answers of a service, to keep a job running
 */
export async function startTask10Fixture() {
  const state = { traffic: "medium", weather: "clear" };
  const counters = { flow: 0, incidents: 0, weather: 0, weather_current: 0 };
  const failing = new Set();
  const holds = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    let service = null;
    let body = null;
    if (url.pathname === "/here/traffic/v7/flow") {
      service = "flow";
      body = () => flowBody(state.traffic);
    } else if (url.pathname === "/here/traffic/v7/incidents") {
      service = "incidents";
      body = () => incidentsBody(state.traffic);
    } else if (url.pathname === "/owm/data/2.5/weather") {
      service = "weather_current";
      body = () => currentBody(url.searchParams, state.weather);
    } else if (url.pathname === "/owm/data/2.5/forecast") {
      // The forecast request is the one counted and held as a weather call.
      service = "weather";
      body = () => forecastBody(url.searchParams, state.weather);
    }
    if (!service || !body) {
      send(404, { error: "unknown fixture route" });
      return;
    }
    counters[service] += 1;
    const answer = () => {
      if (failing.has(service)) send(500, { error: "fixture failure" });
      else send(200, body());
    };
    const delay = holds.get(service) ?? 0;
    if (delay > 0) setTimeout(answer, delay);
    else answer();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    counters,
    setTraffic(level) {
      state.traffic = level;
    },
    setWeather(mode) {
      state.weather = mode;
    },
    failAlways(service) {
      failing.add(service);
    },
    recover(service) {
      failing.delete(service);
    },
    hold(service, ms) {
      if (ms > 0) holds.set(service, ms);
      else holds.delete(service);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
