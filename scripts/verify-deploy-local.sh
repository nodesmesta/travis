#!/usr/bin/env bash

# Local verification of the deployment artifacts (deploy/). Task 12.
#
# What it does: builds the web, api, and worker images, starts the app-layer
# Compose project "tfdeploytest" against the LOCAL Supabase stack that is
# already running (Supabase CLI), runs the checks below, then removes
# everything it created. It never touches Vultr, ssh, or a public network:
# the only published ports are bound to 127.0.0.1.
#
# Secrets: keys are read from .env.local, written to a private temp file
# (mode 600) and never printed. The temp directory is deleted on exit.
#
# Shared-database safety: the local database has queued background jobs. A
# worker that can reach it would process them. By default the worker is
# pointed at an unreachable address (see deploy/docker-compose.localtest.yml),
# so this script verifies that the worker image starts, but NOT the worker's
# database access. Set TF_VERIFY_WORKER_WITH_DB=1 to let it use the real database.
#
# Environment:
#   TF_VERIFY_WORKER_WITH_DB=1  let the worker use the local database
#   TF_REMOVE_IMAGES=1          remove the test images at the end
#   TF_HTTP_PORT (default 8088) and TF_HTTPS_PORT (default 8449): loopback ports
#
# No regular expressions (plan/tasks/CONVENTIONS.md): case globs and grep -F only.

set -u -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="tfdeploytest"
TAG="tfdeploytest"
HTTP_PORT="${TF_HTTP_PORT:-8088}"
HTTPS_PORT="${TF_HTTPS_PORT:-8449}"
BASE="http://127.0.0.1:${HTTP_PORT}"
COMPOSE_FILE="$ROOT/deploy/docker-compose.yml"
LOCALTEST_FILE="$ROOT/deploy/docker-compose.localtest.yml"

pass_count=0
fail_count=0
skip_count=0

pass() {
  printf 'PASS: %s\n' "$1"
  pass_count=$((pass_count + 1))
}

fail() {
  printf 'FAIL: %s\n' "$1"
  fail_count=$((fail_count + 1))
}

skip() {
  printf 'SKIP: %s\n' "$1"
  skip_count=$((skip_count + 1))
}

note() {
  printf '  %s\n' "$1"
}

TMP_DIR=""
ENV_FILE=""
BROKEN_ENV_FILE=""
OVERRIDE_ARGS=()

