# Known limitations and validation results

> **Status note (9 November 2026).** This file records checks made before the deployment. The application is now live at https://travis.nodesemesta.com; section 1 is the pre-deployment checklist and the provider notes in section 3 describe the Google SERP path that has since been replaced by Bing. Current deployment status is in the README and the whitepaper.

This document lists what does not work or was not verified, and the results of the checks that were run. Results are copied from the task files under `plan/tasks/` and from `docs/validation/task-07-result.md`. They were recorded on 7 November 2026 on a developer machine and were not all re-run for this document. Only `npm run check:no-regex` (passes) and `npm run validate:contracts` (27 JSON schemas, passes) were run again while writing it.

Terms: **PASS** means a check ran and passed. **FIXTURE** means a labelled stand-in for a provider that follows the provider's documented response shape. It proves our code, not the provider. **BLOCKED** means the check could not run, with the reason.

## 1. Deployment and operations

| Limitation | Detail |
|---|---|
| Not deployed on Vultr | No VM, no domain, no public URL. The application ran only on a developer machine with the Supabase CLI stack. All Task 12 deployment criteria are open (see `plan/tasks/12-deployment-security-observability-and-submission.md`) |
| Container files verified locally only | `deploy/` has Dockerfiles, Compose, and a Caddyfile. They were built and started against the local Supabase stack, not on Vultr, and not with a real domain or HTTPS |
| No test from the server's IP | Access to the server named `travis` (`plan/tasks/README.md`, session decisions of 7 November 2026) was refused: public key and password both failed. So nothing was tested from a fixed server IP, and the Bright Data rejections below could not be checked from there |
| `/ready` and `/metrics` | Implemented and tested locally. Not exercised on a deployment. `/metrics` has no dashboard or alert rules behind it |
| Backup and restore | No backup was taken and no restore was tested |
| Secret scan | `npm run scan:secrets` exists and checks the working tree. It has not been run on git history, because the repository is not a git repository yet |
| Rate limiting | In-memory, per process. Not applied to event discovery or the assistant chat endpoint, which call paid providers |
| Dependency audit | Task 01 recorded 2 `npm audit` findings and did not fix them. Not re-checked |
| Source control | The working directory is not a git repository |

## 2. Provider verification

| Provider | Verified | Not verified |
|---|---|---|
| Vultr Serverless Inference | Live smoke test (7 November 2026): tool call, structured output, an unknown model id is silently rerouted (so the model-echo guard is required), a small output budget ends with `finish_reason` length, invalid credentials give HTTP 401. Real assistant conversations ran against `deepseek-v4.1-flash-1017` | Behavior under the documented rate limits (120 requests per minute) was not tested |
| Bright Data SERP (Direct API, Full JSON) | Live request returned organic results in the smoke test | Stability: latency 9 to 35 seconds, intermittent failures |
| Bright Data Web Unlocker (pages) | Some pages were read | A live search never produced a list of validated events. See section 3 |
| HERE (routes, transit, traffic, browse) | Adapter, normalizers, engine and persistence with FIXTURE responses | **BLOCKED**: `HERE_API_KEY` is empty. No live call has been made |
| OpenWeather (One Call 3.0) | Adapter and rules with FIXTURE responses | **BLOCKED**: `OPENWEATHER_API_KEY` is empty |
| Email through local SMTP (Mailpit) | Real send, PDF attachment hash equals the downloaded PDF, `Message-ID` stored | |
| Email through Resend | Adapter with a FIXTURE of the documented request shape | **BLOCKED**: `EMAIL_PROVIDER_API_KEY` is empty and there is no verified sender domain |

## 3. Bright Data: live findings

Recorded in `plan/integrations/bright-data-direct-api.md` and the Task 07, 08 and 09 files.

