#!/usr/bin/env bash

# One-shot provider smoke test for the Jakarta demo scenario.
# This script performs no retry, provider switching, or fallback.
set -uo pipefail

failures=0

fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

pass() {
  printf 'PASS: %s\n' "$1"
}

blocked() {
  printf 'BLOCKED: %s\n' "$1"
}

report_api_error() {
  local label="$1"
  local payload="$2"

  if [[ -z "$payload" ]]; then
    printf '  %s diagnostic: empty response or network/HTTP failure\n' "$label"
    return
  fi

  python3 -c '
import json
import sys

label = sys.argv[1]
raw = sys.stdin.read()
try:
    data = json.loads(raw)
    error = data.get("error") or {}
    status = data.get("status") or error.get("status") or data.get("cod") or "unknown"
    code = error.get("code", "unknown")
    message = error.get("message") or data.get("error_message") or data.get("message") or "unknown"
    print(f"  {label} diagnostic: status={status}; code={code}; message={message}")
except Exception:
    print(f"  {label} diagnostic: response was not readable JSON")
' "$label" <<< "$payload"
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    blocked "$name is not set"
    failures=$((failures + 1))
    return 1
  fi
  return 0
}

printf 'Provider smoke test: Jakarta demo scenario\n'
printf 'Primary location/mobility provider: HERE\n'
printf 'No automatic retry, provider switching, or fallback is used.\n\n'

HERE_READY=1
OPENWEATHER_READY=1
BRIGHT_DATA_READY=1
VULTR_INFERENCE_READY=1

require_env HERE_API_KEY || HERE_READY=0
require_env OPENWEATHER_API_KEY || OPENWEATHER_READY=0
require_env BRIGHT_DATA_API_KEY || BRIGHT_DATA_READY=0
require_env BRIGHT_DATA_SERP_ZONE || BRIGHT_DATA_READY=0
require_env VULTR_INFERENCE_API_KEY || VULTR_INFERENCE_READY=0

# Approximate coordinates are used only for this smoke test. Production requests
# must use coordinates returned by the HERE geocoding gateway.
HOTEL_LAT='-6.1954'
HOTEL_LON='106.8230'
JCC_LAT='-6.2147'
JCC_LON='106.8097'
DEPARTURE='2026-11-12T07:45:00+07:00'