# env_value FILE NAME: print the value of NAME=value from an env file (quotes removed).
env_value() {
  local file="$1" name="$2" line value
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$name="*)
        value="${line#"$name="}"
        case "$value" in
          \"*\") value="${value#\"}"; value="${value%\"}" ;;
          \'*\') value="${value#\'}"; value="${value%\'}" ;;
        esac
        printf '%s' "$value"
        return 0
        ;;
    esac
  done <"$file"
  return 1
}

compose() {
  local env_file="$1"
  shift
  APP_ENV_FILE="$env_file" docker compose -p "$PROJECT" --env-file "$env_file" \
    -f "$COMPOSE_FILE" "${OVERRIDE_ARGS[@]}" "$@"
}

cleanup() {
  if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
    compose "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1
  fi
  if [[ "${TF_REMOVE_IMAGES:-0}" == "1" ]]; then
    docker image rm "travelflow/web:$TAG" "travelflow/api:$TAG" "travelflow/worker:$TAG" >/dev/null 2>&1
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

http_code() {
  curl -s -o /dev/null -m 15 -w '%{http_code}' "$@"
}

finish() {
  printf '\nSummary: %d PASS, %d FAIL, %d SKIP\n' "$pass_count" "$fail_count" "$skip_count"
  if [[ "$fail_count" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

abort() {
  fail "$1"
  finish
}

printf '== Preconditions ==\n'

for tool in docker curl supabase; do
  command -v "$tool" >/dev/null 2>&1 || abort "required tool not found: $tool"
done

[[ -f "$ROOT/.env.local" ]] || abort ".env.local not found (run npm run bootstrap:local first)"

project_id=""
while IFS= read -r line; do
  case "$line" in
    "project_id = \""*)
      project_id="${line#project_id = \"}"
      project_id="${project_id%%\"*}"
      break
      ;;
  esac
done <"$ROOT/supabase/config.toml"
[[ -n "$project_id" ]] || abort "project_id not found in supabase/config.toml"

SUPABASE_NETWORK="supabase_network_${project_id}"
KONG_CONTAINER="supabase_kong_${project_id}"

status_output="$(cd "$ROOT" && supabase status -o env 2>/dev/null)"
if [[ -z "$status_output" ]]; then
  abort "local Supabase is not running (supabase status returned nothing)"
fi
status_api_url=""
status_anon_key=""
status_service_key=""
while IFS= read -r line; do
  case "$line" in
    API_URL=*) status_api_url="${line#API_URL=}"; status_api_url="${status_api_url//\"/}" ;;
    ANON_KEY=*) status_anon_key="${line#ANON_KEY=}"; status_anon_key="${status_anon_key//\"/}" ;;
    SERVICE_ROLE_KEY=*) status_service_key="${line#SERVICE_ROLE_KEY=}"; status_service_key="${status_service_key//\"/}" ;;
  esac
done <<<"$status_output"
[[ -n "$status_api_url" ]] || abort "supabase status did not report API_URL"

anon_key="$(env_value "$ROOT/.env.local" SUPABASE_ANON_KEY)" || abort "SUPABASE_ANON_KEY missing in .env.local"
service_key="$(env_value "$ROOT/.env.local" SUPABASE_SERVICE_ROLE_KEY)" || abort "SUPABASE_SERVICE_ROLE_KEY missing in .env.local"
local_url="$(env_value "$ROOT/.env.local" SUPABASE_URL)" || abort "SUPABASE_URL missing in .env.local"

if [[ "$local_url" == "$status_api_url" && "$anon_key" == "$status_anon_key" && "$service_key" == "$status_service_key" ]]; then
  pass "pre: .env.local URL and keys match the running local Supabase ($status_api_url)"
else
  abort "pre: .env.local does not match 'supabase status' (URL or keys differ); run npm run bootstrap:local"
fi

docker network inspect "$SUPABASE_NETWORK" >/dev/null 2>&1 || abort "Docker network $SUPABASE_NETWORK not found"
docker inspect "$KONG_CONTAINER" >/dev/null 2>&1 || abort "container $KONG_CONTAINER not found"

for port in "$HTTP_PORT" "$HTTPS_PORT"; do
  if port_in_use "$port"; then
    abort "pre: host port $port is already in use; set TF_HTTP_PORT / TF_HTTPS_PORT"
  fi
done

if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]]; then
  abort "pre: containers of compose project $PROJECT already exist; remove them first"
fi

TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
ENV_FILE="$TMP_DIR/env.production"
BROKEN_ENV_FILE="$TMP_DIR/env.broken"

write_env() {
  local target="$1"
  umask 077
  {
    printf 'NODE_ENV=production\n'
    printf 'LOG_LEVEL=info\n'
    printf 'IMAGE_TAG=%s\n' "$TAG"
    printf 'SITE_ADDRESS=:%s\n' "$HTTP_PORT"
    printf 'CADDY_HTTP_PUBLISH=127.0.0.1:%s:%s\n' "$HTTP_PORT" "$HTTP_PORT"
    printf 'CADDY_HTTPS_PUBLISH=127.0.0.1:%s:443\n' "$HTTPS_PORT"
    printf 'SUPABASE_DOCKER_NETWORK=%s\n' "$SUPABASE_NETWORK"
    printf 'SUPABASE_AUTH_UPSTREAM=%s:8000\n' "$KONG_CONTAINER"
    printf 'SUPABASE_URL=http://%s:8000\n' "$KONG_CONTAINER"
    printf 'SUPABASE_ANON_KEY=%s\n' "$anon_key"
    if [[ "$2" == "complete" ]]; then
      printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "$service_key"
    fi
    printf 'NEXT_PUBLIC_API_BASE_URL=%s/api/v1\n' "$BASE"
    printf 'NEXT_PUBLIC_SUPABASE_URL=%s\n' "$BASE"
    printf 'NEXT_PUBLIC_SUPABASE_ANON_KEY=%s\n' "$anon_key"
    printf 'CORS_ALLOWED_ORIGINS=%s\n' "$BASE"
    printf 'LOCALTEST_WORKER_SUPABASE_URL=http://127.0.0.1:9\n'
  } >"$target"
  chmod 600 "$target"
}

