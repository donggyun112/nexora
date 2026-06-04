import type { ToolDefinition, ToolResult } from './tool.js';
import type { OutboundArtifact } from './adapter.js';

/**
 * Agent 런타임 계약.
 *
 * 기존 runner.ts의 Agent, CreateAgentOpts, RunOptions, StreamAgentHandle을
 * 인터페이스로 추출.
 */

export interface AgentInput {
  /** 사용자 프롬프트 */
  prompt: string;

  /** 이미지 첨부 */
  images?: ImageContent[];

  /** 이전 대화 히스토리 */
  history?: ChatMessage[];

  /** 요청자 식별 (추적용) */
  requesterId?: string;

  /**
   * Set when re-entering the loop after a suspended tool call.
   * Architecture must seed `history` from architectureHistory (already includes
   * the assistant message containing the suspended tool_call), then inject the
   * tool_result with `resumedCallId` before the next LLM turn.
   */
  resumeContext?: {
    architectureHistory: LLMMessage[];
    resumedCallId: string;
    toolResult: ToolResult;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * 에이전트 실행 중 발생하는 이벤트 스트림.
 * 기존 AgentStreamEvent를 기반으로 설계.
 */
export type AgentEvent =
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; result: unknown; isError: boolean }
  | { type: 'text'; text: string }
  | { type: 'artifact'; artifact: OutboundArtifact }
  | { type: 'thinking'; content: string }
  | { type: 'progress'; message: string; agent?: string }
  | { type: 'done'; content: string; toolCalls: ToolCallSummary[] }
  | { type: 'error'; message: string }
  | { type: 'suspended'; pendingId: string; toolCallId: string };

export interface ToolCallSummary {
  name: string;
  input: unknown;
}

/**
 * AgentRuntime — 모든 에이전트가 구현해야 하는 실행 인터페이스.
 * core 패키지에서 구현.
 */
export interface AgentRuntime {
  /** 에이전트 실행 (이벤트 스트림 반환) */
  execute(input: AgentInput): AsyncGenerator<AgentEvent>;

  /** 실행 중단 */
  abort(): void;
}

/**
 * AgentArchitecture — 사고 패턴 정의.
 * architectures 패키지에서 구현.
 *
 * 기존 runner.ts의 단일 루프를 플러그인 가능한 아키텍처로 분리.
 */
export interface AgentArchitecture {
  /** 아키텍처 이름 (react, 또는 외부에서 정의한 커스텀 아키텍처) */
  name: string;

  /** 메인 실행 루프 */
  loop(runtime: RuntimeServices, input: AgentInput): AsyncGenerator<AgentEvent>;
}

/**
 * RuntimeServices — 아키텍처가 사용하는 런타임 서비스.
 * 기존 Agent 클래스가 내부적으로 관리하던 것들을 인터페이스로 추출.
 */
export interface RuntimeServices {
  /** LLM 호출 */
  llm: LLMProvider;

  /** 도구 실행 */
  tools: ToolExecutor;

  /** 단기/장기 메모리 */
  memory: MemoryProvider;

  /** 로거 */
  logger: AgentLogger;

  /**
   * 취소 신호. AgentRunner가 idle timeout / abort() 시 활성화.
   * 아키텍처는 LLM/도구 호출 시 이 signal을 전달하고,
   * 매 루프 반복마다 signal.aborted를 확인해 빠르게 종료해야 한다.
   */
  signal: AbortSignal;

  /**
   * Architecture-level hook invoked when a tool returns ToolResult.suspend.
   * Receives the architecture history snapshot so the caller can persist it.
   * If not provided, the architecture still emits a `suspended` event but no
   * persistence callback fires.
   */
  onSuspend?: (info: {
    pendingId: string;
    toolCallId: string;
    architectureHistory: LLMMessage[];
  }) => Promise<void>;
}

export interface LLMProvider {
  /** 텍스트 생성 (스트리밍) */
  stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk>;

  /** 텍스트 생성 (완료까지 대기) */
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  content: string | LLMContentBlock[];
}

export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean };

export type LLMChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; delta: string }
  | { type: 'done'; content: string; stopReason: string };

export interface LLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  /** Cancellation signal — provider must forward to underlying SDK call. */
  signal?: AbortSignal;
  /** Dynamic tool definitions — overrides provider's static tools when set. */
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  /** Tokens served from prompt cache (Anthropic). 0 if not applicable. */
  cachedTokens?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  stopReason: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  /** Token usage from the API. Undefined if the provider doesn't report it. */
  usage?: LLMUsage;
}

export interface ToolExecutor {
  /**
   * 도구 실행. signal이 주어지면 도중 취소 시 즉시 중단해야 한다.
   * (단, 이미 시작된 도구는 자체적으로 signal을 honor해야 실제 종료된다.)
   */
  execute(name: string, callId: string, input: unknown, signal?: AbortSignal): Promise<unknown>;

  /**
   * Execute a model-issued batch while preserving executor policy.
   * Implementations should only parallelize calls that are explicitly safe
   * for concurrent execution.
   */
  executeBatch?(calls: ToolBatchCall[], signal?: AbortSignal): Promise<ToolBatchResult[]>;

  /** 사용 가능한 도구 목록 */
  list(): ToolDefinitionSummary[];

  /** 실제 도구 정의 조회. Middleware/decorators that need execute() can use this. */
  get?(name: string): ToolDefinition | undefined;

  /** 같은 실행 컨텍스트로 도구 목록을 교체한 executor 반환. */
  withTools?(tools: ToolDefinition[]): ToolExecutor;
}

export interface ToolBatchCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface ToolBatchResult {
  callId: string;
  name: string;
  result: ToolResult;
  isError: boolean;
}

export interface ToolDefinitionSummary {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface MemoryProvider {
  /** 메시지 추가 */
  append(message: ChatMessage): Promise<void>;

  /** 히스토리 조회 */
  getHistory(limit?: number): Promise<ChatMessage[]>;

  /** 컨텍스트 압축 (기존 compaction.ts 역할) */
  compact(): Promise<string | null>;

  /** 히스토리 초기화 */
  clear(): Promise<void>;
}

export interface AgentLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}
