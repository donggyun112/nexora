import type { ToolDefinition, ToolContext, ToolResult } from './tool.js';
import type {
  AfterToolCall,
  BeforeFinish,
  BeforeModel,
  OnInputs,
  OnResume,
  PreToolUse,
  ResumeAnswer,
  SuspendRequest,
} from './controls.js';
import type { OutboundArtifact } from './adapter.js';

/**
 * Agent 런타임 계약.
 *
 * 기존 runner.ts의 Agent, CreateAgentOpts, RunOptions, StreamAgentHandle을
 * 인터페이스로 추출.
 */

export interface AgentInput {
  /** Stable ingress id used to deduplicate a retried turn. */
  inputId?: string;

  /** 사용자 프롬프트 */
  prompt: string;

  /** 이미지 첨부 */
  images?: ImageContent[];

  files?: FileContent[];

  /** 이전 대화 히스토리 (rich — tool/image 블록 포함) */
  history?: LLMMessage[];

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
    /** Results that completed in the same batch before the turn suspended. */
    completedResults?: Array<Extract<LLMContentBlock, { type: 'tool_result' }>>;
    resumedCallId: string;
    toolResult: ToolResult;
    /**
     * The parked call's name and input, carried through the checkpoint
     * (`SuspendedTurnState.call`).
     *
     * Needed because `onResume` may answer `continue`, which means "run that
     * tool now" — and running it takes the name and input, not just the id.
     * Optional so every existing caller (and every resume that predates the
     * hook) keeps working; absent → `onResume` is not consulted and the answer
     * is injected as the result, exactly as before.
     */
    resumedCall?: { name: string; input: unknown };
    /**
     * The reply as it arrived, before anyone formatted it into `toolResult`.
     * `onResume` has to read whether the human approved or refused, which
     * `textResult(...)` has already thrown away. Optional for the same reason
     * as `resumedCall`.
     */
    resumeAnswer?: ResumeAnswer;
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

export interface FileContent {
  type: 'file';
  data: string;
  mimeType: string;
  name?: string;
  size?: number;
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
  | { type: 'done'; content: string; toolCalls: ToolCallSummary[]; usage?: LLMUsage; model?: string }
  | { type: 'error'; message: string }
  | { type: 'suspended'; pendingId: string; toolCallId: string }
  /**
   * 게이트가 호출을 거부했다 — python `EventType.PERMISSION_DENIED`.
   *
   * `result` 는 모델이 대신 보게 되는 결과다(`ToolDecision.deny` 의 것 그대로).
   */
  | {
      type: 'permission_denied';
      callId: string;
      name: string;
      source: PermissionSource;
      result: unknown;
    }
  /**
   * 게이트가 호출을 파킹하고 질문을 냈다 — python `EventType.PERMISSION_REQUEST`.
   *
   * `pendingId` 는 런타임이 민팅한 실제 파킹 id 이므로 `suspended` 이벤트·체크포인트와
   * 같은 값이다.
   */
  | {
      type: 'permission_request';
      callId: string;
      name: string;
      source: PermissionSource;
      pendingId: string;
    }
  /**
   * 게이트가 호출을 통과시키면서 기록할 감사 정보를 실어 보냈다.
   *
   * **python `EventType` 에는 대응이 없다 — 의도적으로 추가한 것이다.** 거부가 감사
   * 대상인 이유(권한 결정이 트랜스크립트에 남아야 한다)는 승인에도 똑같이 적용되는데,
   * 승인 게이트를 도구 래퍼에서 control point 쌍으로 옮기면서 도구 결과에 붙던
   * `[approved-<choice> by <who>]` 감사 footer가 사라졌다 — 게이트가 더 이상 도구를
   * 감싸지 않아 결과를 후처리할 자리가 없다. 그 기록을 되살리되 모델 컨텍스트가 아니라
   * 관찰 채널로 되살리는 것이 이 이벤트다(승인자 이름이 모델에게 보이지 않는 게 이
   * 설계의 이점이다). 나중에 python 과의 일치 여부를 다시 볼 사람은 이 빈칸을 실수가
   * 아니라 판단으로 읽어야 한다.
   *
   * 통과 전부가 아니라 `ToolDecision.continue` 가 `audit` 을 실어 보낸 통과만 이 이벤트가
   * 된다 — `loop-helpers.ts` 의 발행 규칙 참고.
   */
  | {
      type: 'permission_granted';
      callId: string;
      name: string;
      source: PermissionSource;
      audit: Record<string, unknown>;
    };

/**
 * 권한 결정이 나온 자리. python `tool_payload(..., source=...)` 가 싣는 문자열과 같은 값
 * 이다 — 같은 거부라도 `pre_tool_use` 는 아예 돌지 않은 호출이고, `on_resume` 은 사람의
 * 승인이 파킹 중 바뀐 정책에 뒤집힌 것이라 읽는 쪽이 구별해야 한다.
 */
export type PermissionSource = 'pre_tool_use' | 'on_resume';

export interface ToolCallSummary {
  name: string;
  input: unknown;
}

/**
 * ExecutionHarness — runner가 위임하는 실제 실행 드라이버.
 *
 * Local ReAct, remote worker, deterministic pipeline처럼 실행 방식이 달라도
 * 이 계약으로 event stream, abort, steering을 맞춘다.
 */
export interface ExecutionHarness {
  /** 에이전트 실행 (이벤트 스트림 반환) */
  execute(input: AgentInput): AsyncGenerator<AgentEvent>;