write_env "$ENV_FILE" complete
write_env "$BROKEN_ENV_FILE" missing-service-key

if [[ "${TF_VERIFY_WORKER_WITH_DB:-0}" == "1" ]]; then
  note "TF_VERIFY_WORKER_WITH_DB=1: the worker will use the real local database and may process queued jobs"
  OVERRIDE_ARGS=()
else
  OVERRIDE_ARGS=(-f "$LOCALTEST_FILE")
fi

printf '\n== Build images ==\n'
if compose "$ENV_FILE" build; then
  pass "build: web, api, and worker images built"
else
  abort "build: docker compose build failed"
fi
docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | grep -F "travelflow/" | grep -F ":$TAG"

printf '\n== Start stack (project %s) ==\n' "$PROJECT"
if compose "$ENV_FILE" up -d --wait --wait-timeout 240; then
  pass "start: compose up --wait finished, every service with a healthcheck is healthy"
else
  fail "start: compose up --wait failed"
  compose "$ENV_FILE" ps
  compose "$ENV_FILE" logs --tail 30
  finish
fi
compose "$ENV_FILE" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

printf '\n== HTTP checks through Caddy (%s) ==\n' "$BASE"

health_body="$(curl -s -m 15 "$BASE/health")"
health_code="$(http_code "$BASE/health")"
if [[ "$health_code" == "200" && "$health_body" == *'"ok"'* ]]; then
  pass "api /health through Caddy returned 200 with status ok"
else
  fail "api /health through Caddy returned $health_code"
fi

ready_code="$(http_code "$BASE/ready")"
case "$ready_code" in
  200) pass "api /ready returned 200" ;;
  404) skip "api /ready returned 404: the endpoint is not in apps/api yet, only /health was checked" ;;
  *) fail "api /ready returned $ready_code" ;;
esac

web_body="$(curl -s -m 15 "$BASE/")"
web_code="$(http_code "$BASE/")"
if [[ "$web_code" == "200" && "$web_body" == *"Checking your session"* ]]; then
  pass "web / returned 200 (server HTML is the session-check shell; the page is client-rendered)"
else
  fail "web / returned $web_code or unexpected HTML"
fi

# The login form only exists after the browser bundle runs, so use headless Chromium.
if [[ -d "$ROOT/node_modules/playwright" ]] && command -v node >/dev/null 2>&1; then
  login_out="$(cd "$ROOT" && node scripts/verify-deploy-login.mjs "$BASE" 2>&1)"
  login_code=$?
  if [[ "$login_code" == "0" ]]; then
    pass "web login page renders in headless Chromium through Caddy ($login_out)"
  else
    fail "web login page did not render in headless Chromium: $login_out"
  fi
else
  skip "web login page not checked in a browser (playwright is not installed); only the HTTP 200 shell was checked"
fi

auth_code="$(http_code -H "apikey: $anon_key" "$BASE/auth/v1/health")"
if [[ "$auth_code" == "200" ]]; then
  pass "Supabase Auth reachable through Caddy at /auth/v1/health (200)"
else
  fail "Supabase Auth through Caddy returned $auth_code"
fi

