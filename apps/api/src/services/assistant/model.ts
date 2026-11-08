import {
  VultrInferenceClient,
  type InferenceMeta,
  type ReasoningEffort,
} from "@travelflow/integrations";
import type { PromptMessage } from "@travelflow/domain";

export interface PlanModelRequest {
  messages: PromptMessage[];
  tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  timeoutMs: number;
  reasoningEffort: ReasoningEffort;
  maxTokens: number;
}

export interface SynthesisModelRequest {
  messages: PromptMessage[];
  schema: Record<string, unknown>;
  timeoutMs: number;
  reasoningEffort: ReasoningEffort;
  maxTokens: number;
}

/**
 * The only way the orchestrator reaches a language model. The model sees
 * prompts and returns text or JSON; it holds no database, provider, or secret.
 */
export interface AssistantModel {
  readonly modelId: string | undefined;
  plan(
    request: PlanModelRequest,
  ): Promise<{ arguments: unknown; meta: InferenceMeta }>;
  synthesize(
    request: SynthesisModelRequest,
  ): Promise<{ value: unknown; meta: InferenceMeta }>;
}

export class VultrAssistantModel implements AssistantModel {
  public constructor(private readonly client: VultrInferenceClient) {}

  public get modelId(): string | undefined {
    return this.client.model;
  }

  public async plan(
    request: PlanModelRequest,
  ): Promise<{ arguments: unknown; meta: InferenceMeta }> {
    const result = await this.client.completeForcedToolCall({
      messages: request.messages,
      tool: request.tool,
      maxCompletionTokens: request.maxTokens,
      reasoningEffort: request.reasoningEffort,
      timeoutMs: request.timeoutMs,
    });
    return { arguments: result.arguments, meta: result.meta };
  }

  public async synthesize(
    request: SynthesisModelRequest,
  ): Promise<{ value: unknown; meta: InferenceMeta }> {
    return this.client.completeStructured({
      messages: request.messages,
      schemaName: "assistant_answer",
      schema: request.schema,
      maxCompletionTokens: request.maxTokens,
      reasoningEffort: request.reasoningEffort,
      timeoutMs: request.timeoutMs,
    });
  }
}