  /** 실행 중단 */
  abort(): void;

  /**
   * 실행 중인 에이전트에 user 메시지를 주입(steer). 다음 루프 반복에서 LLM 호출 전
   * history 에 도착순으로 합류한다. 활성 실행이 있으면 큐에 넣고 `true`, 없으면 주입할
   * 곳이 없어 `false` 를 반환한다(호출자가 새 turn 으로 처리). 미구현 시 undefined.
   */
  steer?(text: string): boolean;
}

/**
 * AgentRuntime — 모든 에이전트가 구현해야 하는 실행 인터페이스.
 * core 패키지에서 구현.
 */
export interface AgentRuntime extends ExecutionHarness {}

/**
 * AgentArchitecture — 사고 패턴 정의.
 * architectures 패키지에서 구현.
 *
 * 기존 runner.ts의 단일 루프를 플러그인 가능한 아키텍처로 분리.
 */
export interface AgentArchitecture {
  /** 아키텍처 이름 (react, 또는 외부에서 정의한 커스텀 아키텍처) */
  name: string;

  /** 초기 시스템 프롬프트 — 로깅·관찰용 (옵션) */
  systemPrompt?: string;

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

  /** Optional runtime-owned admission queue. Planners append and admit at the model boundary. */
  inputs?: RuntimeInputAdmission;

  /**
   * 실행 중 주입(steer)된 user 메시지를 큐에서 꺼낸다(소비). 아키텍처는 매 루프 반복
   * LLM 호출 직전, 그리고 종료 직전에 호출해 history 에 도착순으로 합류시켜야 한다.
   * 큐가 비면 빈 배열. 미설정이면 steering 미지원(no-op).
   */
  drainSteers?: () => LLMMessage[];

  /**
   * 큐에서 꺼낸 입력이 모델 컨텍스트에 들어가기 전에 걸러진다. 반환된 배열이
   * 실제로 합류하는 입력이고, 빈 배열도 정당한 답이다(전부 걸러냄). `halt` 면
   * 그 자리에서 실행이 끝난다. 미설정이면 입력은 그대로 통과한다.
   */
  onInputs?: OnInputs;

  /**
   * 매 LLM 호출 직전에 "지금 모델을 불러도 되나"를 정책에 묻는다. `proceed` 의
   * steers 는 호출 전에 history 에 합류한다. `drainSteers` 와 자리가 겹쳐 보이지만
   * 다른 것이다 — 저것은 하네스가 받아둔 steer 를 꺼내는 큐(서비스)고, 이것은
   * 정책이다. 미설정이면 steering 없이 진행한다.
   */
  beforeModel?: BeforeModel;

  /**
   * 도구 결과가 나온 직후 기록·검증한다. 반환값이 없으므로 이의는 throw 로
   * 표현하고, 그건 모델에게 보이는 도구 실패가 아니라 시도 중단이 된다.
   */
  afterToolCall?: AfterToolCall;

  /**
   * 실행이 끝나려는 순간, 그 종료를 받아들일지 묻는다. `halt` 면 그 reason 으로
   * 끝나고, `proceed` 면 종료를 거부하고 steers 를 주입해 한 라운드 더 돈다 —
   * budget/verification gate 가 꽂히는 자리다.
   *
   * boolean 훅(구 `shouldStopAfterTurn`)이 표현하지 못하던 것이 이 continuation
   * 이다. "아직"만 말할 수 있었지 "무엇이 빠졌는지"는 말할 수 없었다.
   * 미설정이면 주어진 reason 그대로 종료한다(`createControlPlane` 기본값).
   */
  beforeFinish?: BeforeFinish;

