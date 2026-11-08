# Architecture

> **Status note (9 November 2026).** This document was written before the deployment. The application is now live at https://travis.nodesemesta.com on a Vultr VM with Docker Compose, Caddy HTTPS and a self-hosted Supabase stack. Where the text below describes a Vultr VM, a domain, HTTPS or self-hosted Supabase as planned, read it as the design that was subsequently deployed.

This document describes what is in the repository today. Where something is a plan and not code, it says so. For the original design see `plan/plan.md` and `plan/segments/`.

Status words: **implemented** means the code exists and is covered by a test or validator. **planned** means it is designed but absent from the repository. **in progress** means the repository owner is adding it now.

## 1. Components

| Component | Location | Role |
|---|---|---|
| Web app | `apps/web` | Next.js (App Router) client. Supabase Auth login, then calls the API with the access token. Views: Explore and book, Advice, Itinerary, Alerts, Invoices, Trips; the assistant is a collapsible right-hand rail. |
| API | `apps/api` | Plain Node.js HTTP server. Verifies the token, checks trip ownership, validates input, runs domain commands, calls providers, serializes responses. Routes are in `src/index.ts` and `src/routes/*.ts` |
| Worker | `apps/worker` | Job runner and scheduler. Claims jobs with a lease, refreshes weather and traffic, creates alerts and departure reminders, generates invoices, sends invoice email |
| Domain | `packages/domain` | Pure rules without I/O: trip context service, mobility engine (`mobility-v1`), alert rules and schedule (`alerts-v1`), assistant planner and response validation, invoice number, eligibility and PDF writer |
| Integrations | `packages/integrations` | Provider adapters: Vultr Inference gateway, Bright Data client, event and activity pipelines, HERE, OpenWeather, email (SMTP and Resend). No database access |
| Contracts | `contracts/`, `packages/contracts` | `openapi.yaml` (45 paths), 27 JSON Schemas, enums, error codes, state transitions, idempotency rules, a core-demo fixture |
| Database | `supabase/migrations/0001` to `0010` | Postgres schema, RLS, SQL functions for atomic operations, private storage bucket |

Container files for the app layer are in `deploy/` (Dockerfiles, Compose, Caddyfile). They were verified on a developer machine only, not on Vultr; see `deploy/README.md`. The Vultr VM, the self-hosted Supabase stack, the domain, and HTTPS are **planned**: see `plan/segments/09-infrastructure-security.md`.

## 2. Runtime topology

Local (what has been run):

```text
Browser -> Next.js dev server (:3000) -> API (127.0.0.1:4000) -> Supabase local stack (Docker)
                                              ^                     (Auth, Postgres, Storage, Mailpit)
                         Worker -------------+
```

Target (planned, not deployed):

```text
Internet -> reverse proxy (HTTPS) -> web app container
                                  -> API container -> Supabase containers (Auth, Postgres, Storage)
                                     worker container -/
All on one Vultr VM; Postgres and Studio not exposed publicly.
```

## 3. Data flows

### 3.1 Live information (events, activities)

```text
POST /api/v1/trips/{tripId}/event-discoveries
  1. Authenticate, load the trip as the signed-in user (RLS applies).
  2. Load the context point; it must be resolved and active.
  3. Build a query from context point, date window, timezone, category;
     fingerprint it.
  4. Cache: if a stored run for the fingerprint is still valid, return it
     (no provider call). Expired runs are never returned as live.
  5. Pipeline: Bright Data SERP -> candidate pages through Web Unlocker
     -> JSON-LD Event or Vultr model claims with evidence -> validation
     -> de-duplication.
  6. Persist the run, the results, the sources (URL, retrieved_at, expires_at).
  7. Respond with items, sources, freshness, limitations.
Provider failure: structured error (EXTERNAL_PROVIDER_*, EXTERNAL_RESPONSE_INVALID, ...);
the error propagates and no run is stored. A search that was read but found
nothing valid is a stored, valid "empty" answer, which is different from an error.
GET .../event-discoveries?context_point_id=... returns the latest fresh result;
an expired one is HTTP 410 EVENT_DISCOVERY_EXPIRED.
```

Activities follow the same pipeline (`ActivityDiscoveryPipeline`). Restaurants use HERE Browse. Both are served by `POST /trips/{tripId}/place-discoveries`.

Mobility: `POST /trips/{tripId}/journey-legs/{id}/route-requests` gathers HERE routes per mode (default car, pedestrian, transit), applies traffic and weather facts when required, and runs the deterministic engine. The result (options, scores, recommended option, departure recommendation) is stored with its sources and policy version. `select` picks an option; an excluded or expired option cannot be selected (HTTP 409).

Assistant: `POST /trips/{tripId}/chat`.

```text
message -> ContextResolver (backend resolves which places the user means)
        -> planner call to Vultr (forced tool call, enum of allowed tools)
        -> backend validates the plan; ambiguous or invalid -> clarification or error
        -> tools run in the backend (events, trip summary, recommendations,
           routes, weather, traffic, activities, restaurants)
        -> synthesis call to Vultr (strict JSON schema)
        -> backend validates numbers, URLs, source ids, ranking
        -> stored in conversation_messages; cards returned to the UI
```

