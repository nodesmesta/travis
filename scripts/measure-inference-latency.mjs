// Measures real Vultr Serverless Inference latency for the two assistant calls
// (planner tool call and structured synthesis) at several reasoning levels.
// Run: node --env-file=.env.local scripts/measure-inference-latency.mjs
// It uses the production prompts and tool registry. The tool result used for
// synthesis is a labelled measurement fixture and is never shown to a user.
import {
  SYNTHESIS_SCHEMA,
  buildPlannerMessages,
  buildSubmitPlanTool,
  buildSynthesisMessages,
  resolveAssistantContext,
} from "../packages/domain/dist/index.js";
import { VultrInferenceClient } from "../packages/integrations/dist/index.js";
import { createAssistantToolRegistry } from "../apps/api/dist/services/assistant/tools/registry.js";

const runs = Number(process.env.MEASURE_RUNS ?? 5);
const efforts = (process.env.MEASURE_EFFORTS ?? "minimal,low,medium").split(
  ",",
);
const client = new VultrInferenceClient({
  baseUrl: process.env.VULTR_INFERENCE_BASE_URL,
  apiKey: process.env.VULTR_INFERENCE_API_KEY,
  model: process.env.VULTR_INFERENCE_MODEL,
  timeoutMs: 120000,
});
if (!process.env.VULTR_INFERENCE_API_KEY) {
  console.error("BLOCKED: VULTR_INFERENCE_API_KEY is not set.");
  process.exit(2);
}

const registry = createAssistantToolRegistry({
  aiToolTimeoutMs: 15000,
  aiEventToolTimeoutMs: 150000,
});
const points = [
  {
    id: "jcc",
    label: "Jakarta Convention Center",
    type: "conference",
    usable: true,
  },
  {
    id: "hotel",
    label: "Hotel Indonesia Kempinski",
    type: "hotel",
    usable: true,
  },
];
const message =
  "Apa event di sekitar Jakarta Convention Center pada 12 November 2026?";
const resolved = resolveAssistantContext({
  message,
  contextPoints: points,
  activeContextPointId: null,
  ignoreTokens: ["jakarta", "business", "trip"],
});
const plannerMessages = buildPlannerMessages({
  now: new Date(),
  today: "2026-11-07",
  timezone: "Asia/Jakarta",
  tripSnapshot: {
    trip: {
      id: "t",
      name: "Jakarta Business Trip",
      timezone: "Asia/Jakarta",
      status: "confirmed",
    },
    context_points: points.map((p) => ({ ...p })),
    upcoming_agenda: [],
  },
  resolved,
  catalog: registry.catalog(),
  actionableEntities: [],
  history: [],
  message,
  maxHistoryChars: 3000,
  maxMessageChars: 2000,
});
const planTool = buildSubmitPlanTool(registry.names(), 3);
const fixtureResult = {
  status: "ok",
  data: {
    events: [
      {
        id: "e1",
        title: "Measurement fixture event",
        starts_at: "2026-11-12T18:30:00+07:00",
      },
    ],
  },
  cards: [],
  facts: [],
  sources: [
    {
      id: "s1",
      kind: "search_result",
      provider: "fixture",
      retrieved_at: "2026-11-07T12:00:00Z",
      freshness: "fresh",
    },
  ],
  limitations: [],
  live: true,
  retrievedAt: "2026-11-07T12:00:00Z",
  freshness: "fresh",
  contextPointIds: ["jcc"],
  eventResultIds: ["e1"],
  agendaItemIds: [],
  providerCalls: 1,
};
const synthesisMessages = buildSynthesisMessages({
  message,
  intent: "find_nearby_event",
  timezone: "Asia/Jakarta",
  resolved,
  results: [{ toolName: "discover_events", result: fixtureResult }],
  history: [],
  maxMessageChars: 2000,
  maxToolResultChars: 60000,
});

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: Math.round(sum / values.length),
    max: sorted[sorted.length - 1],
  };
}

const report = [];
for (const effort of efforts) {
  for (const stage of ["planner", "synthesis"]) {
    const latencies = [];
    const reasoning = [];
    const failures = [];
    for (let index = 0; index < runs; index += 1) {
      const started = Date.now();
      try {
        if (stage === "planner") {
          const result = await client.completeForcedToolCall({
            messages: plannerMessages,
            tool: planTool,
            maxCompletionTokens: 2000,
            reasoningEffort: effort,
          });
          reasoning.push(result.meta.usage.reasoningTokens ?? 0);
          latencies.push(Date.now() - started);
        } else {
          const result = await client.completeStructured({
            messages: synthesisMessages,
            schemaName: "assistant_answer",
            schema: SYNTHESIS_SCHEMA,
            maxCompletionTokens: 3000,
            reasoningEffort: effort,
          });
          reasoning.push(result.meta.usage.reasoningTokens ?? 0);
          latencies.push(Date.now() - started);
        }
      } catch (error) {
        failures.push(
          `${error.code ?? error.name}:${JSON.stringify(error.details ?? {})}`,
        );
      }
    }
    report.push({
      stage,
      effort,
      latency_ms: latencies.length ? stats(latencies) : null,
      reasoning_tokens_mean: reasoning.length
        ? Math.round(reasoning.reduce((a, b) => a + b, 0) / reasoning.length)
        : null,
      failures,
    });
  }
}
console.log(
  JSON.stringify(
    { model: process.env.VULTR_INFERENCE_MODEL, runs, report },
    null,
    2,
  ),
);