if [[ "$HERE_READY" -eq 1 ]]; then
  here_geocode_response="$(curl --silent --show-error --fail \
    --get \
    --data-urlencode 'q=Jakarta Convention Center, Jakarta' \
    --data-urlencode 'lang=en-US' \
    --data-urlencode 'in=countryCode:IDN' \
    --data-urlencode "apiKey=${HERE_API_KEY}" \
    'https://geocode.search.hereapi.com/v1/geocode' 2>/dev/null)" || here_geocode_response=''

  if [[ "$here_geocode_response" == *'"items"'* ]]; then
    pass 'HERE geocoding'
  else
    fail 'HERE geocoding did not return items'
    report_api_error 'HERE geocoding' "$here_geocode_response"
  fi

  here_route_response="$(curl --silent --show-error \
    --get \
    --data-urlencode 'transportMode=car' \
    --data-urlencode "origin=${HOTEL_LAT},${HOTEL_LON}" \
    --data-urlencode "destination=${JCC_LAT},${JCC_LON}" \
    --data-urlencode "departureTime=${DEPARTURE}" \
    --data-urlencode 'traffic[mode]=default' \
    --data-urlencode 'return=summary,travelSummary' \
    --data-urlencode "apiKey=${HERE_API_KEY}" \
    'https://router.hereapi.com/v8/routes' 2>/dev/null)" || here_route_response=''

  if [[ "$here_route_response" == *'"routes"'* && "$here_route_response" == *'"duration"'* ]]; then
    pass 'HERE traffic-aware road route'
  else
    fail 'HERE traffic-aware road route did not return route duration'
    report_api_error 'HERE traffic-aware road route' "$here_route_response"
  fi

  here_transit_response="$(curl --silent --show-error --fail \
    --get \
    --data-urlencode "origin=${HOTEL_LAT},${HOTEL_LON}" \
    --data-urlencode "destination=${JCC_LAT},${JCC_LON}" \
    --data-urlencode "departureTime=${DEPARTURE}" \
    --data-urlencode 'alternatives=2' \
    --data-urlencode "apiKey=${HERE_API_KEY}" \
    'https://intermodal.router.hereapi.com/v8/routes' 2>/dev/null)" || here_transit_response=''

  if [[ "$here_transit_response" == *'"routes"'* ]]; then
    pass 'HERE intermodal/public transit route'
  else
    fail 'HERE intermodal/public transit route did not return a route; verify Jakarta transit coverage and API access'
    report_api_error 'HERE intermodal/public transit route' "$here_transit_response"
  fi

  here_traffic_response="$(curl --silent --show-error --fail \
    --get \
    --data-urlencode "in=circle:${JCC_LAT},${JCC_LON};r=2000" \
    --data-urlencode 'locationReferencing=olr' \
    --data-urlencode "apiKey=${HERE_API_KEY}" \
    'https://data.traffic.hereapi.com/v7/flow' 2>/dev/null)" || here_traffic_response=''

  if [[ -n "$here_traffic_response" && "$here_traffic_response" == \{* ]]; then
    pass 'HERE traffic flow'
  else
    fail 'HERE traffic flow did not return a JSON response'
    report_api_error 'HERE traffic flow' "$here_traffic_response"
  fi
fi

if [[ "$OPENWEATHER_READY" -eq 1 ]]; then
  # No --fail: OpenWeather explains refusals (for example a missing One Call
  # subscription) in the response body, and that reason must stay visible.
  weather_response="$(curl --silent --show-error \
    --get \
    --data-urlencode "lat=${JCC_LAT}" \
    --data-urlencode "lon=${JCC_LON}" \
    --data-urlencode 'exclude=minutely,daily,alerts' \
    --data-urlencode 'units=metric' \
    --data-urlencode "appid=${OPENWEATHER_API_KEY}" \
    'https://api.openweathermap.org/data/3.0/onecall' 2>/dev/null)" || weather_response=''

  if [[ "$weather_response" == *'"hourly"'* && "$weather_response" == *'"current"'* ]]; then
    pass 'OpenWeather current and hourly forecast'
  else
    fail 'OpenWeather did not return current and hourly forecast'
    report_api_error 'OpenWeather' "$weather_response"
  fi
fi

if [[ "$BRIGHT_DATA_READY" -eq 1 ]]; then
  # Full JSON is the decided format. The zone default is not relied on: the
  # request asks for parsed JSON explicitly (format raw + brd_json=1).
  # Bright Data reports many failures (captcha, denylisted IP, expect_element)
  # as HTTP 200 with an empty body, so the reason is read from response headers.
  bright_data_target='https://www.google.com/search?q=events+near+Jakarta+Convention+Center+Jakarta&hl=en&gl=id&brd_json=1'
  bright_data_body=$(cat <<JSON
{
  "zone": "${BRIGHT_DATA_SERP_ZONE}",
  "url": "${bright_data_target}",
  "format": "raw"
}
JSON
)
  bright_data_headers="$(mktemp)"
  bright_data_response="$(curl --silent --show-error \
    --max-time "$(( ${BRIGHT_DATA_TIMEOUT_MS:-60000} / 1000 ))" \
    --dump-header "$bright_data_headers" \
    --request POST \
    --header "Authorization: Bearer ${BRIGHT_DATA_API_KEY}" \
    --header 'Content-Type: application/json' \
    --data "$bright_data_body" \
    'https://api.brightdata.com/request' 2>/dev/null)" || bright_data_response=''
  # Only the provider error headers are kept. `case` uses shell globs, not regular expressions.
  bright_data_error=''
  bright_data_error_lines=0
  while IFS= read -r header_line || [[ -n "$header_line" ]]; do
    header_line="${header_line%$'\r'}"
    case "${header_line,,}" in
      x-brd-err-code:*|x-brd-error-code:*|x-brd-err-msg:*|x-brd-error:*)
        if (( bright_data_error_lines < 2 )); then
          bright_data_error+="${header_line} "
          bright_data_error_lines=$(( bright_data_error_lines + 1 ))
        fi
        ;;
    esac
  done < "$bright_data_headers"
  rm -f "$bright_data_headers"

  bright_data_verdict="$(python3 -c '