The model has no database or provider access. Content from the web is wrapped in an untrusted-data fence in the prompts, and the prompts are checked for secret values before they are sent.

### 3.2 Booking and dummy payment

```text
GET  .../booking-quote?booking_type=...      server price (demo-pricing-v1)
POST .../bookings                            source must belong to the same trip
                                             (event result, activity place, agenda item);
                                             body cannot carry price or card fields
POST .../bookings/{id}/payments              outcome: succeeded | failed | pending | cancelled
POST .../bookings/{id}/payments/{id}/refund
```

Payment success, booking confirmation, refund, idempotency claim and activity log run in one Postgres function (RPC) with a row lock on the booking. A booking becomes `confirmed` only after a `succeeded` payment. A partial unique index allows one succeeded payment per booking. Requests carrying `card_number` or unknown fields are rejected.

### 3.3 Invoice and email

```text
payment succeeded -> API enqueues generate_invoice (if INVOICE_AUTO_GENERATE=true)
                     or the user clicks "Generate invoice"
generate: prepare_invoice (number INV-YYYY-NNNNNN, gapless per year)
          -> PDF written by packages/domain/src/invoice/pdf.ts
          -> stored in private bucket "invoices" with SHA-256 checksum
          -> finalize_invoice_pdf
download: API streams the object after an ownership check and checksum comparison
email:    POST .../invoices/{id}/email -> create_email_delivery (dedup key)
          -> job send_invoice_email -> worker claims the delivery (one attempt)
          -> reads the PDF, checks the checksum -> SMTP (local) or Resend
          -> complete_email_delivery (status, provider message id)
```

Invoices exist only for `succeeded` payments, and database triggers reject a different amount than the booking and payment. An email failure never changes the booking, payment or invoice rows. A resend is a new request and a new delivery row. A delivery claimed by a worker that then dies stays `pending`.

### 3.4 Alert jobs

```text
Worker scheduler tick (WORKER_SCHEDULE_INTERVAL_MS)
  -> plans jobs for confirmed or active trips (pure function, idempotency keys):
     departure_reminder, refresh_traffic, refresh_weather, evaluate_alerts
  -> JobRunner claims jobs (claim_background_jobs, lease, heartbeat)
  -> handler runs (HERE / OpenWeather through MobilityService, or no provider
     for the departure reminder)
  -> rules create alerts with a deduplication key (create_alert)
  -> complete_background_job; expired leases become "interrupted"
User: GET .../alerts, POST .../alerts/{id}/read | dismiss, GET .../jobs, POST .../jobs/{id}/rerun
```

Each job runs once (no automatic retry). A failed provider call makes the job `failed` with a code and creates no alert. Alerts are created only from non-expired snapshots. A manual rerun creates a new job with `parent_job_id`. The worker never changes the itinerary.

## 4. Data model (summary)

29 tables in `public`, all with Row Level Security enabled in the migration files. Ownership is `trips.user_id = auth.uid()`; child tables check it through `trip_id`.

| Migration | Tables |
|---|---|
| 0001 | `profiles`, `trips` |
| 0002 | `context_points` |
| 0003 | `agenda_items`, `journey_legs` |
| 0004 | `idempotency_records`, `activity_logs` |
| 0005 | `event_discovery_runs`, `event_discovery_results`, `sources`, `source_references` |
| 0006 | `bookings`, `payments` (and the payment RPC functions) |
| 0007 | `place_discovery_runs`, `place_discovery_results`, `weather_snapshots`, `traffic_snapshots`, `route_requests`, `route_options`, `recommendations` |
| 0008 | `conversations`, `conversation_messages`, `assistant_confirmations` |
| 0009 | `background_jobs`, `alerts` |
| 0010 | `invoice_number_counters`, `document_storage_objects`, `invoices`, `email_deliveries`, Storage bucket `invoices` |

Points that matter:

- Users generally get `select` on their own trip's rows. Writes that must be atomic or must not be forged by a user go through SQL functions. Examples: `claim_background_jobs`, `create_alert`, `persist_mobility_batch`, `assistant_consume_confirmation`, and the invoice and email functions, which are granted to `service_role` only.
- `sources` and `source_references` hold the URL, provider, `retrieved_at` and `expires_at` of every live fact, referenced from events, places, snapshots, routes and alerts.
- The `invoices` bucket is private (`public = false`), limited to 5 MB and `application/pdf`, and has no Storage policy for end users. Only the service role reads it.
- Composite foreign keys with `trip_id` prevent references across trips.
- Seed data (`supabase/seed.sql`) creates one profile, one trip and three places for the demo user. It never creates a password.

## 5. Trust boundaries

