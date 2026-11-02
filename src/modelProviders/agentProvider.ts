import {
  createLocalAgentCompletion,
  createMetaAgentCompletion,
  type AgentChatMessage,
  type AgentCompletion,
  type AgentToolChoice,
} from '../agentModel.js';
import type { AgentToolDefinition } from '../agentTools.js';
import type { GenerationRequest } from '../generationSettings.js';

export interface AgentModelRequest {
  model: string;
  messages: AgentChatMessage[];
  generation: GenerationRequest;
  tools: AgentToolDefinition[];
  signal: AbortSignal;
  toolChoice: AgentToolChoice;
}

/** Explicit transport boundary: one provider handles one run, with no fallback. */
export interface AgentModelProvider {
  readonly id: 'cloud' | 'local';
  complete(request: AgentModelRequest): Promise<AgentCompletion>;
}

type MetaComplete = typeof createMetaAgentCompletion;
type LocalComplete = typeof createLocalAgentCompletion;

export class MetaAgentModelProvider implements AgentModelProvider {
  readonly id = 'cloud' as const;

  constructor(
    private readonly apiKey: string,
    private readonly completeImpl: MetaComplete = createMetaAgentCompletion,
  ) {}

  complete(request: AgentModelRequest): Promise<AgentCompletion> {
    return this.completeImpl({
      apiKey: this.apiKey,
      model: request.model,
      messages: request.messages,
      generation: request.generation,
      tools: request.tools,
      signal: request.signal,
    });
  }
}

export class LocalAgentModelProvider implements AgentModelProvider {
  readonly id = 'local' as const;

  constructor(
    private readonly endpoint: string,
    private readonly completeImpl: LocalComplete = createLocalAgentCompletion,
  ) {}

  complete(request: AgentModelRequest): Promise<AgentCompletion> {
    return this.completeImpl({
      endpoint: this.endpoint,
      model: request.model,
      messages: request.messages,
      generation: request.generation,
      tools: request.tools,
      signal: request.signal,
      toolChoice: request.toolChoice,
    });
  }
}
