import assert from "node:assert/strict";
import test from "node:test";
import {
  ExternalDataError,
  OPENWEATHER_FORECAST_STEP_MINUTES,
  OPENWEATHER_SNAPSHOT_PROVIDER,
  OpenWeatherClient,
  isEmptyWeather,
  normalizeFreeTier,
} from "../dist/index.js";
import { has, lacks } from "./helpers.mjs";

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExternalDataError, String(error));
    return error;
  }
  assert.fail("expected the call to be rejected");
}

const point = { latitude: -6.2147, longitude: 106.8097 };
const TZ = "Asia/Jakarta";

// Shapes measured from the live API on 2026-11-08 (Jakarta Convention Center).
const CURRENT = {
  coord: { lon: 106.8097, lat: -6.2147 },
  weather: [{ id: 500, main: "Rain", description: "light rain", icon: "10n" }],
  main: { temp: 27.9, feels_like: 31.28, humidity: 76, pressure: 1010 },
  visibility: 10000,
  wind: { speed: 1.1, deg: 110, gust: 1.49 },
  rain: { "1h": 0.12 },
  clouds: { all: 63 },
  dt: 1794084564,
  timezone: 25200,
  cod: 200,
};

const FORECAST = {
  cod: "200",
  cnt: 3,
  list: [
    {
      dt: 1794085200,
      main: { temp: 27.9 },
      weather: [{ id: 500, main: "Rain", description: "light rain" }],
      wind: { speed: 1.1, gust: 1.49 },
      visibility: 10000,
      pop: 0.35,
      rain: { "3h": 0.33 },
    },
    {
      dt: 1794095999 + 1,
      main: { temp: 27.2 },
      weather: [{ id: 800, main: "Clear", description: "clear sky" }],
      wind: { speed: 0.9 },
      visibility: 10000,
      pop: 0,
    },
    {
      dt: 1794106800,
      main: { temp: 26.4 },
      weather: [{ id: 501, main: "Rain", description: "moderate rain" }],
      wind: { speed: 2.2 },
      visibility: 7000,
      pop: 0.9,
    },
  ],
  city: { coord: { lat: -6.2147, lon: 106.8097 }, timezone: 25200 },
};

const normalize = (overrides = {}) =>
  normalizeFreeTier({
    current: CURRENT,
    forecast: FORECAST,
    timezone: TZ,
    ...overrides,
  });

function replyFor(urlText) {
  const url = new URL(urlText);
  const body = url.pathname.endsWith("/weather") ? CURRENT : FORECAST;
  return new Response(JSON.stringify(body), { status: 200 });
}

test("OpenWeather without a key fails with a structured error and no request", async () => {
  let called = false;
  const client = new OpenWeatherClient({
    apiKey: undefined,
    fetchImpl: async () => {
      called = true;
      return new Response("{}");
    },
  });
  for (const run of [
    () => client.currentWeather(point),
    () => client.forecast(point),
    () => client.snapshot(point),
  ]) {
    const error = await rejection(Promise.resolve().then(run));
    assert.equal(error.code, "EXTERNAL_CONFIGURATION_MISSING");
  }
  assert.equal(called, false);
});

test("a snapshot reads current weather and the forecast with metric units and hides the key", async () => {
  const seen = [];
  const client = new OpenWeatherClient({
    apiKey: "secret-owm-key",
    fetchImpl: async (url) => {
      seen.push(new URL(url));
      return replyFor(url);
    },
  });
  const result = await client.snapshot(point);
  assert.deepEqual(seen.map((url) => url.pathname).sort(), [
    "/data/2.5/forecast",
    "/data/2.5/weather",
  ]);
  for (const url of seen) {
    assert.equal(url.origin, "https://api.openweathermap.org");
    assert.equal(url.searchParams.get("lat"), "-6.2147");
    assert.equal(url.searchParams.get("lon"), "106.8097");
    assert.equal(url.searchParams.get("units"), "metric");
    assert.equal(url.searchParams.get("appid"), "secret-owm-key");
  }
  for (const part of [result.current, result.forecast]) {
    lacks(part.auditUrl, "secret-owm-key");
    has(part.auditUrl, "units=metric");
  }
});

test("a snapshot fails as a whole when one of its two requests fails", async () => {
  const client = new OpenWeatherClient({
    apiKey: "k",
    fetchImpl: async (url) =>
      new URL(url).pathname.endsWith("/forecast")
        ? new Response("{}", { status: 500 })
        : replyFor(url),
  });
  assert.equal(
    (await rejection(client.snapshot(point))).code,
    "EXTERNAL_PROVIDER_ERROR",
  );
});