import json
import sys

raw = sys.stdin.read()
if not raw.strip():
    print("empty body")
    sys.exit()
try:
    data = json.loads(raw)
    organic = data.get("organic") or []
    print("ok" if organic else "JSON without organic results")
except Exception:
    print("body is not JSON")
' <<< "$bright_data_response")"

  if [[ "$bright_data_verdict" == "ok" ]]; then
    pass 'Bright Data Direct API SERP request (Full JSON, organic results present)'
  else
    fail "Bright Data Direct API SERP request: ${bright_data_verdict}"
    if [[ -n "$bright_data_error" ]]; then
      printf '  Bright Data Direct API diagnostic: %s\n' "$bright_data_error"
    fi
  fi
fi

if [[ "$VULTR_INFERENCE_READY" -eq 1 ]]; then
  VULTR_BASE="${VULTR_INFERENCE_BASE_URL:-https://api.vultrinference.com/v1}"
  VULTR_MODEL="${VULTR_INFERENCE_MODEL:-deepseek-v4.1-flash-1017}"

  # The API silently routes an unknown model id to its default model and still
  # answers 200. Each check therefore compares the model echoed in the answer
  # with the model that was requested. This script performs no retry.
  vultr_check() {
    local label="$1"
    local body="$2"
    local expect="$3"
    local requested_model="${4:-$VULTR_MODEL}"
    local response
    response="$(curl --silent --show-error --max-time 120 \
      --write-out '\n%{http_code}' \
      --request POST \
      --header "Authorization: Bearer ${VULTR_INFERENCE_API_KEY}" \
      --header 'Content-Type: application/json' \
      --data "$body" \
      "${VULTR_BASE}/chat/completions" 2>/dev/null)" || response=$'\n000'

    local status="${response##*$'\n'}"
    local payload="${response%$'\n'*}"
    if [[ "$status" != "200" ]]; then
      if [[ "$expect" == "rejected_model" && ( "$status" == "400" || "$status" == "404" || "$status" == "422" ) ]]; then
        pass "Vultr Serverless Inference ${label} (unknown model id rejected with HTTP ${status})"
        return
      fi
      fail "Vultr Serverless Inference ${label} returned HTTP ${status}"
      report_api_error "Vultr ${label}" "$payload"
      return
    fi

    local verdict
    verdict="$(python3 -c '
import json
import sys

requested, expect = sys.argv[1], sys.argv[2]
try:
    data = json.loads(sys.stdin.read())
    echoed = data.get("model")
    choice = data["choices"][0]
    message = choice.get("message") or {}
    reason = choice.get("finish_reason")
    if expect in ("rerouted_model", "rejected_model"):
        # Premise of the gateway guard: an unknown model id is answered by a different model.
        print("ok" if echoed != requested else "the unknown model id was answered as requested; the model echo check is not needed")
    elif echoed != requested:
        print(f"model mismatch: requested={requested} answered={echoed}")
    elif expect == "truncated":
        # Premise of the gateway guard: a too small output budget ends with finish_reason length.
        print("ok" if reason == "length" else f"expected finish_reason length, got {reason}")
    elif expect == "tool_call":
        calls = message.get("tool_calls") or []
        reason = choice.get("finish_reason")
        ok = reason == "tool_calls" and calls and calls[0]["function"]["name"] == "get_weather"
        print("ok" if ok else f"no get_weather tool call (finish_reason={reason})")
    else:
        parsed = json.loads(message.get("content") or "")
        valid = parsed.get("intent") in ("event_search", "route_request", "weather") and isinstance(parsed.get("needs_clarification"), bool) and set(parsed) == {"intent", "needs_clarification"}
        print("ok" if valid else "structured output did not match schema")
except Exception as error:
    print(f"unreadable response: {type(error).__name__}")
' "$requested_model" "$expect" <<< "$payload")"

    if [[ "$verdict" == "ok" ]]; then
      pass "Vultr Serverless Inference ${label} (requested model ${requested_model})"
    else
      fail "Vultr Serverless Inference ${label}: ${verdict}"
    fi
  }

  vultr_check 'tool call' "$(cat <<JSON
{
  "model": "${VULTR_MODEL}",
  "reasoning": {"effort": "low"},
  "max_completion_tokens": 600,
  "tool_choice": "auto",
  "messages": [{"role": "user", "content": "What is the weather in Jakarta right now? Use the tool."}],
  "tools": [{"type": "function", "function": {"name": "get_weather", "description": "Get weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"], "additionalProperties": false}}}]
}
JSON
)" tool_call

  vultr_check 'structured output' "$(cat <<JSON
{
  "model": "${VULTR_MODEL}",
  "reasoning": {"effort": "low"},
  "max_completion_tokens": 600,
  "messages": [{"role": "user", "content": "Classify this request: How do I get from my hotel to the meeting?"}],
  "response_format": {"type": "json_schema", "json_schema": {"name": "intent", "strict": true, "schema": {"type": "object", "properties": {"intent": {"type": "string", "enum": ["event_search", "route_request", "weather"]}, "needs_clarification": {"type": "boolean"}}, "required": ["intent", "needs_clarification"], "additionalProperties": false}}}
}
JSON
)" structured

  # Gateway premises (Task 09). The gateway in packages/integrations rejects an echoed model that
  # differs from the requested one and treats finish_reason length or error as an error. These
  # probes confirm that the provider still behaves the way those guards assume.
  vultr_check 'unknown model id is not honoured (model echo guard needed)' "$(cat <<JSON
{
  "model": "travelflow-smoke-unknown-model",
  "max_completion_tokens": 200,
  "messages": [{"role": "user", "content": "Say hello."}]
}
JSON
)" rerouted_model 'travelflow-smoke-unknown-model'

  vultr_check 'too small output budget ends with finish_reason length' "$(cat <<JSON
{
  "model": "${VULTR_MODEL}",
  "reasoning": {"effort": "high"},
  "max_completion_tokens": 5,
  "messages": [{"role": "user", "content": "Explain in three sentences why Jakarta traffic is heavy on weekday mornings."}]
}
JSON
)" truncated

  bad_status="$(curl --silent --max-time 60 --output /dev/null --write-out '%{http_code}' \
    --request POST \
    --header 'Authorization: Bearer travelflow-smoke-invalid-key' \
    --header 'Content-Type: application/json' \
    --data "{\"model\": \"${VULTR_MODEL}\", \"max_completion_tokens\": 20, \"messages\": [{\"role\": \"user\", \"content\": \"hi\"}]}" \
    "${VULTR_BASE}/chat/completions" 2>/dev/null)" || bad_status='000'
  if [[ "$bad_status" == "401" || "$bad_status" == "403" ]]; then
    pass "Vultr Serverless Inference rejects invalid credentials (HTTP ${bad_status})"
  else
    fail "Vultr Serverless Inference answered HTTP ${bad_status} for an invalid key; the gateway expects 401 or 403"
  fi
fi

printf '\n'
if [[ "$failures" -eq 0 ]]; then
  printf 'RESULT: PASS\n'
  exit 0
fi

printf 'RESULT: BLOCKED_OR_FAILED (%s check(s))\n' "$failures"
exit 1
