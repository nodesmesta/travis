import { ExternalDataError } from "./errors.js";
import { trimTrailing } from "./text.js";

export interface VultrInferenceConfig {
  baseUrl?: string | undefined;
  apiKey: string | undefined;
  model: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface JsonSchemaRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxCompletionTokens: number;
  reasoningEffort?: ReasoningEffort;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InferenceUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
}

export interface InferenceMeta {
  /** Model id echoed by the provider. It always equals the requested model. */
  model: string;
  latencyMs: number;
  usage: InferenceUsage;
}

export interface StructuredRequest {
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxCompletionTokens: number;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
}

export interface ForcedToolCallRequest {
  messages: ChatMessage[];
  tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  maxCompletionTokens: number;
  reasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
}

const PROVIDER = "vultr_inference";

interface ChatCompletionBody {
  model?: unknown;
  error?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
  }>;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Gateway to Vultr Serverless Inference chat completions.
 *
 * The API answers HTTP 200 and silently reroutes an unknown model id to its
 * default model, so the model echoed in the answer is always compared with the
 * model that was requested. A `finish_reason` that is not the expected one
 * (including `length` and `error`) is an error. There is no retry and no
 * fallback model. Prompts are built by the caller; the gateway never logs
 * message content or the API key.
 */
export class VultrInferenceClient {
  public readonly provider = PROVIDER;

  public constructor(private readonly config: VultrInferenceConfig) {}

  /** Model requested for every call, or undefined when not configured. */
  public get model(): string | undefined {
    return this.config.model;
  }

  public async completeJson(request: JsonSchemaRequest): Promise<unknown> {
    const result = await this.completeStructured({
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      schemaName: request.schemaName,
      schema: request.schema,
      maxCompletionTokens: request.maxCompletionTokens,
      ...(request.reasoningEffort
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
    });
    return result.value;
  }

  /** Strict JSON-schema output. Returns the parsed value plus call metadata. */
  public async completeStructured(
    request: StructuredRequest,
  ): Promise<{ value: unknown; meta: InferenceMeta }> {
    const { body, meta } = await this.post(
      {
        messages: request.messages,
        reasoning: { effort: request.reasoningEffort ?? "low" },
        max_completion_tokens: request.maxCompletionTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: request.schema,
          },
        },
      },
      request.timeoutMs,
    );
    const choice = this.requireFinished(body, "stop");
    const content = choice.message?.content;
    if (typeof content !== "string") {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        PROVIDER,
        "Vultr Serverless Inference returned no message content.",
        502,
      );
    }
    try {
      return { value: JSON.parse(content) as unknown, meta };
    } catch {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        PROVIDER,
        "Vultr Serverless Inference returned content that is not valid JSON.",
        502,
      );
    }
  }

  /**
   * Forces the model to answer by calling one named function. The arguments are
   * returned as parsed JSON and are still untrusted: the caller validates them.
   */
  public async completeForcedToolCall(
    request: ForcedToolCallRequest,
  ): Promise<{ toolName: string; arguments: unknown; meta: InferenceMeta }> {
    const { body, meta } = await this.post(
      {
        messages: request.messages,
        tools: [
          {
            type: "function",
            function: {
              name: request.tool.name,
              description: request.tool.description,
              parameters: request.tool.parameters,
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: request.tool.name },
        },
        reasoning: { effort: request.reasoningEffort ?? "low" },
        max_completion_tokens: request.maxCompletionTokens,
      },
      request.timeoutMs,
    );
    const choice = this.requireFinished(body, "tool_calls");
    const call = choice.message?.tool_calls?.[0]?.function;
    if (
      !call ||
      call.name !== request.tool.name ||
      typeof call.arguments !== "string"
    ) {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        PROVIDER,
        "Vultr Serverless Inference did not return the requested tool call.",
        502,
      );
    }
    try {
      return {
        toolName: call.name,
        arguments: JSON.parse(call.arguments) as unknown,
        meta,
      };
    } catch {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        PROVIDER,
        "Vultr Serverless Inference returned tool arguments that are not valid JSON.",
        502,
      );
    }
  }

  private requireFinished(
    body: ChatCompletionBody,
    expected: "stop" | "tool_calls",
  ): NonNullable<ChatCompletionBody["choices"]>[number] {
    const choice = body.choices?.[0];
    if (!choice || choice.finish_reason !== expected) {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        PROVIDER,
        "Vultr Serverless Inference did not finish the answer.",
        502,
        false,
        { finish_reason: String(choice?.finish_reason ?? "missing") },
      );
    }
    return choice;
  }

  private async post(
    payload: Record<string, unknown>,
    timeoutMs: number | undefined,
  ): Promise<{ body: ChatCompletionBody; meta: InferenceMeta }> {
    if (!this.config.apiKey || !this.config.model) {
      throw new ExternalDataError(
        "EXTERNAL_CONFIGURATION_MISSING",
        PROVIDER,
        "Vultr Serverless Inference is not configured.",
        503,
      );
    }
    const baseUrl = trimTrailing(
      this.config.baseUrl ?? "https://api.vultrinference.com/v1",
      "/",
    );
    const doFetch = this.config.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.config.timeoutMs ?? 45_000,
    );
    const startedAt = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.config.model, ...payload }),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ExternalDataError(
          "EXTERNAL_PROVIDER_TIMEOUT",
          PROVIDER,
          "Vultr Serverless Inference request timed out.",
          504,
          true,
        );
      }
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_ERROR",
        PROVIDER,
        "Vultr Serverless Inference request failed.",
        502,
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    const latencyMs = Date.now() - startedAt;

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_RATE_LIMITED",
        PROVIDER,
        "Vultr Serverless Inference rate limit was reached.",
        429,
        true,
        {
          retry_after_seconds:
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5,
        },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_REJECTED",
        PROVIDER,
        "Vultr Serverless Inference rejected the credentials.",
        502,
        false,
        { provider_status: response.status },
      );
    }
    if (!response.ok) {
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_ERROR",
        PROVIDER,
        "Vultr Serverless Inference did not return a successful response.",
        502,
        response.status >= 500,
        { provider_status: response.status },
      );
    }

    let body: ChatCompletionBody;
    try {
      body = JSON.parse(text) as ChatCompletionBody;
    } catch {
      throw new ExternalDataError(
        "EXTERNAL_RESPONSE_INVALID",
        PROVIDER,
        "Vultr Serverless Inference returned a non-JSON response.",
        502,
      );
    }
    if (body.error !== undefined && body.error !== null) {
      throw new ExternalDataError(
        "EXTERNAL_PROVIDER_ERROR",
        PROVIDER,
        "Vultr Serverless Inference reported an error.",
        502,
        false,
        { provider_status: response.status },
      );
    }
    if (body.model !== this.config.model) {
      throw new ExternalDataError(
        "EXTERNAL_MODEL_MISMATCH",
        PROVIDER,
        "Vultr Serverless Inference answered with a different model than requested.",
        502,
        false,
        {
          requested_model: this.config.model,
          answered_model: String(body.model),
        },
      );
    }
    return {
      body,
      meta: {
        model: this.config.model,
        latencyMs,
        usage: {
          promptTokens: tokenCount(body.usage?.prompt_tokens),
          completionTokens: tokenCount(body.usage?.completion_tokens),
          totalTokens: tokenCount(body.usage?.total_tokens),
          reasoningTokens: tokenCount(
            body.usage?.completion_tokens_details?.reasoning_tokens,
          ),
        },
      },
    };
  }
}