test("an out-of-range coordinate is rejected before any request", async () => {
  let called = false;
  const client = new OpenWeatherClient({
    apiKey: "k",
    fetchImpl: async () => {
      called = true;
      return new Response("{}");
    },
  });
  const error = await rejection(
    Promise.resolve().then(() =>
      client.forecast({ latitude: 95, longitude: 0 }),
    ),
  );
  assert.equal(error.code, "EXTERNAL_QUERY_INVALID");
  assert.equal(called, false);
});

test("OpenWeather failures map to structured errors", async () => {
  const run = (status, body = "{}") =>
    new OpenWeatherClient({
      apiKey: "k",
      fetchImpl: async () => new Response(body, { status }),
    }).forecast(point);
  assert.equal((await rejection(run(401))).code, "EXTERNAL_PROVIDER_REJECTED");
  assert.equal(
    (await rejection(run(429))).code,
    "EXTERNAL_PROVIDER_RATE_LIMITED",
  );
  assert.equal((await rejection(run(500))).code, "EXTERNAL_PROVIDER_ERROR");
  assert.equal(
    (await rejection(run(200, "<html>"))).code,
    "EXTERNAL_RESPONSE_INVALID",
  );
});

test("normalizer builds current and three-hour forecast points in the place's timezone", () => {
  const weather = normalize();
  assert.equal(weather.timezone, TZ);
  assert.equal(weather.latitude, -6.2147);
  assert.equal(weather.observed_at, "2026-11-07T20:49:24.000Z");
  assert.equal(weather.daily.length, 0);
  assert.deepEqual(weather.alerts, []);
  assert.equal(
    weather.forecast_interval_minutes,
    OPENWEATHER_FORECAST_STEP_MINUTES,
  );
  assert.equal(OPENWEATHER_FORECAST_STEP_MINUTES, 180);
  assert.equal(OPENWEATHER_SNAPSHOT_PROVIDER, "openweather_free_2_5");

  assert.equal(weather.current.granularity, "current");
  assert.equal(weather.current.temperature_c, 27.9);
  assert.equal(weather.current.precipitation_probability, null);
  assert.equal(weather.current.precipitation_mm, 0.12);
  assert.equal(weather.current.condition_id, 500);

  assert.equal(weather.hourly.length, 3);
  for (const entry of weather.hourly) {
    assert.equal(entry.granularity, "three_hourly");
    assert.equal(entry.interval_minutes, 180);
  }
  assert.equal(weather.hourly[0].precipitation_probability, 0.35);
  assert.equal(weather.hourly[0].wind_speed_ms, 1.1);
  assert.equal(weather.hourly[2].visibility_m, 7000);
  assert.equal(weather.forecast_ends_at, weather.hourly[2].at);
  assert.equal(isEmptyWeather(weather), false);
});

test("forecast rain is converted from millimeters per 3 hours to millimeters per hour", () => {
  assert.equal(normalize().hourly[0].precipitation_mm, 0.11);
});

test("dry conditions without a rain object are 0 mm; rain without an amount stays unknown", () => {
  const weather = normalize();
  assert.equal(weather.hourly[1].condition_id, 800);
  assert.equal(weather.hourly[1].precipitation_mm, 0);
  assert.equal(weather.hourly[2].condition_id, 501);
  assert.equal(weather.hourly[2].precipitation_mm, null);
});

test("an empty forecast list keeps the current point and reports no forecast window", () => {
  const weather = normalize({ forecast: { cod: "200", cnt: 0, list: [] } });
  assert.deepEqual(weather.hourly, []);
  assert.equal(weather.forecast_interval_minutes, null);
  assert.equal(weather.forecast_ends_at, null);
  assert.equal(isEmptyWeather(weather), false);
});

test("malformed answers are errors, not guesses", () => {
  const invalid = (overrides, text) =>
    assert.throws(
      () => normalize(overrides),
      (error) =>
        error instanceof ExternalDataError &&
        error.code === "EXTERNAL_RESPONSE_INVALID" &&
        (!text || error.message.includes(text)),
    );
  invalid({ current: null });
  invalid({ forecast: [] });
  invalid({ timezone: "Mars/Olympus" }, "IANA");
  invalid({ current: { ...CURRENT, coord: undefined } }, "location");
  invalid({ forecast: { cod: "200" } }, "entries");

  const badPop = structuredClone(FORECAST);
  badPop.list[0].pop = 1.5;
  invalid({ forecast: badPop }, "pop");

  const badTemp = structuredClone(FORECAST);
  badTemp.list[0].main.temp = 200;
  invalid({ forecast: badTemp }, "main.temp");

  const noDt = structuredClone(FORECAST);
  delete noDt.list[1].dt;
  invalid({ forecast: noDt }, "dt");

  const noMain = structuredClone(FORECAST);
  delete noMain.list[0].main;
  invalid({ forecast: noMain }, "measurements");

  const badRain = structuredClone(FORECAST);
  badRain.list[0].rain = { "3h": -1 };
  invalid({ forecast: badRain }, "rain.3h");
});