  /**
   * 모델이 도구를 호출하려는 순간, 실행 전에 "이걸 실행해도 되나?"를 앱 정책에 묻는다.
   * 배치의 각 호출마다 한 번씩, executor 를 건드리기 전에 호출된다.
   *
   * `continue` 면 그대로 실행, `deny` 면 실행하지 않고 그 결과를 모델에 준다,
   * `suspend` 면 그 호출을 파킹한다 — 게이트는 무엇을 물을지(`SuspendRequest`)만
   * 돌려주고 publish 하지 않는다. pendingId 민팅도 발행도 런타임 몫이다
   * (`ToolDecision` 참고). 사람의 답을 타임아웃으로 기다리지 않고 턴을 중단하는
   * 자리이므로, 승인 게이트는 여기 꽂힌다.
   *
   * 미설정이면 게이팅 없이 실행된다.
   */
  preToolUse?: PreToolUse;

  /**
   * 파킹된 호출의 답이 도착했을 때, 현재 정책으로 그 호출과 답을 재검증한다.
   * 파킹 중에 정책이 바뀔 수 있으므로 답만으로 결정하지 않는다.
   *
   * `answer` 는 포장되지 않은 원본 payload 다 — 승인/거부를 읽어야 하기 때문이다.
   * 반환값의 의미는 `OnResume` TSDoc 참고.
   *
   * 미설정이면 재개는 현재 동작을 유지한다(답변을 그대로 그 호출의 결과로 주입).
   */
  onResume?: OnResume;

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
    completedResults: Array<Extract<LLMContentBlock, { type: 'tool_result' }>>;
    /**
     * The parked call itself. Persisted into `SuspendedTurnState.call` so the
     * resume path can hand it to `onResume` and, on `continue`, actually run it.
     * Optional: architectures that predate the tool-decision contract still call
     * this hook without it, and a checkpoint without it just falls back to
     * injecting the answer as the result.
     */
    call?: { name: string; input: unknown };
    /**
     * The question to publish for this park, when a gate asked for one. The
     * handler publishes it AFTER persisting the park — see the `suspend` branch
     * of `ToolDecision`.
     *
     * Optional: a tool that suspended on its own (the human branch of the
     * handraise tool) already published its question, so there is nothing here.
     */
    request?: SuspendRequest;
  }) => Promise<void>;
}

export interface LLMProvider {
  /** 텍스트 생성 (스트리밍) */
  stream(messages: LLMMessage[], options?: LLMOptions): AsyncGenerator<LLMChunk>;

  /** 텍스트 생성 (완료까지 대기) */
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

export interface LLMMessage {
  /** Stable ingress id when this message came through RuntimeInputAdmission. */
  id?: string;
  /** Runtime-only provenance for context injected by tools such as a loaded skill. */
  metadata?: Record<string, unknown>;
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  content: string | LLMContentBlock[];
}

/** One queued input with provenance kept separate from model-visible message content. */
export type PendingRuntimeInput =
  | {
      kind: 'user_prompt';
      originId?: string;
      input: AgentInput;
    }
  | {
      kind: string;
      originId?: string;
      message: LLMMessage;
    };

/** Runtime-owned input boundary consumed by a planner immediately before a model call. */
export interface RuntimeInputAdmission {
  submit(input: PendingRuntimeInput): Promise<PendingRuntimeInput>;
  claim(representedIds?: ReadonlySet<string>): Promise<PendingRuntimeInput[]>;
  admit(inputs: readonly PendingRuntimeInput[]): Promise<void>;
  discard(inputs: readonly PendingRuntimeInput[]): Promise<void>;
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
  | { type: 'done'; content: string; stopReason: string; usage?: LLMUsage };

export interface LLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
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
  /** Tokens written to prompt cache / cache creation (Anthropic). 0 if not applicable. */
  cacheWriteTokens?: number;
}

export interface LLMResponse {
  content: string;
  /** Reasoning/thinking text, when thinkingLevel is on and the provider returns it. */
  thinking?: string;
  model: string;
  stopReason: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  /** Token usage from the API. Undefined if the provider doesn't report it. */
  usage?: LLMUsage;
}

export interface ToolExecutor {
  /**
   * Refresh dynamic tool discovery before a model request. Implementations must
   * not load deferred bodies here; only schemas/discovery metadata may change.
   */
  prepare?(messages: LLMMessage[]): void | Promise<void>;

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

  /** 같은 도구 목록으로 실행 컨텍스트를 교체한 executor 반환. */
  withContext?(context: ToolContext): ToolExecutor;

  /** 현재 실행 컨텍스트 조회. Harness가 workspace/session을 주입할 때 사용한다. */
  getContext?(): ToolContext;
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
  append(message: LLMMessage): Promise<void>;

  /** 히스토리 조회 */
  getHistory(limit?: number): Promise<LLMMessage[]>;

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