rest_code="$(http_code -H "apikey: $anon_key" "$BASE/rest/v1/")"
storage_code="$(http_code -H "apikey: $anon_key" "$BASE/storage/v1/bucket")"
if [[ "$rest_code" != "200" && "$storage_code" != "200" ]]; then
  pass "Supabase REST and Storage are not exposed through Caddy (rest=$rest_code storage=$storage_code)"
else
  fail "Supabase REST or Storage is exposed through Caddy (rest=$rest_code storage=$storage_code)"
fi

metrics_ok=1
for path in /metrics /metrics/ /METRICS /metrics/x /api/v1/metrics; do
  code="$(http_code --path-as-is "$BASE$path")"
  body="$(curl -s --path-as-is -m 15 "$BASE$path")"
  if [[ "$code" != "404" || "$body" != "Not Found" ]]; then
    fail "metrics blocked at Caddy: $path returned $code"
    metrics_ok=0
  fi
done
if [[ "$metrics_ok" == "1" ]]; then
  pass "/metrics, /metrics/, /METRICS, /metrics/x, /api/v1/metrics are answered 404 by Caddy itself"
fi
encoded_code="$(http_code --path-as-is "$BASE/%6Detrics")"
encoded_body="$(curl -s --path-as-is -m 15 "$BASE/%6Detrics")"
if [[ "$encoded_code" == "404" && "$encoded_body" == "Not Found" ]]; then
  pass "percent-encoded /%6Detrics is blocked by Caddy as well"
else
  note "info: /%6Detrics returned $encoded_code (not blocked by the Caddy matcher; it is forwarded to web, which has no such route)"
fi

headers="$(curl -s -D - -o /dev/null -m 15 "$BASE/")"
headers_lower="${headers,,}"
missing=""
for header in "strict-transport-security:" "x-content-type-options: nosniff" "referrer-policy:" "x-frame-options:" "content-security-policy: frame-ancestors"; do
  case "$headers_lower" in
    *"$header"*) ;;
    *) missing="$missing $header" ;;
  esac
done
if [[ -z "$missing" ]]; then
  pass "security headers present (HSTS, nosniff, referrer-policy, x-frame-options, CSP frame-ancestors)"
else
  fail "security headers missing:$missing"
fi
case "$headers_lower" in
  *"server: caddy"*) fail "Server header is still sent" ;;
  *) pass "Server header removed" ;;
esac

printf '\n== Container checks ==\n'

worker_logs="$(compose "$ENV_FILE" logs --no-color worker 2>&1)"
if [[ "$worker_logs" == *'"worker.started"'* || "$worker_logs" == *'worker.started'* ]]; then
  pass "worker log contains worker.started"
else
  fail "worker log does not contain worker.started"
  note "$(printf '%s' "$worker_logs" | tail -n 8)"
fi
if [[ "${TF_VERIFY_WORKER_WITH_DB:-0}" != "1" ]]; then
  skip "worker database access NOT verified (worker pointed at an unreachable address to protect the shared local database)"
  note "worker log tail (shows how the worker reports an unreachable database):"
  printf '%s\n' "$worker_logs" | tail -n 6 | cut -c1-230 | while IFS= read -r line; do note "$line"; done
fi

published_bad=0
db_port_published=0
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  name="${line%% *}"
  ports="${line#* }"
  case "$ports" in
    *5432*|*54322*|*55422*) db_port_published=1 ;;
  esac
  case "$name" in
    *caddy*) ;;
    *)
      case "$ports" in
        *"->"*) published_bad=1; note "service publishes a port: $line" ;;
      esac
      ;;
  esac
done < <(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Ports}}')
if [[ "$db_port_published" == "0" ]]; then
  pass "no database port (5432) is published by the compose project"
else
  fail "a database port is published by the compose project"
fi
if [[ "$published_bad" == "0" ]]; then
  pass "only caddy publishes ports (web, api, worker are internal)"
