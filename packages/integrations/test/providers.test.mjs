import assert from "node:assert/strict";
import test from "node:test";
import { BrightDataClient, VultrInferenceClient } from "../dist/index.js";
import { has, lacks } from "./helpers.mjs";

function reply(status, body, headers = {}) {
  return async () => new Response(body, { status, headers });
}

function brightData(fetchImpl, overrides = {}) {
  return new BrightDataClient({
    apiKey: "test-key",
    serpZone: "serp",
    unlockerZone: "unlocker",
    timeoutMs: 200,
    fetchImpl,
    ...overrides,
  });
}

test("Bright Data returns the body of a successful request and sends the zone", async () => {
  let sent;
  const client = brightData(async (url, init) => {
    sent = {
      url,
      body: JSON.parse(init.body),
      auth: init.headers.Authorization,
    };
    return new Response('{"organic":[]}', { status: 200 });
  });
  assert.equal(
    await client.fetchText(
      "serp",
      "https://www.google.com/search?q=a&brd_json=1",
    ),
    '{"organic":[]}',
  );
  assert.equal(sent.url, "https://api.brightdata.com/request");
  assert.deepEqual(sent.body, {
    zone: "serp",
    url: "https://www.google.com/search?q=a&brd_json=1",
    format: "raw",
  });
  assert.equal(sent.auth, "Bearer test-key");
});

test("an empty 200 with a captcha header is a rejection, not an empty result", async () => {
  const client = brightData(
    reply(200, "", {
      "x-brd-error-code": "captcha",
      "x-brd-error": "redirect location was rejected",
    }),
  );
  await assert.rejects(
    client.fetchText("serp", "https://example.com"),
    (error) => {
      assert.equal(error.code, "EXTERNAL_PROVIDER_REJECTED");
      assert.equal(error.details.provider_error_code, "captcha");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("a denylisted IP is reported without leaking the address or links", async () => {
  const client = brightData(
    reply(200, "", {
      "x-brd-err-code": "client_10050",
      "x-brd-err-msg":
        "The IP address from which you are sending this request: 114.12.14.10 is denylisted. See https://brightdata.com/cp/zones/x",
    }),
  );
  await assert.rejects(
    client.fetchText("unlocker", "https://example.com"),
    (error) => {
      assert.equal(error.code, "EXTERNAL_PROVIDER_REJECTED");
      assert.equal(error.retryable, false);
      const text = JSON.stringify(error.details);
      lacks(text, "114.12");
      lacks(text, "http");
      has(text, "<ip>");
      return true;
    },
  );
});

test("rate limit codes and HTTP 429 map to a rate-limited error with a wait time", async () => {
  for (const [status, headers] of [
    [200, { "x-brd-error-code": "failed_query_rejected" }],
    [429, { "retry-after": "30" }],
  ]) {
    const client = brightData(reply(status, "", headers));
    await assert.rejects(
      client.fetchText("serp", "https://example.com"),
      (error) => {
        assert.equal(error.code, "EXTERNAL_PROVIDER_RATE_LIMITED");
        assert.equal(error.statusCode, 429);
        assert.equal(
          error.details.retry_after_seconds,
          status === 429 ? 30 : 15,
        );
        return true;
      },
    );
  }
});

test("an empty 200 without any reason is an invalid response", async () => {
  const client = brightData(reply(200, "  "));
  await assert.rejects(
    client.fetchText("serp", "https://example.com"),
    (error) => error.code === "EXTERNAL_RESPONSE_INVALID",
  );
});

test("auth failures and server errors are separate codes", async () => {
  await assert.rejects(
    brightData(reply(401, "no")).fetchText("serp", "https://example.com"),
    (error) =>
      error.code === "EXTERNAL_PROVIDER_REJECTED" && error.retryable === false,
  );
  await assert.rejects(
    brightData(reply(503, "down")).fetchText("serp", "https://example.com"),
    (error) =>
      error.code === "EXTERNAL_PROVIDER_ERROR" && error.retryable === true,
  );
});

test("missing credentials or zone never call the provider", async () => {
  let called = 0;
  const spy = async () => {
    called += 1;
    return new Response("x");
  };
  await assert.rejects(
    brightData(spy, { apiKey: undefined }).fetchText(
      "serp",
      "https://example.com",
    ),
    (error) => error.code === "EXTERNAL_CONFIGURATION_MISSING",
  );
  await assert.rejects(
    brightData(spy).fetchText(undefined, "https://example.com"),
    (error) => error.code === "EXTERNAL_CONFIGURATION_MISSING",
  );
  assert.equal(called, 0);
});

test("a request that outlives the timeout is reported as a timeout", async () => {
  const slow = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  await assert.rejects(
    brightData(slow, { timeoutMs: 20 }).fetchText(
      "serp",
      "https://example.com",
    ),
    (error) => error.code === "EXTERNAL_PROVIDER_TIMEOUT",
  );
});

// ---------------------------------------------------------------------------

function completion({
  model = "m1",
  finish = "stop",
  content = '{"events":[]}',
} = {}) {
  return JSON.stringify({
    model,
    choices: [{ finish_reason: finish, message: { content } }],
  });
}

function vultr(fetchImpl, overrides = {}) {
  return new VultrInferenceClient({
    apiKey: "k",
    model: "m1",
    fetchImpl,
    timeoutMs: 200,
    ...overrides,
  });
}

const request = {
  system: "s",
  user: "u",
  schemaName: "x",
  schema: { type: "object" },
  maxCompletionTokens: 100,
};

test("Vultr returns parsed JSON and asks for strict schema output", async () => {
  let sent;
  const client = vultr(async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(completion({ content: '{"events":[1]}' }), {
      status: 200,
    });
  });
  assert.deepEqual(await client.completeJson(request), { events: [1] });
  assert.equal(sent.url, "https://api.vultrinference.com/v1/chat/completions");
  assert.equal(sent.body.model, "m1");
  assert.equal(sent.body.response_format.json_schema.strict, true);
  assert.equal(sent.body.reasoning.effort, "low");
});

test("an answer from a different model than requested is an error", async () => {
  const client = vultr(reply(200, completion({ model: "deepseek-default" })));
  await assert.rejects(client.completeJson(request), (error) => {
    assert.equal(error.code, "EXTERNAL_MODEL_MISMATCH");
    assert.equal(error.details.requested_model, "m1");
    return true;
  });
});

test("an unfinished or non-JSON answer is invalid", async () => {
  await assert.rejects(
    vultr(reply(200, completion({ finish: "length" }))).completeJson(request),
    (error) =>
      error.code === "EXTERNAL_RESPONSE_INVALID" &&
      error.details.finish_reason === "length",
  );
  await assert.rejects(
    vultr(reply(200, completion({ content: "not json" }))).completeJson(
      request,
    ),
    (error) => error.code === "EXTERNAL_RESPONSE_INVALID",
  );
});

test("Vultr maps rate limits, credentials, and missing configuration", async () => {
  await assert.rejects(
    vultr(reply(429, "", { "retry-after": "7" })).completeJson(request),
    (error) =>
      error.code === "EXTERNAL_PROVIDER_RATE_LIMITED" &&
      error.details.retry_after_seconds === 7,
  );
  await assert.rejects(
    vultr(reply(401, "")).completeJson(request),
    (error) => error.code === "EXTERNAL_PROVIDER_REJECTED",
  );
  await assert.rejects(
    vultr(reply(200, completion()), { apiKey: undefined }).completeJson(
      request,
    ),
    (error) => error.code === "EXTERNAL_CONFIGURATION_MISSING",
  );
});