- **No live event list yet.** Task 07's live event discovery run ended with HTTP 502 `EXTERNAL_PROVIDER_ERROR` ("Bright Data request failed") after 0 seconds. In Task 09, one assistant turn answered honestly that 0 events were found (19.1 seconds; seven results were Google redirect links and two were social media, so they could not be read). Nine other attempts for the same or similar questions ended in `EXTERNAL_PROVIDER_REJECTED`.
- **`client_10030` on the Unlocker zone.** The rejections named hosts such as jcc.co.id, scribd.com and hirespace.com, and trip.com and wikipedia in the Task 08 activity check. The Task 08 notes describe this as domains that need special permission. Whether it depends on the development network's IP or on the zone's permissions is **not confirmed**. A different code, `client_10050` (denylisted IP), was seen earlier on a different zone and not on the SERP zone.
- **Latency.** A SERP request took roughly 9 to 35 seconds. The documentation claims under one second.
- **Silent failures.** `captcha`, `expect_element` and `client_10050` came back as HTTP 200 with an empty body and the reason only in headers. The client reads those headers.
- **Unusable links.** Google redirect wrappers (`google.com/goto`) are common in results and cannot be resolved through Web Unlocker (`invalid_path`). They are skipped.
- **Query text.** In one live check the date in the query text did not reach Google (`general.query` lacked it). The pipeline therefore validates dates on the source page, not in the query.
- **Result variation.** The same query returned different links in different calls. Results are not deterministic.
- **The demo venue's own site.** jcc.co.id/schedule-of-events has no schema.org Event markup and loads its list through an AJAX call that was not tested.
- **`ibp=htl;events`** (Google's event block) returned an empty body with `expect_element` after 129 seconds. The pipeline does not use it.
- **Model-extraction risk.** When a page has no structured markup, the Vultr model extracts claims. In one live run the final answer was rejected by the backend because the model wrote a number that was not in the data (`SYNTHESIS_INVALID_OUTPUT`, 36.5 seconds). That is the guard working, and also a reason a live answer can fail.

## 4. Results of recorded checks

| Check | Result | Notes |
|---|---|---|
| Task 07 core demo (`scripts/validate-task-07.mjs`, 7 November 2026) | 17 PASS, 0 FAIL, 2 BLOCKED. Decision recorded: GO for the core demo backend with limitations | Sections for booking, payment, ownership, provider failure and duplicate mutation run against a FIXTURE of schema.org Event markup (2 events kept, 1 cancelled and 1 off-site dropped). The two BLOCKED are HERE and OpenWeather. Live event discovery ended with an explicit error. The file says migrations 0001 to 0009 were checked; 0010 came later |
| Task 08 (`validate-task-08.mjs`) | 30 PASS, 0 FAIL, 3 BLOCKED | RLS on seven tables, fixture-based routing and caching. BLOCKED: HERE live, OpenWeather live, activity discovery live |
| Task 09 (`validate-task-09.mjs`) | 35 PASS, 0 FAIL, 3 BLOCKED | Real Vultr model; HERE and OpenWeather answers from FIXTURE; event answer with cards BLOCKED |
| Task 09 browser (`ui-smoke-assistant.mjs`) | 7 PASS; with `--fixture-providers` 8 PASS | Chromium. Fixture cards are labelled |
| Task 10 (`validate-task-10.mjs`) | 28 PASS, 0 FAIL, 2 BLOCKED | Parallel claim, lease expiry, deduplication under concurrent writers, RLS, worker kill detection. BLOCKED: live HERE traffic and OpenWeather |
| Task 11 (`validate-task-11.mjs`) | 29 PASS, 0 FAIL, 1 BLOCKED | Real SMTP into Mailpit. BLOCKED: Resend live |
| Task 11 browser (`ui-smoke-invoices.mjs`) | 6 steps PASS | |
| Trip setup (`validate-task-trips.mjs`, `ui-smoke-trips.mjs`) | 17 checks and 17 steps | |
| Golden path in a browser (`ui-golden-path.mjs`) | Screenshots in `docs/validation/ui-golden-path-*.png` | Events come from a FIXTURE |
| Unit tests | Recorded at Task 11: api 119, domain 109, integrations 102, all passing | Not re-run for this document. Counts for the worker differ between Task 10 (26 tests) and Task 11 ("0 tests") |

## 5. Functional limitations

Product scope:

- **Demo pricing.** Booking prices come from the fixed catalog `demo-pricing-v1` (event IDR 250,000, activity IDR 150,000, itinerary item IDR 100,000, plus 10 percent tax). Providers return no price, so no provider price is shown. The dummy payment never moves money.
- **Onboarding (screen 6.2) and profile/settings (6.12)** are not part of the MVP (decision of 7 November 2026).
- **Alerts are in-app only.** Only three alert types exist: departure reminder, traffic risk, weather risk. Event change, transit disruption and venue change alerts are not implemented.
- **Streaming is not implemented** in the assistant. A reply is validated as a whole before it is shown, so streaming draft text would show text that may later be rejected (Segment 04, "Putusan tool mobility").
- **Assistant tools.** Eight read tools: events, trip summary, recommendations, routes, weather, traffic, activities, restaurants. The intent `suggest_alternative` has no tool. The assistant cannot create bookings, payments or emails; those are UI actions.
- **Route previews are not stored.** A route question between two places without a journey leg gives an answer but no recommendation that can be applied.
- **Numbers in model text.** The check is by set: a model could use a number that exists elsewhere in the data in the wrong place. Ranking and the recommended option are locked tightly; free sentences are not checked semantically.
- **Assistant confirmation steps.** Applying a recommendation consumes the token, then creates the agenda item, then updates the recommendation status. These are not one database transaction. If the agenda item cannot be created, the user asks for a new token. Saving or expiring an event result is one transaction.

Data and inputs:

- **Event relevance.** Events are matched to the place by venue name. Distance is not verified, and the result says so.
- **Places are entered by hand.** A place counts as resolved only with coordinates and a place reference typed by the user. No geocoder is connected to the UI (the HERE geocoding adapter exists but is not wired to an endpoint). The place references in the seed are demo labels (`demo_here_*`), not HERE identifiers.
- **Seed content.** The seed creates one trip and three places and no agenda items or journey legs. `plan/segments/07-persistence-cache.md` expected a sample agenda and a hotel-to-meeting leg.
- **Explore form timezone.** The search form builds its times with a fixed `+07:00` offset. It is right for Jakarta only.
- **Mobility details.** Default modes are drive, walk and public transit. If a provider call for one requested mode fails, the whole request fails. HERE routing returns no fares, so cost is "unavailable" except walking (zero). Traffic is area data around the route and is used only for legs that depart within 180 minutes. Weather comes from hourly data for 48 hours, daily data up to 8 days, and is unknown beyond. The `mobility-v1` buffers (10, 20 and 45 minutes) are product choices, not provider facts.
- **Invoice and email.** The PDF writer is our own single-page generator; characters outside WinAnsi are written as `?`. Email is plain text. The recipient is an address the user types. If a worker claims an email delivery and then dies, the delivery stays `pending` and is not sent again automatically. In local runs `SMTP_HOST` is a container address that can change when the Supabase stack is recreated. After a refund, an existing invoice stays.
- **Single scenario.** The tested scenario is one trip in Jakarta. The plan's "pasted booking text" input is not implemented; trips are entered through the form.

## 6. UI areas not tried in a browser

Typecheck and `next build` pass for these, but no browser run is recorded: the Mobility view, the Alerts view and the dashboard alert summary, the Itinerary view, and the "View invoice" link in the activity booking panel. Browser runs that exist: login and golden path (fixture events), trips, assistant (with and without fixture providers), invoices.

## 7. Reproducibility gaps

- `package.json` has no scripts for `validate-task-07.mjs`, `ui-golden-path.mjs` or the `ui-smoke-*.mjs` scripts. Run them with `node --env-file=.env.local scripts/<name>.mjs`.
- `npm run validate:task-09` runs without `--env-file=.env.local`, although its header says to use it.
- `npm run validate:task-02` and `validate:task-03` need `TASK02_*` and `TASK03_*` variables that nothing generates.
- `npm run bootstrap:local` rewrites `.env.local` and keeps only a fixed list of keys. Email variables (`EMAIL_PROVIDER`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`) and `CORS_ALLOWED_ORIGINS` are not in that list and are dropped on a second run.
- Most validators need an API process started from `apps/api/dist` and pointed to by `API_BASE_URL`.
- Browser scripts need `npx playwright install chromium`. Invoice tests and the Task 11 validator need `pdfinfo` and `pdftotext`.