else
  fail "a service other than caddy publishes a port"
fi
caddy_ports="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=caddy" --format '{{.Ports}}')"
case "$caddy_ports" in
  *"0.0.0.0"*|*"[::]"*) fail "caddy published on a non-loopback address: $caddy_ports" ;;
  *"127.0.0.1:$HTTP_PORT"*) pass "caddy ports are bound to 127.0.0.1 only (local test): $caddy_ports" ;;
  *) fail "unexpected caddy port mapping: $caddy_ports" ;;
esac

for service in web api worker; do
  uid="$(compose "$ENV_FILE" exec -T "$service" id -u 2>/dev/null)"
  if [[ -n "$uid" && "$uid" != "0" ]]; then
    pass "$service container runs as non-root (uid $uid)"
  else
    fail "$service container does not run as a non-root user (uid '$uid')"
  fi
done

for service in web api worker; do
  state="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$(compose "$ENV_FILE" ps -q "$service")" 2>/dev/null)"
  if [[ "$state" == "true" ]]; then
    pass "$service root filesystem is read-only"
  else
    fail "$service root filesystem is writable"
  fi
done

printf '\n== Images carry no secrets ==\n'
for service in web api worker; do
  image="travelflow/$service:$TAG"
  found_env="$(docker run --rm --network none --entrypoint sh "$image" -c 'find / -xdev -name ".env*" -not -path "/proc/*" 2>/dev/null')"
  if [[ -z "$found_env" ]]; then
    pass "$service image contains no .env files"
  else
    fail "$service image contains env files: $found_env"
  fi
  leaked="$(SECRET_PROBE="$service_key" docker run --rm --network none -e SECRET_PROBE --entrypoint sh "$image" -c 'grep -r -l -F -- "$SECRET_PROBE" /app 2>/dev/null')"
  if [[ -z "$leaked" ]]; then
    pass "$service image does not contain the service role key"
  else
    fail "$service image contains the service role key in: $leaked"
  fi
  env_dump="$(docker image inspect --format '{{json .Config.Env}}' "$image")"
  if [[ "$env_dump" == *"$service_key"* ]]; then
    fail "$service image metadata (Config.Env) contains the service role key"
  else
    pass "$service image metadata does not contain the service role key"
  fi
done
history_dump="$(docker history --no-trunc "travelflow/web:$TAG" 2>&1)"
if [[ "$history_dump" == *"$service_key"* ]]; then
  fail "web image history contains the service role key"
else
  pass "web image history does not contain the service role key (build args are public values only)"
fi
runtime_env="$(compose "$ENV_FILE" exec -T web env 2>/dev/null)"
if [[ "$runtime_env" == *"SUPABASE_SERVICE_ROLE_KEY"* ]]; then
  fail "web container environment contains SUPABASE_SERVICE_ROLE_KEY"
else
  pass "web container environment has no SUPABASE_SERVICE_ROLE_KEY"
fi

printf '\n== Fail-closed configuration ==\n'

empty_out="$(docker run --rm --network none "travelflow/api:$TAG" 2>&1)"
empty_code=$?
if [[ "$empty_code" == "1" && "$empty_out" == *"preflight.failed"* && "$empty_out" == *"SUPABASE_URL"* ]]; then
  pass "api container with no configuration exits 1 and names the missing variables"
else
  fail "api container with no configuration did not fail closed (exit $empty_code)"
fi

override_out="$(docker run --rm --network none -e NODE_ENV=production -e SUPABASE_URL=http://example.invalid -e SUPABASE_ANON_KEY=dummy -e SUPABASE_SERVICE_ROLE_KEY=dummy -e CORS_ALLOWED_ORIGINS=http://example.invalid -e HERE_BASE_URL_OVERRIDE=http://example.invalid "travelflow/api:$TAG" 2>&1)"
override_code=$?
if [[ "$override_code" == "1" && "$override_out" == *"HERE_BASE_URL_OVERRIDE"* ]]; then
  pass "api container rejects a *_OVERRIDE test hook in production"
else
  fail "api container accepted a *_OVERRIDE variable (exit $override_code)"
fi

devmode_out="$(docker run --rm --network none -e NODE_ENV=development -e SUPABASE_URL=http://example.invalid -e SUPABASE_ANON_KEY=dummy -e SUPABASE_SERVICE_ROLE_KEY=dummy -e CORS_ALLOWED_ORIGINS=http://example.invalid "travelflow/worker:$TAG" 2>&1)"
devmode_code=$?
if [[ "$devmode_code" == "1" && "$devmode_out" == *"NODE_ENV"* ]]; then
  pass "worker container refuses to start when NODE_ENV is not production"
else
  fail "worker container started with NODE_ENV=development (exit $devmode_code)"
fi

web_build_out="$(docker build -f "$ROOT/deploy/Dockerfile.web" -t "travelflow/web:${TAG}-noargs" "$ROOT" 2>&1)"
web_build_code=$?
if [[ "$web_build_code" != "0" && "$web_build_out" == *"--build-arg NEXT_PUBLIC_API_BASE_URL is required"* ]]; then
  pass "web image build fails with a clear message when NEXT_PUBLIC_* build args are missing"
else
  fail "web image build did not fail on missing NEXT_PUBLIC_* build args (exit $web_build_code)"
  docker image rm "travelflow/web:${TAG}-noargs" >/dev/null 2>&1
fi

nosite_env="$TMP_DIR/env.nosite"
: >"$nosite_env"
while IFS= read -r line; do
  case "$line" in
    SITE_ADDRESS=*) ;;
    *) printf '%s\n' "$line" >>"$nosite_env" ;;
  esac
done <"$ENV_FILE"
chmod 600 "$nosite_env"
config_out="$(compose "$nosite_env" config 2>&1)"
config_code=$?
if [[ "$config_code" != "0" && "$config_out" == *"SITE_ADDRESS"* ]]; then
  pass "compose refuses to run without SITE_ADDRESS and says so"
else
  fail "compose accepted a missing SITE_ADDRESS (exit $config_code)"
fi

printf '\n== Failed deployment must not become ready ==\n'
compose "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1
broken_out="$(compose "$BROKEN_ENV_FILE" up -d --wait --wait-timeout 60 2>&1)"
broken_code=$?
caddy_running="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=caddy" --filter status=running -q)"
api_logs="$(compose "$BROKEN_ENV_FILE" logs --no-color api 2>&1)"
if [[ "$broken_code" != "0" ]]; then
  pass "compose up --wait fails when api configuration is incomplete (exit $broken_code)"
else
  fail "compose up --wait succeeded with SUPABASE_SERVICE_ROLE_KEY missing"
fi
if [[ -z "$caddy_running" ]]; then
  pass "caddy (the public entry point) was not started while api was not healthy"
else
  fail "caddy is running although api never became healthy"
fi
if [[ "$api_logs" == *"preflight.failed"* && "$api_logs" == *"SUPABASE_SERVICE_ROLE_KEY"* ]]; then
  pass "api log explains the failure (preflight.failed names SUPABASE_SERVICE_ROLE_KEY)"
else
  fail "api log has no clear diagnostic for the missing key"
  note "$(printf '%s' "$api_logs" | tail -n 5)"
fi
compose "$BROKEN_ENV_FILE" down -v --remove-orphans >/dev/null 2>&1

printf '\n== Cleanup ==\n'
leftover="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
if [[ -z "$leftover" ]]; then
  pass "no containers of project $PROJECT remain"
else
  fail "containers of project $PROJECT remain"
fi
note "images kept (set TF_REMOVE_IMAGES=1 to delete): $(docker image ls --format '{{.Repository}}:{{.Tag}}={{.Size}}' | grep -F "travelflow/" | grep -F ":$TAG" | tr '\n' ' ')"

finish
