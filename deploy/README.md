# Deployment (app layer) — web, api, worker, Caddy

This directory packages the TravelFlow app layer as containers. **Nothing here has been deployed to Vultr.** Everything marked "verified locally" was run on a developer machine against the local Supabase CLI stack by `scripts/verify-deploy-local.sh`. Everything marked **NOT VERIFIED** has never run on a Vultr VM, with a real domain, or with HTTPS.

## Files

| File                                                    | Purpose                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile.api`, `Dockerfile.worker`, `Dockerfile.web` | Multi-stage images (Node 22 bookworm-slim, non-root `node` user, `npm ci` from the lockfile). Build context is the repository root. |
| `docker-compose.yml`                                    | App layer: `web`, `api`, `worker`, `caddy`. Joins the Docker network of a separate Supabase stack.                                  |
| `docker-compose.localtest.yml`                          | Override used only by the local verification script. Never use on a server.                                                         |
| `Caddyfile`                                             | HTTPS, security headers, routing, `/metrics` block.                                                                                 |
| `.env.production.example`                               | Every variable, documented, with no secret.                                                                                         |
| `preflight.mjs`, `healthcheck.mjs`                      | Fail-closed start gate and the container health probe.                                                                              |
| `../.dockerignore`                                      | Keeps `.env*`, `node_modules`, `dist`, `.next`, `supabase/`, `plan/`, `docs/` out of the build context.                             |
| `../scripts/verify-deploy-local.sh`                     | Local verification (`npm run verify:deploy-local`).                                                                                 |

## Architecture

```text
Internet ──80/443──> caddy ──/api/*, /health, /ready──> api:4000 ──> Supabase gateway (Docker network)
                       │                                  ▲
                       ├──/auth/v1/*─────────────────────────────> Supabase gateway (only this prefix)
                       └──everything else──> web:3000     │
                                                       worker (no port, polls jobs in Postgres)
```

- Only `caddy` publishes ports (80 and 443). `web`, `api`, and `worker` use `expose`/internal networks only.
- Networks: `edge` (caddy, web, api), `back` (api, worker), and the external Supabase network (api, worker, caddy). `api` and `worker` need outbound internet for the providers, so the networks are not `internal: true`.
- Browser sign-in goes to `https://SITE_ADDRESS/auth/v1/...`; Caddy forwards only that prefix to the Supabase gateway. REST, Storage, Realtime, and Studio are never reachable through Caddy (verified locally for REST and Storage).
- `/metrics` and `/api/v1/metrics` are answered `404` by Caddy before any proxying.
- All containers: `no-new-privileges`, all capabilities dropped (Caddy adds `NET_BIND_SERVICE` only), read-only root filesystem with a `tmpfs` at `/tmp`, JSON log rotation (10 MB × 5).

## Configuration policy (no fallback)

- Required values use `${NAME:?message}` in Compose: a missing `SITE_ADDRESS`, `SUPABASE_DOCKER_NETWORK`, `SUPABASE_AUTH_UPSTREAM`, or `NEXT_PUBLIC_*` stops `docker compose` with the message.
- `deploy/preflight.mjs` runs before `api` and `worker`. It exits `1` with a JSON error naming every problem when `NODE_ENV` is not `production`, a required variable is empty, a URL is invalid, or any `*_OVERRIDE` test hook is set. Provider keys that are empty are logged as `preflight.provider_not_configured`; list them in `DEPLOY_REQUIRED_ENV` to make them fatal.
- The web image build fails when a `NEXT_PUBLIC_*` build argument is missing.

### `NEXT_PUBLIC_*` are build-time values

Next.js inlines `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` into the browser bundle when the web image is built. Changing one requires `docker compose build web && docker compose up -d web`. They are public by design and appear in `docker history`. Never pass the service role key or any other secret as a build argument (the local script checks that the service role key is absent from image files, metadata, and history).

## Prerequisites on the VM

Status: **NOT VERIFIED on Vultr.**

1. Ubuntu 24.04 x86_64 (target profile in `plan/segments/09-infrastructure-security.md`: 8 vCPU, 16 GB RAM, 160 GB SSD; minimum 4 vCPU, 8 GB).
2. Docker Engine and the Compose plugin from the [official instructions](https://docs.docker.com/engine/install/ubuntu/). Local verification used Docker 29.8 and Compose v5.6; older Compose versions were not tested (the files use `${VAR:?message}`, `env_file` path interpolation, and `up --wait`).
3. A DNS `A` (and `AAAA` if used) record for the site name pointing to the VM before the first start, or Let's Encrypt issuance fails.
4. Git, and a non-root user in the `docker` group.

## Firewall and network exposure

Status: **NOT VERIFIED on Vultr.**

- Allow inbound only `22/tcp`, `80/tcp`, `443/tcp` (and `443/udp` if you want HTTP/3). Use the Vultr firewall group in front of the VM, and `ufw` on the host as a second layer:

  ```bash
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22/tcp
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw enable
  ```

- **Docker publishes ports around `ufw`.** A container port published with `-p`/`ports:` is reachable even when `ufw` denies it. This stack publishes only Caddy's 80/443, which is intended. The risk is the **Supabase stack**: according to the [official self-hosting docs](https://supabase.com/docs/guides/self-hosting/accessing-postgres) (read on 7 November 2026), the default compose publishes the Supavisor pooler on host ports `5432` (session) and `6543` (transaction), and the API gateway and Studio on `8000`. Before starting Supabase, edit its compose file so these ports are bound to `127.0.0.1` (for example `"127.0.0.1:5432:5432"`) or not published. This stack reaches the gateway over the Docker network and needs no host port.
- PostgreSQL must not be reachable from the internet. After starting everything, check from a **different** machine: `nc -zv <vm-ip> 5432`, `6543`, `8000`, `8443` must all fail. Record the result.
- Studio is served through the Supabase gateway with HTTP basic auth (`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`). Caddy never forwards it. Reach it with an SSH tunnel to the loopback-bound gateway port, for example `ssh -L 8000:127.0.0.1:8000 user@vm`, then open `http://127.0.0.1:8000`.

## Deployment order

Each step lists what is verified.

### 1. Supabase (separate stack)

**NOT VERIFIED on Vultr, and not reproduced locally.** Locally the stack is the Supabase CLI (`supabase start`), which is a different set of containers from the official self-hosted compose.

1. Follow the official guide [Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker) (manual installation: pinned git tag, `cp .env.example .env`, `sh utils/generate-keys.sh`, `sh utils/add-new-auth-keys.sh`, set a strong `DASHBOARD_PASSWORD`, `sh run.sh start`). Never start with the example placeholder secrets.
2. Set the URL variables for the same-origin layout used here: `SUPABASE_PUBLIC_URL` and `SITE_URL` to `https://<SITE_ADDRESS>`, and `API_EXTERNAL_URL` to `https://<SITE_ADDRESS>/auth/v1`. Add the site to the Auth redirect URLs. (Variable meanings are from the official docs; the exact values for this layout were not tested.)
3. Make the gateway ports loopback-only as described above, then `docker compose ps` until every service is `healthy`.
4. Find what this stack needs to join the Supabase network: `docker network ls` (name for `SUPABASE_DOCKER_NETWORK`) and `docker compose ps` in the Supabase directory (gateway service name and port for `SUPABASE_AUTH_UPSTREAM` and `SUPABASE_URL`). The official docs describe an Envoy gateway on port 8000 by default; local verification used the CLI's Kong container (`supabase_kong_vultr:8000`). **Use the names you see; do not copy the local ones.**
5. **Key format check (open question).** The app reads `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` and was tested only with the JWT-style keys of the local CLI. The current official self-hosted stack documents new-style publishable/secret keys (`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`) next to the legacy JWT keys ([Configure new API keys](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys)). Confirm that the app signs in and that the API accepts the user's token with the keys you choose before the demo.

### 2. Migrations (after Supabase is healthy)

**NOT VERIFIED on Vultr.** Locally, migrations are applied by `supabase db reset --yes`, which this task did not run.

Migrations are forward-only SQL files in `supabase/migrations/`, applied in file-name order `0001` to `0010`. Apply them after the Supabase stack is healthy because `0010` inserts into `storage.buckets`, and that table exists only after the Storage service has started once.

Option A, Supabase CLI over a direct database connection:

```bash
supabase db push --db-url "postgresql://postgres:<password>@127.0.0.1:5432/postgres"
```

(The default stack exposes only the pooler; a pooled user is `postgres.<POOLER_TENANT_ID>`. Run this on the VM or through an SSH tunnel, never over the public internet.)

Option B, plain files in order:

```bash
for file in supabase/migrations/*.sql; do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$file" || break
done
```

Take a backup first (next section). Stop at the first error; do not start the app on a partial schema. Verify afterwards that every application table has RLS enabled (`select relname from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace and not relrowsecurity;` must return no application table).

The demo user and seed (`npm run bootstrap:local`, `supabase/seed.sql`) are local tooling. How to create the demo user on the server is **not scripted yet**.

### 3. Configure and start the app layer

Verified locally with the CLI stack and `SITE_ADDRESS=:8088`. **NOT VERIFIED** with a real domain.

```bash
cd deploy
cp .env.production.example .env.production
chmod 600 .env.production            # fill in every empty value
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d --wait --wait-timeout 180
```

Quote values containing `$` or `#` with single quotes. `up --wait` exits non-zero if any service with a healthcheck does not become healthy. Caddy starts only after `web` and `api` are healthy (verified locally).

### 4. Check readiness

```bash
docker compose --env-file .env.production ps
curl -fsS https://<SITE_ADDRESS>/health
curl -fsS https://<SITE_ADDRESS>/ready      # endpoint not in apps/api yet; see "Readiness" below
curl -sI  https://<SITE_ADDRESS>/metrics    # must be 404
```

Then sign in in the browser, and run the golden path from `docs/demo-script.md`.

## Readiness and "deployment failed means not ready"

- **Verified locally:** with `SUPABASE_SERVICE_ROLE_KEY` missing, the `api` container exits `1` with `preflight.failed` naming the variable, `docker compose up --wait` exits non-zero, and `caddy` is never started, so no public entry point exists.
- `api` healthcheck: `GET /health` by default (process liveness only; it does not check Supabase). Set `API_HEALTHCHECK_PATH=/ready` in `.env.production` once the API serves `GET /ready` with dependency checks. `/ready` did **not exist** in `apps/api/src` when this was written, so it was not tested.
- `worker` has no HTTP port and therefore no Docker healthcheck. Its signals are the log events `worker.started` (verified), `worker.poll_failed`, and `scheduler.tick_failed`. A worker that cannot reach the database keeps running and logs those errors every poll interval (observed locally); it does not turn the stack unhealthy. Watch for them (see Logs).
- A failed deployment is not repaired automatically. Fix the cause, rerun `up -d --wait`. There is no fallback to a hosted Supabase or another provider.

## Logs and health

```bash
docker compose --env-file .env.production logs -f api          # JSON lines, one event per line
docker compose --env-file .env.production logs --since 10m worker
docker compose --env-file .env.production logs api | grep -F '"level":"error"'
docker compose --env-file .env.production logs api | grep -F '<request-id>'
docker inspect --format '{{json .State.Health}}' "$(docker compose --env-file .env.production ps -q api)"
```

Responses carry `x-request-id`; the same id appears in the API log. Logs are written by Docker's `json-file` driver and rotated at 10 MB × 5 files per container. They are not shipped anywhere.

## Backup, restore, and rollback

**NOT VERIFIED.** No backup or restore was run in this task (the local database holds shared development data).

Backup before every migration or release:

```bash
# in the Supabase project directory; service name "db" comes from the official compose
docker compose exec -T db pg_dump -U postgres -Fc postgres > /var/backups/travelflow-$(date +%Y%m%d-%H%M%S).dump
```

Copy the dump off the VM (different location from the database volume) and keep the Storage volume (invoice PDFs) in the backup scope.

Rollback checklist:

1. Stop the new app layer: `docker compose --env-file .env.production stop api worker web`.
2. Application-only problem (no migration ran): set `IMAGE_TAG` to the previous tag, `docker compose --env-file .env.production up -d --wait`. Keep the previous images (tag every release, for example `IMAGE_TAG=2026-11-08-1`).
3. A migration ran and must be undone: migrations are forward-only. Restore the pre-release dump into a **scratch** database first and check it (`pg_restore --list`, row counts, RLS), then restore over the live database (`pg_restore --clean --if-exists -d postgres`), then start the previous image tag.
4. Run readiness (step 4), then a login and a trip read.
5. Record what failed, the request IDs, and the restored backup file name.

Restore verification (acceptance criterion "backup can be restored in a test environment") still has to be performed on the VM or a scratch host.

## Secret rotation

**NOT VERIFIED.**

- Provider keys (`VULTR_INFERENCE_API_KEY`, `BRIGHT_DATA_API_KEY`, `HERE_API_KEY`, `OPENWEATHER_API_KEY`, `EMAIL_PROVIDER_API_KEY`): revoke at the provider, edit `.env.production`, then `docker compose --env-file .env.production up -d --force-recreate api worker` (env files are read only at container creation).
- Supabase keys: regenerate with the Supabase scripts (`utils/generate-keys.sh`, `utils/add-new-auth-keys.sh`), restart the Supabase stack, update `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, **rebuild the web image** (the anon key is baked in), and recreate `api` and `worker`. Changing the JWT secret signs every user out.
- After any rotation run the secret scan and confirm the old value appears in no log: `docker compose logs | grep -F '<old value>'`.

## Local verification (this machine only)

```bash
npm run verify:deploy-local        # or: bash scripts/verify-deploy-local.sh
```

Prerequisites: Docker, the Supabase CLI stack running (`supabase start`) and `.env.local` from `npm run bootstrap:local`, host ports 8088 and 8449 free. It builds the three images, runs Compose project `tfdeploytest` with `SITE_ADDRESS=:8088` (plain HTTP, ports bound to `127.0.0.1`), checks the items below, and removes the project (`down -v`). It reads keys from `.env.local` into a private temp file and never prints them. It does not touch Vultr, `ssh`, or the public network.

By default the worker is pointed at an unreachable address because the local database has queued background jobs that a live worker would process. So the script proves the worker image starts but **not** that the worker works against a database. `TF_VERIFY_WORKER_WITH_DB=1` lets the worker use the real local database. `TF_REMOVE_IMAGES=1` deletes the test images afterwards.

Checked: image builds and sizes, `compose up --wait`, `/health` through Caddy, `/ready` (skipped while absent), web 200 plus the login page rendered in headless Chromium, Supabase Auth through Caddy, REST/Storage not exposed, `/metrics` variants blocked, security headers, `worker.started`, no database port published, only Caddy publishes ports (loopback), non-root users, read-only root filesystems, no `.env` files or service role key in images, fail-closed behaviour (no config, `*_OVERRIDE`, wrong `NODE_ENV`, missing build args, missing `SITE_ADDRESS`), and "failed api config means caddy never starts".

## Not verified (needs Vultr, a domain, or real HTTPS)

- Everything on a Vultr VM: provisioning, Docker install, firewall rules, outside-in port scan.
- Let's Encrypt issuance and renewal, HSTS over real HTTPS, the HTTP-to-HTTPS redirect, HTTP/3.
- Supabase official self-hosted stack: install, gateway/network names, key format, URL variables, Auth redirect URLs, Studio protection.
- Migrations against the self-hosted database, RLS check on the deployed API, storage bucket policy.
- Backup, restore, rollback, secret rotation procedures.
- `/ready` and `/metrics` (not implemented in `apps/api` at the time of writing).
- Worker against a database inside containers (skipped on purpose locally).
- Golden path, provider connectivity (Bright Data, Vultr Inference, HERE, OpenWeather, email) from the containers, load and memory use.
- Content-Security-Policy beyond `frame-ancestors`: Next.js inline scripts need a nonce-based policy that has not been designed.
