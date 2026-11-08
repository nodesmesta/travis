// Process and fixture helpers for end-to-end validators (Task 07).

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const root = new URL("../..", import.meta.url).pathname;
const processes = [];

export function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(url, label, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The process is still starting; the loop retries until the budget ends.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

/** Starts a Node child process (its own process group) and remembers it for stopAll(). */
export function launch(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  processes.push(child);
  return { child, log: () => log };
}

/** Starts the API from dist/ with the given environment. Resolves to its base URL. */
export async function startApi(extraEnv = {}) {
  const port = await freePort();
  const handle = launch(["--env-file=.env.local", "apps/api/dist/index.js"], {
    API_PORT: String(port),
    LOG_LEVEL: "warn",
    ...extraEnv,
  });
  const base = `http://127.0.0.1:${port}/api/v1`;
  await waitFor(`${base}/health`, "API", 120);
  return { base, port, ...handle };
}

export function stopAll() {
  for (const child of processes) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The process already exited.
    }
  }
}

// ---------------------------------------------------------------------------
// FIXTURE Bright Data server.
//
// It answers the one endpoint the backend uses (POST /request) in the shapes that
// were observed live: Full JSON SERP for the SERP zone, and an HTML page for the
// Unlocker zone. `mode` makes it fail the way the real service fails (HTTP 200,
// empty body, reason only in headers). Nothing from this server is live data and
// a validator must label every result that depends on it as FIXTURE.

const FIXTURE_VENUE = "Jakarta Convention Center";

function schedulePage(origin) {
  const events = [
    {
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Indonesia Business Forum 2026 (fixture)",
      startDate: "2026-11-12T19:00:00+07:00",
      endDate: "2026-11-12T21:30:00+07:00",
      location: { "@type": "Place", name: FIXTURE_VENUE },
    },
    {
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Jakarta Tech Networking Night (fixture)",
      startDate: "2026-11-12T20:00:00+07:00",
      endDate: "2026-11-12T22:00:00+07:00",
      location: { "@type": "Place", name: FIXTURE_VENUE },
    },
    {
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Cancelled Trade Fair (fixture)",
      startDate: "2026-11-12T19:30:00+07:00",
      eventStatus: "https://schema.org/EventCancelled",
      location: { "@type": "Place", name: FIXTURE_VENUE },
    },
    {
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Bandung Design Week (fixture)",
      startDate: "2026-11-12T19:30:00+07:00",
      location: { "@type": "Place", name: "Bandung Creative Hall" },
    },
  ];
  return `<!doctype html><html><head><title>Schedule of events (FIXTURE)</title>
<script type="application/ld+json">${JSON.stringify(events)}</script></head>
<body><h1>${FIXTURE_VENUE}: schedule (FIXTURE page for validation, not live data)</h1>
<p>Source: ${origin}/schedule</p></body></html>`;
}

export function startBrightDataFixture() {
  const state = { mode: "ok", requests: [] };
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (request.method !== "POST" || request.url !== "/request") {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(raw);
      state.requests.push({ zone: body.zone, url: body.url });
      if (request.headers.authorization !== "Bearer fixture-key") {
        response.writeHead(401);
        response.end();
        return;
      }
      if (state.mode === "captcha") {
        // Observed live: HTTP 200, empty body, the reason only in headers.
        response.writeHead(200, { "x-brd-error-code": "captcha" });
        response.end();
        return;
      }
      if (body.zone === "fixture-serp") {
        const organic =
          state.mode === "no-results"
            ? []
            : [
                {
                  title: "Jakarta Convention Center schedule (FIXTURE)",
                  link: `${origin}/schedule`,
                  description: "FIXTURE search result.",
                  rank: 1,
                },
                {
                  title: "Google redirect (skipped)",
                  link: "https://www.google.com/goto?url=https%3A%2F%2Fexample.com",
                  description: "FIXTURE search result.",
                  rank: 2,
                },
              ];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ general: { search_engine: "google" }, organic }),
        );
        return;
      }
      if (body.zone === "fixture-unlocker") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(schedulePage(origin));
        return;
      }
      response.writeHead(400);
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        endpoint: `${origin}/request`,
        state,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Environment that points an API instance at the Bright Data fixture. */
export function brightDataFixtureEnv(fixture) {
  return {
    BRIGHT_DATA_API_KEY: "fixture-key",
    BRIGHT_DATA_SERP_ZONE: "fixture-serp",
    BRIGHT_DATA_UNLOCKER_ZONE: "fixture-unlocker",
    BRIGHT_DATA_ENDPOINT_OVERRIDE: fixture.endpoint,
  };
}
