# TravelFlow Assistant

TravelFlow Assistant is a business-travel companion that works from a confirmed trip. It keeps the trip context (places, agenda, journey legs, timezone) in one place and answers questions against it with sourced, time-stamped information.

Built for the lablab.ai hackathon, Challenge 2 "Powering the Future of Work". Infrastructure target: Vultr. Live web data: Bright Data.

> **Deployment status: not deployed.** The application has been run and validated only on a developer machine (local Supabase through the Supabase CLI and Docker). Nothing runs on Vultr yet and there is no public URL. Container files for the app layer (`deploy/`) exist and were verified locally only. See [docs/submission-checklist.md](docs/submission-checklist.md) and [docs/known-limitations.md](docs/known-limitations.md).

## The problem

After a business trip is booked, the traveler still searches by hand: what is happening near the venue, how to get from the hotel to the meeting, whether rain or traffic will break the schedule, where to eat, and then paperwork for whatever was booked. TravelFlow keeps the trip context so the traveler does not repeat it for every question, and it shows where every live fact came from and when it was retrieved.

## What is implemented, and how well it is verified

Status words used in this table:

- **Verified**: exercised against the real local stack (Supabase Auth, Postgres, Storage, Mailpit) or a real provider call.
- **Fixture-verified**: the provider was replaced by a labelled fixture that follows the provider's documented response shape. This proves our adapter, engine, persistence and UI wiring. It does not prove that the provider works.
- **Not verified**: not exercised, or the live check could not run. The reason is given.