```text
Untrusted           Browser, web page content, model output, provider responses
   |  Authorization: Bearer <Supabase access token>
Backend (trusted)   API and worker: validate, authorize, decide
   |  user-scoped client (anon key + user token, RLS applies)
   |  admin client (service role) only for jobs, invoices, storage, alerts
Database            Postgres with RLS as the second check
Providers           Vultr Inference, Bright Data, HERE, OpenWeather, email: called only from the backend
```

- The browser never calls a provider and never sees the service role key. Only `NEXT_PUBLIC_*` variables are bundled.
- The API verifies the access token with Supabase Auth, then creates a Supabase client that carries the user's token, so a query that skips the ownership check in code is still limited by RLS.
- The service role key is read from the environment by the API and the worker only. It is used for job and alert writes, invoice and storage operations, and the SQL functions granted to `service_role`.
- Model output and web content are data. The model can only select from an allowlist of tools, and every number, URL and source id it writes is checked against the tool results.

## 6. Observability

Implemented:

- **Structured logs.** One JSON object per line on stdout with timestamp, level, event and fields (`apps/api/src/logger.ts`). Keys whose names contain authorization, cookie, password, secret, token, `apikey`, `api_key` or `api-key` are replaced by `[REDACTED]`.
- **Correlation ID.** The API takes `x-request-id` from the request when it is 1 to 120 characters, otherwise generates a UUID. It sets the header on the response and puts `request_id` in every JSON body and error envelope. Background jobs carry a `correlation_id`; an invoice or email chain started by a request keeps that request id, and scheduler ticks log a tick id.
- **Structured errors.** `{ error: { code, category, message, request_id, details? } }`. Codes are listed in `contracts/errors.md`. Provider details exposed to users are limited to known codes.
- **Health.** `GET /health` and `GET /api/v1/health` return `status: ok`, the service name and version. They do not check dependencies.
- **Job observability.** `background_jobs` stores status, lease, heartbeat, attempts and error code; the worker logs claim, completion and interruption. `activity_logs` records commands.

- **Readiness.** `GET /ready` (`apps/api/src/readiness.ts`, in `contracts/openapi.yaml`) returns 200 only when the database answers, Auth answers, the `invoices` bucket exists and is private, and no queued job is overdue by more than `READY_JOB_STALE_SECONDS` (a stuck queue means no worker is claiming). Otherwise it answers 503 with the failing check and a short code. Raw error text is never returned. Provider keys are reported as configured or not; connectivity to providers is tested by `npm run smoke:providers`, not here.
- **Metrics.** `GET /metrics` (`apps/api/src/metrics.ts`) returns Prometheus text: request counts by method, route (ids replaced by `:id`), and status class; a duration histogram; provider errors by provider and code; uptime and memory. Counters live in memory and reset on restart. When `METRICS_TOKEN` is set the request needs a bearer token. The Caddyfile answers 404 for `/metrics`, so it is reachable only inside the host.

Not implemented: alerting on service health, log shipping, dashboards, backup monitoring.

## 7. Security

Implemented:

- **Authentication.** Supabase Auth issues sessions. The API rejects missing or malformed Bearer tokens (401) and unverifiable tokens.
- **Authorization.** Ownership checks in code and RLS in the database. A user who asks for another user's trip gets 404.
- **Confirmation tokens.** Table `assistant_confirmations` stores only the SHA-256 hash of the token with user, trip, action, entity and a hash of the payload. One `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()` consumes it. Reuse, another user's token, another action or entity, a changed payload and an expired token all fail.
- **Secret handling.** Secrets are environment variables (`.env.example` lists the names; real values go in the git-ignored `.env.local` or the deployment's secret store). Logs redact secret-like keys. Prompts are checked for configured secret values before sending. The Vultr gateway test checks that the API key does not leak. `BRIGHT_DATA_ENDPOINT_OVERRIDE`, `HERE_BASE_URL_OVERRIDE` and `OPENWEATHER_BASE_URL_OVERRIDE` are test hooks that the configuration rejects when `NODE_ENV=production`.
- **Input handling.** Bodies are read with a size limit (HTTP 413). Booking and payment parsers reject unknown fields. Dates need an explicit offset and trip timezones must be IANA names. No regular expressions anywhere.
- **Rate limits.** In-memory fixed windows (per process) on route, weather, traffic and place-discovery requests, on manual job reruns and on invoice email requests. Event discovery and the assistant chat endpoint have no rate limit.
- **CORS.** Only origins in `CORS_ALLOWED_ORIGINS` get CORS headers.
- **Payment data.** No card data is accepted or stored. The payment is a simulator.
- **Documents.** Invoices live in a private bucket; downloads go through the API with an ownership check and a checksum comparison; email sends the attachment only after the checksum matches.

Not implemented or not verified:

- TLS and a reverse proxy (not deployed), security headers, firewall rules, Postgres and Studio exposure rules on a real server.
- Backup and restore. No backup procedure has been run.
- Alerting on top of the metrics (no alert manager or dashboard is configured).
- Rate limiting that works across several API processes.
