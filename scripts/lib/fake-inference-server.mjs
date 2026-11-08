// FIXTURE MODEL SERVER for scripts/validate-task-09.mjs.
//
// It speaks the part of the Vultr Serverless Inference chat-completions API that
// the assistant gateway uses (a forced tool call for planning, JSON content for
// the answer). A validator sets `behavior` to decide what the "model" says, so it
// can check how the backend reacts to a good plan, a bad plan, and an answer that
// changes a number or the ranking. Nothing from this server is a live model
// result and a validator must never report it as one.

import http from "node:http";

const OPEN = '<untrusted_data source="tool_results">\n';
const CLOSE = "\n</untrusted_data>";

/** Reads the tool results the backend put in the synthesis prompt. */
export function toolResultsFromPrompt(messages) {
  const user = messages.find((message) => message.role === "user");
  const content = String(user?.content ?? "");
  const start = content.indexOf(OPEN);
  if (start < 0) return null;
  const from = start + OPEN.length;
  const end = content.indexOf(CLOSE, from);
  if (end < 0) return null;
  const raw = content
    .slice(from, end)
    .split("&lt;")
    .join("<")
    .split("&gt;")
    .join(">");
  return JSON.parse(raw);
}

export async function startFakeModelServer() {
  const state = {
    /** (request body) => plan arguments object */
    plan: () => {
      throw new Error("no plan behavior set");
    },
    /** (parsed tool results, request body) => synthesis object */
    synthesis: () => {
      throw new Error("no synthesis behavior set");
    },
    planCalls: 0,
    synthesisCalls: 0,
  };
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (
        request.method !== "POST" ||
        !request.url?.endsWith("/chat/completions")
      ) {
        send(404, { error: "unknown fixture route" });
        return;
      }
      const body = JSON.parse(raw);
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (Array.isArray(body.tools)) {
        state.planCalls += 1;
        send(200, {
          model: body.model,
          usage,
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: body.tools[0].function.name,
                      arguments: JSON.stringify(state.plan(body)),
                    },
                  },
                ],
              },
            },
          ],
        });
        return;
      }
      state.synthesisCalls += 1;
      const results = toolResultsFromPrompt(body.messages);
      send(200, {
        model: body.model,
        usage,
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(state.synthesis(results, body)),
            },
          },
        ],
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
