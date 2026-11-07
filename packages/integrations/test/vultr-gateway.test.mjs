import assert from "node:assert/strict";
import test from "node:test";
import { VultrInferenceClient } from "../dist/index.js";

// Gateway cases for the assistant (Task 09). The fetch implementation is a
// fake; the live provider is exercised by scripts/validate-task-09.mjs.

function reply(status, body, headers = {}) {
  return async () => new Response(body, { status, headers });
}

function toolCompletion({
  model = "m1",
  finish = "tool_calls",
  name = "submit_plan",
  args = '{"intent":"summarize_trip"}',
} = {}) {
  return JSON.stringify({
    model,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 7 },
    },
    choices: [
      {
        finish_reason: finish,
        message: {
          content: null,
          tool_calls: [{ function: { name, arguments: args } }],
        },
      },
    ],
  });
}

function structuredCompletion({
  model = "m1",
  finish = "stop",
  content = '{"message":"ok"}',
} = {}) {
  return JSON.stringify({
    model,
    choices: [{ finish_reason: finish, message: { content } }],
  });
}

function client(fetchImpl, overrides = {}) {
  return new VultrInferenceClient({
    apiKey: "secret-key-value",
    model: "m1",
    fetchImpl,
    timeoutMs: 200,
    ...overrides,
  });
}

const toolRequest = {
  messages: [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ],
  tool: {
    name: "submit_plan",
    description: "d",
    parameters: { type: "object" },
  },
  maxCompletionTokens: 100,
};

const structuredRequest = {
  messages: [{ role: "user", content: "u" }],
  schemaName: "x",
  schema: { type: "object" },
  maxCompletionTokens: 100,
};

test("a forced tool call sends tool_choice for that function and returns usage", async () => {
  let sent;
  const gateway = client(async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(toolCompletion(), { status: 200 });
  });
  const result = await gateway.completeForcedToolCall({
    ...toolRequest,
    reasoningEffort: "medium",
    timeoutMs: 150,
  });
  assert.equal(result.toolName, "submit_plan");
  assert.deepEqual(result.arguments, { intent: "summarize_trip" });
  assert.equal(result.meta.model, "m1");
  assert.equal(result.meta.usage.reasoningTokens, 7);
  assert.equal(sent.tool_choice.function.name, "submit_plan");
  assert.equal(sent.reasoning.effort, "medium");
  assert.equal(sent.stream, undefined);
});

test("a different echoed model is rejected for tool calls and structured output", async () => {
  await assert.rejects(
    client(
      reply(200, toolCompletion({ model: "default-model" })),
    ).completeForcedToolCall(toolRequest),
    (error) =>
      error.code === "EXTERNAL_MODEL_MISMATCH" &&
      error.details.answered_model === "default-model",
  );
  await assert.rejects(
    client(
      reply(200, structuredCompletion({ model: "default-model" })),
    ).completeStructured(structuredRequest),
    (error) => error.code === "EXTERNAL_MODEL_MISMATCH",
  );
});

test("finish_reason length or error is an error, never an answer", async () => {
  for (const finish of ["length", "error", "content_filter"]) {
    await assert.rejects(
      client(reply(200, toolCompletion({ finish }))).completeForcedToolCall(
        toolRequest,
      ),
      (error) =>
        error.code === "EXTERNAL_RESPONSE_INVALID" &&
        error.details.finish_reason === finish,
    );
    await assert.rejects(
      client(reply(200, structuredCompletion({ finish }))).completeStructured(
        structuredRequest,
      ),
      (error) =>
        error.code === "EXTERNAL_RESPONSE_INVALID" &&
        error.details.finish_reason === finish,
    );
  }
});

test("a different function name or broken arguments are invalid", async () => {
  await assert.rejects(
    client(
      reply(200, toolCompletion({ name: "delete_everything" })),
    ).completeForcedToolCall(toolRequest),
    (error) => error.code === "EXTERNAL_RESPONSE_INVALID",
  );
  await assert.rejects(
    client(
      reply(200, toolCompletion({ args: "{not json" })),
    ).completeForcedToolCall(toolRequest),
    (error) => error.code === "EXTERNAL_RESPONSE_INVALID",
  );
});

test("rate limit, bad credentials, provider errors, and missing configuration are structured", async () => {
  await assert.rejects(
    client(reply(429, "", { "retry-after": "9" })).completeForcedToolCall(
      toolRequest,
    ),
    (error) =>
      error.code === "EXTERNAL_PROVIDER_RATE_LIMITED" &&
      error.retryable === true &&
      error.details.retry_after_seconds === 9,
  );
  await assert.rejects(
    client(reply(401, "")).completeStructured(structuredRequest),
    (error) => error.code === "EXTERNAL_PROVIDER_REJECTED",
  );
  await assert.rejects(
    client(reply(503, "")).completeStructured(structuredRequest),
    (error) =>
      error.code === "EXTERNAL_PROVIDER_ERROR" &&
      error.details.provider_status === 503,
  );
  await assert.rejects(
    client(
      reply(200, JSON.stringify({ error: { message: "boom" } })),
    ).completeStructured(structuredRequest),
    (error) => error.code === "EXTERNAL_PROVIDER_ERROR",
  );
  await assert.rejects(
    client(reply(200, structuredCompletion()), {
      apiKey: undefined,
    }).completeStructured(structuredRequest),
    (error) => error.code === "EXTERNAL_CONFIGURATION_MISSING",
  );
  await assert.rejects(
    client(reply(200, structuredCompletion()), {
      model: undefined,
    }).completeForcedToolCall(toolRequest),
    (error) => error.code === "EXTERNAL_CONFIGURATION_MISSING",
  );
});

test("a per-call timeout aborts the request without retrying", async () => {
  let calls = 0;
  const slow = (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };
  await assert.rejects(
    client(slow, { timeoutMs: 5000 }).completeForcedToolCall({
      ...toolRequest,
      timeoutMs: 20,
    }),
    (error) => error.code === "EXTERNAL_PROVIDER_TIMEOUT",
  );
  assert.equal(calls, 1);
});

test("errors never contain the API key", async () => {
  const failures = [
    client(reply(401, "secret-key-value")).completeStructured(
      structuredRequest,
    ),
    client(reply(500, "secret-key-value")).completeStructured(
      structuredRequest,
    ),
    client(reply(200, "secret-key-value")).completeStructured(
      structuredRequest,
    ),
  ];
  for (const failure of failures) {
    await assert.rejects(failure, (error) => {
      const text = JSON.stringify({
        message: error.message,
        details: error.details,
      });
      assert.ok(!text.includes("secret-key-value"));
      return true;
    });
  }
});