| Feature | Status |
|---|---|
| Login with Supabase Auth, session handling in the web app | Verified locally |
| Trip setup: create and edit trips, status changes, places (context points), agenda items, journey legs | Verified locally, including in a browser |
| Event discovery near a place (Bright Data search, page reading, validation, cache) | Fixture-verified. **Not verified live**: no live search has produced an event list (see [How we use Bright Data](#how-we-use-bright-data)) |
| Internal booking with a server-side price (`demo-pricing-v1`) | Verified locally; event source is a fixture in the browser golden path |
| Dummy payment: succeeded, failed, pending, cancelled, refund | Verified locally, including concurrent and duplicate requests |
| Invoice PDF (numbered, checksummed, stored in a private bucket) | Verified locally |
| Invoice email through local SMTP (Mailpit) | Verified locally with a real send and the PDF attachment compared by hash |
| Invoice email through Resend | **Not verified**: no `EMAIL_PROVIDER_API_KEY` and no verified sender domain |
| Assistant chat (planner, tools, synthesis, confirmation dialog) | Verified with the real Vultr model for trip summary, recommendations, clarification and prompt-injection rejection. Route, weather, traffic and restaurant answers are fixture-verified only |
| Mobility: route comparison with deterministic ranking and departure recommendation | Fixture-verified. **Not verified live**: `HERE_API_KEY` is empty. The Mobility view was not opened in a browser |
| Weather and traffic snapshots | **Not verified live**: `OPENWEATHER_API_KEY` and `HERE_API_KEY` are empty |
| Nearby activities (Bright Data) and restaurants (HERE) | **Not verified live**. Booking an activity is verified with fixture rows |
| Hotel and flight search, sandbox prebook, payment, provider booking, reconciliation, cancellation, and invoice through LiteAPI | **Implemented** through authenticated API routes and Hotels/Flights workspace views. The provider key uses LiteAPI sandbox/account test payment, so no real card is charged; live production fulfillment still requires a production provider account and deployment validation |
| Itinerary view (timeline, recommendations, activity log) | Implemented; build passes. The assistant confirmation flow that changes the itinerary was verified in a browser |
| Alerts and background worker (departure reminder, traffic risk, weather risk) | Job claim, lease, deduplication and ownership verified against real Postgres. Alert content fixture-verified. Not verified against live HERE or OpenWeather. The Alerts view was not opened in a browser |
| Health check `GET /health` | Implemented |
| Readiness `GET /ready` and metrics `GET /metrics` | Implemented and tested: `/ready` checks database, Auth, the private invoices bucket, and whether queued jobs are being claimed (503 with the failing check otherwise); `/metrics` is Prometheus text and must not be exposed by the proxy (the Caddy file returns 404 for it) |
| Secret scan, backup and restore checks | `npm run scan:secrets` and `npm run verify:backup-restore` (local database restored into a scratch database: 12 checks) |
| Deployment on a Vultr VM with HTTPS | **Not done** |

Details and the evidence behind each line are in [docs/known-limitations.md](docs/known-limitations.md) and the task files under `plan/tasks/`.

## Architecture

```text
Browser (Next.js app, Supabase Auth session)
   |  access token
   v
API (Node.js, TypeScript, no framework)   -- verifies the token, checks trip ownership,
   |                                         validates input, applies rate limits
   |-- Domain rules (packages/domain): trip rules, mobility engine, alert rules, invoice rules
   |-- Provider adapters (packages/integrations)
   |      |-- Vultr Serverless Inference   planner, synthesis, event claim extraction
   |      |-- Bright Data Direct API       search results and page contents
   |      |-- HERE                         routes, transit, traffic, restaurants
   |      |-- OpenWeather                  current and hourly weather
   |      '-- Email                        SMTP (local Mailpit) or Resend
   v
Supabase Postgres + Storage (Row Level Security on every table)
   ^
   |  jobs, alerts, invoices, email deliveries
Worker (apps/worker)   -- claims jobs with a lease, refreshes weather and traffic,
                          creates alerts, generates invoices, sends invoice email
```

Component list, data flows, the data model and the trust boundaries are in [docs/architecture.md](docs/architecture.md). The original design is in `plan/plan.md` and `plan/segments/`.

## How we use Vultr

### Vultr Serverless Inference (implemented and called live)

The backend calls Vultr Serverless Inference through an OpenAI-compatible chat API (`VULTR_INFERENCE_BASE_URL`). The default model is `deepseek-v4.1-flash-1017` (`VULTR_INFERENCE_MODEL`). The model is used for three things, and the backend validates every output before anything is shown or stored:

1. **Planner.** A forced tool call (`submit_plan`) chooses an intent and at most a few tools from an allowlist. The backend rejects unknown tools, and it decides the origin and destination of a route itself. The model never picks them.
2. **Synthesis.** A strict JSON schema answer is written from the tool results. The backend rejects numbers that are not in the data, new URLs, missing source ids, and any change to the route ranking or the recommended option computed by the mobility engine.
3. **Event claim extraction.** When a page has no schema.org Event markup, the model returns claims, each with a verbatim evidence excerpt. The backend keeps a claim only if the excerpt is found in the page text and states the date and, when given, the time.

The gateway (`packages/integrations/src/vultr-inference.ts`) is strict on purpose:

- It compares the `model` field of the answer with the model that was requested and fails with `EXTERNAL_MODEL_MISMATCH` when they differ. This is needed because the API answers HTTP 200 and silently routes an unknown model id to its default model. The smoke test reproduced that behavior.
- It fails when `finish_reason` is not the expected one, which includes `length` (output budget exhausted by reasoning tokens) and `error`.
- It does not retry. A failure is a structured error, and the user can ask again as a new request.
- It never logs prompts or the API key.

Recorded live checks (`scripts/provider-smoke-test.sh`, `docs/validation/task-07-result.md`, `plan/tasks/09-ai-orchestration.md`): tool call, structured output, unknown-model guard, small output budget ending in `length`, and invalid credentials rejected with HTTP 401 all passed on 7 November 2026. Planner latency was measured at about 1 to 3.5 seconds and synthesis at about 2 to 5 seconds (5 calls per setting, `scripts/measure-inference-latency.mjs`).

### Deployment target (planned, not deployed)

The target is one Vultr VM (8 vCPU, 16 GB RAM, 160 GB NVMe or SSD, Ubuntu 24.04) running Docker Compose with the web app, the API, the worker, a reverse proxy with HTTPS, and a self-hosted Supabase stack (Auth, Postgres, Storage). PostgreSQL and Supabase Studio are not meant to be exposed to the internet. The design is in `plan/segments/09-infrastructure-security.md` and `plan/integrations/supabase-on-vultr.md`.

What exists in the repository for this target: the web app builds with `output: "standalone"` (`apps/web/next.config.ts`), the API and worker are plain Node.js processes configured by environment variables, and every database change is a numbered migration in `supabase/migrations/`. `deploy/` holds Dockerfiles for web, api, and worker, a Compose file, a Caddyfile, and a production env template. `npm run verify:deploy-local` builds the images and starts the stack against the local Supabase (42 checks passed, 2 skipped, on 7 November 2026). What does not exist yet: a provisioned VM, a domain, HTTPS issued for a real name, the self-hosted Supabase stack, and a deployed health run. See [deploy/README.md](deploy/README.md).

## How we use LiteAPI

LiteAPI is connected server-side for hotel and flight availability, prebook, sandbox payment, provider booking, reconciliation, cancellation, and invoice generation. The API key remains in the API environment and is sent only as the `x-api-key` request header. The authenticated workspace exposes:

- `POST /trips/{tripId}/hotels/search`, `/hotels/prebook`, `/hotels/{providerBookingId}/book`, reconciliation, and cancellation.
- `POST /trips/{tripId}/flights/search`, `/flights/prebook`, `/flights/{providerBookingId}/book`, reconciliation, and cancellation.
- Provider booking attempts are persisted separately from internal bookings. A stable local `client_reference` prevents a second provider order when a request is replayed.
- Local dummy payment must succeed before the provider book call. Confirmed provider bookings are eligible for the existing invoice PDF and email flow.

The API checks trip ownership, applies per-user rate limits, enforces provider timeout and response-size limits, and does not retry provider calls. Timeout or unknown provider outcomes are stored as `unknown` and require reconciliation; they are never reported as successful. Sandbox hotel responses are labeled as sandbox, and the UI does not claim production fulfillment. Full passport numbers and card data are not persisted.

## How we use Bright Data

Bright Data supplies the live web data for event discovery and for activity discovery. All calls come from the backend (never the browser), and the API key and zone names are environment variables (`BRIGHT_DATA_API_KEY`, `BRIGHT_DATA_SERP_ZONE`, `BRIGHT_DATA_UNLOCKER_ZONE`).

### Access method

- **Direct API.** `POST https://api.brightdata.com/request` with a body of zone, URL and `format: "raw"` (`packages/integrations/src/bright-data.ts`).
- **SERP API zone for search.** The search URL is a Google search URL with `brd_json=1`, so the answer is Full JSON (organic results as structured fields) and does not depend on the zone's default format.
- **Web Unlocker zone for source pages.** Candidate pages from the search are fetched through the Unlocker zone.
- **Failures hidden behind HTTP 200.** Bright Data can answer HTTP 200 with an empty body and put the reason only in headers. The client reads `x-brd-error-code`, `x-brd-err-code` and `x-brd-error` on every response, maps rate-limit codes to `EXTERNAL_PROVIDER_RATE_LIMITED` and other codes to `EXTERNAL_PROVIDER_REJECTED`, and reports an empty body without a reason as `EXTERNAL_RESPONSE_INVALID`. Free-form provider text is shown only for a short list of known codes, with IP addresses masked.

### Pipeline

```text
context point + date window + category
  -> query fingerprint -> cache lookup (valid entries only)
  -> Bright Data SERP (Full JSON)
  -> candidate pages (skips Google redirect wrappers, other Google pages,
     social networks, binary files)
  -> each page through Web Unlocker
  -> parse5 text extraction and schema.org Event (JSON-LD) when present
  -> otherwise Vultr model extracts claims with verbatim evidence
  -> validation: evidence in page, date/time in evidence, timezone conflicts,
     inside the requested window, not cancelled, tied to the requested place
  -> de-duplication
  -> stored with source URL, retrieved_at and expires_at
```

HTML is read with `parse5`, a standards-based parser. There is no regular expression anywhere in the pipeline. The event list says that matching to the place is by venue name and that distance is not verified.

### What we observed live (honest)

These are recorded measurements from the development machine, not guarantees.

- A Bright Data search request took roughly 9 to 35 seconds. The documentation claims under one second. `BRIGHT_DATA_TIMEOUT_MS` defaults to 60000, and the assistant's event tool has its own 150 second budget.
- Behavior is intermittent. The same query returned different results between calls. Some requests returned HTTP 200 with an empty body and a reason in the headers (`captcha`, `expect_element`, a denylisted-IP code on a different zone). One validation run got an immediate request failure (HTTP 502).
- Many search results are `google.com/goto?url=...` wrappers. Web Unlocker could not resolve them (`invalid_path`), so they are skipped and counted in the result's limitations.
- The Unlocker zone rejected candidate pages on some hosts with `client_10030` (recorded for jcc.co.id, scribd.com and hirespace.com when called from the development machine). The Task 08 notes read this as a domain that needs special permission on the zone. Whether the cause is the development network or the account has not been confirmed, and it has not been tested from a server with a fixed IP.
- The official page of the demo venue (jcc.co.id schedule) has no schema.org Event markup, and loads its list through an AJAX call that was not tested.
- **Result: a live search has not yet produced a list of events.** The cleanest live outcome was an honest answer "0 events found" with the unreadable results listed in the limitations. The rest of the booking flow was therefore verified with a fixture that returns schema.org Event markup (`scripts/lib/harness.mjs`), and every report labels it as a fixture.

More detail: `plan/integrations/bright-data-direct-api.md`.

## Design principles

- **No fallback.** If a provider fails, the use case fails with a structured error (code, request id, safe message). There is no alternate provider, no stale data in place of a failed refresh, no fixture in place of a live result, and no automatic retry. A cache entry is used only if it is still valid before the provider is called.
- **No invented data.** Events, weather, traffic, prices from providers, opening hours and routes come from a provider and carry a source and `retrieved_at`. When data is missing, the API and the UI say `unavailable`.
- **The model does not change numbers or ranking.** The mobility engine (`packages/domain/src/mobility`) is deterministic and versioned (`mobility-v1`). The model writes text and the backend rejects text that contradicts the computed facts.
- **Confirmation for assistant-initiated changes.** Anything the assistant proposes that changes the itinerary (saving or expiring an event result, applying, saving or dismissing a recommendation) needs a confirmation token. Only the SHA-256 hash of the token is stored, it is bound to the user, trip, action, entity and payload, expires after 15 minutes by default (`AI_CONFIRMATION_TTL_MINUTES`), and is consumed by one atomic update.
- **Server-side price.** The booking price comes from `demo-pricing-v1` on the server. The client cannot set it, and the invoice copies it. The price is a fixed demo catalog, not a provider price.
- **Ownership everywhere.** Every trip route checks that the trip belongs to the signed-in user, and Row Level Security repeats the check in the database. The service role key is used only by the backend and the worker.
- **Idempotent mutations.** Create, payment and invoice actions use an `Idempotency-Key`.
- **Secrets stay server-side.** Only `NEXT_PUBLIC_*` values reach the browser. Logs redact keys named like authorization, token, password, secret or API key.

## Quick start (local)

Prerequisites:

- Node.js 22 or newer and npm.
- Docker (the Supabase CLI runs the local stack in containers).
- Supabase CLI.
- Poppler tools (`pdfinfo`, `pdftotext`) are needed only by the invoice tests and validators.
- Playwright Chromium (`npx playwright install chromium`) is needed only by the browser scripts.

From a clean state:

```bash
npm install
supabase start
supabase db reset --yes            # same as: npm run db:reset:local (deletes all local data)
npm run bootstrap:local            # demo user, demo trip seed, writes .env.local
```

`bootstrap:local` refuses to run against a non-local Supabase URL. It writes `.env.local` (git-ignored, mode 600) with the local Supabase URL and keys and a generated demo password (`DEMO_EMAIL`, `DEMO_PASSWORD`). Then edit `.env.local` and fill in the keys you have. Names are in `.env.example`:

- Bright Data: `BRIGHT_DATA_API_KEY`, `BRIGHT_DATA_SERP_ZONE`, `BRIGHT_DATA_UNLOCKER_ZONE`.
- Vultr Serverless Inference: `VULTR_INFERENCE_API_KEY` (base URL and model are filled with defaults).
- HERE and OpenWeather: `HERE_API_KEY`, `OPENWEATHER_API_KEY`. Without them, routes, weather, traffic and restaurants return a structured "not configured" error and nothing is invented.
- LiteAPI: `LITEAPI_API_KEY`. The Hotels and Flights views use this for live sandbox rates, prebook, provider booking, reconciliation, and cancellation. It is optional; without it, the routes return a structured configuration error.
- Local email through Mailpit: `EMAIL_PROVIDER=smtp`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT=1025`. Mailpit's SMTP port is not published to the host, so `SMTP_HOST` is the container address (`docker inspect supabase_inbucket_vultr`). Mailpit's web UI is at `http://127.0.0.1:55424`. Note that `bootstrap:local` does not preserve these email variables when you run it again, so set them after the last bootstrap.

Then build and run (three terminals):

```bash
npm run build
npm run start:api:local            # API on 127.0.0.1:4000
npm run dev:web:local              # web app on http://localhost:3000
npm run start:worker:local         # background worker (alerts, invoices, email)
```

The login screen has one button, "Continue with Google". `bootstrap:local` also sets `NEXT_PUBLIC_ENABLE_PASSWORD_LOGIN=true` in `.env.local`, which adds a small "Local test sign-in" form for the demo account (`DEMO_EMAIL` and `DEMO_PASSWORD` from `.env.local`). That form exists because the browser test scripts cannot drive Google's consent screen. It is not shown when the flag is unset, which is the production setup, and the deployed Supabase Auth server refuses password sign-in anyway. To try the Google button against the local stack you need your own OAuth client: set `GOOGLE_CLIENT_ID` and `GOOGLE_SECRET` and enable the provider in `supabase/config.toml`; this has not been tried locally. The seed creates one trip ("Jakarta Business Trip", 12 to 14 November 2026, Asia/Jakarta) with three places: Hotel Indonesia Kempinski, Jakarta Convention Center and Soekarno-Hatta International Airport. It creates no agenda items and no journey legs. Create a journey leg in the Trips view before using Mobility. The step-by-step demo is in [docs/demo-script.md](docs/demo-script.md).

## Tests and validators

```bash
npm run build                      # tests import the built packages, so build first
npm run lint                       # no-regex check plus type checks of every workspace
npm test                           # node:test unit tests in each workspace
npm run validate:contracts         # JSON Schema files, fixture and OpenAPI markers
npm run format:check
```

Validators run against the real local Supabase stack. Most of them need an API process running from `apps/api/dist` and take its address from `API_BASE_URL` (default `http://127.0.0.1:4000/api/v1`). They print `PASS`, `FAIL` or `BLOCKED`. A check that needs a key that is not set is `BLOCKED`, never `PASS`.

| Command | What it checks |
|---|---|
| `npm run validate:task-02`, `npm run validate:task-03` | Auth, ownership and RLS; trip context rules. These two need the `TASK02_*` and `TASK03_*` variables listed at the top of each script, which `bootstrap:local` does not generate |
| `npm run validate:trips` | Trip creation and editing (17 checks) |
| `npm run validate:task-08` | Mobility, weather, traffic, nearby places. Includes labelled FIXTURE checks |
| `node --env-file=.env.local scripts/validate-task-09.mjs` | Assistant orchestration. `npm run validate:task-09` runs the same script without loading `.env.local` |
| `npm run validate:task-10` | Jobs, worker, alerts |
| `npm run validate:task-11` | Invoices and email through local Mailpit |
| `node --env-file=.env.local scripts/validate-task-07.mjs` | Core demo (login to confirmed booking). Starts its own API and fixture server and writes `docs/validation/task-07-result.md` |
| `npm run smoke:providers` | One call per provider, no retry. HERE and OpenWeather report `BLOCKED` without keys |
| `node --env-file=.env.local scripts/ui-golden-path.mjs`, `ui-smoke-assistant.mjs`, `ui-smoke-invoices.mjs`, `ui-smoke-trips.mjs` | Playwright browser runs. Screenshots go to `docs/validation/` |

Check the scripts' header comments for the exact ports and prerequisites. `npm run scan:secrets` checks the working tree for secret values and token shapes. Other checks: `npm run verify:backup-restore`, `npm run verify:deploy-local`.

## No regular expressions

The project does not use regular expressions anywhere: code, tests, scripts, SQL, JSON Schema and OpenAPI. `npm run check:no-regex` (part of `npm run lint`) parses the TypeScript and JavaScript files and scans SQL, JSON, YAML and shell files, and fails if it finds one. Text handling uses helpers in `packages/integrations/src/text.ts`, route matching uses `apps/api/src/routing.ts`, HTML uses `parse5`, and URLs, dates and JSON use the platform parsers. The check covers code and data files, not Markdown.

## Repository layout

```text
apps/api          HTTP API (Node.js + TypeScript): routes, services, repositories
apps/web          Next.js web app (views for trips, explore and book, mobility, assistant,
                  itinerary, alerts, invoices)
apps/worker       Background job runner and scheduler
packages/contracts  Shared contract types
packages/domain     Pure domain rules (no I/O): trips, mobility, alerts, assistant, invoices
packages/integrations  Provider adapters: Vultr Inference, Bright Data, HERE, OpenWeather, email
contracts/        OpenAPI, JSON Schemas, enums, error codes, state transitions, fixtures
supabase/         Migrations 0001 to 0010, seed, local config
scripts/          Bootstrap, validators, browser scripts, provider smoke test
docs/             Architecture, demo script, checklist, limitations, validation output
plan/             Design (plan.md, segments, integrations) and task files with results
```

## MVP limits

- Dummy payment only. No card data is collected or stored, and no money moves. External bookings and transport tickets are not made.
- Demo prices are a fixed catalog (`demo-pricing-v1`), not provider prices.
- Alerts are shown inside the app only. No push or email for alerts.
- No onboarding screen and no profile or settings screen.
- The assistant answers in one response; streaming is not implemented.
- One demo trip in one city (Jakarta) is the tested scenario.
- Place coordinates and a place reference are entered by the user; no geocoder is wired into the UI.

The full list is in [docs/known-limitations.md](docs/known-limitations.md).

## Documentation

- [docs/architecture.md](docs/architecture.md): components, data flows, data model, trust boundaries, observability, security.
- [docs/demo-script.md](docs/demo-script.md): 4 to 5 minute demo with preparation and backup steps.
- [docs/submission-checklist.md](docs/submission-checklist.md): lablab.ai submission items and their real status.
- [docs/known-limitations.md](docs/known-limitations.md): limitations and validation results.
- `docs/validation/`: validation output and screenshots.
- `contracts/openapi.yaml`: HTTP contract.
- `plan/`: design notes in Indonesian, per-task implementation records.

## License

License: to be decided by the repository owner. No license file is present in this repository.
