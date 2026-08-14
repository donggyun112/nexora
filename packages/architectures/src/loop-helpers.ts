/**
 * loop-helpers — ReAct 계열 아키텍처가 공유하는 도구 실행 / history 위생 헬퍼.
 *
 * react.ts 와 deep-research.ts 가 동일한 도구 호출 처리·tool-pair sanitize 로직을
 * 공유한다. 한 곳에서 고치면 두 아키텍처 모두 반영된다.
 */

import { Buffer } from 'node:buffer';
import type {
  AgentEvent,
  AgentInput,
  ControlContext,
  HaltDecision,
  LLMContentBlock,
  LLMMessage,
  LLMResponse,
  PendingRuntimeInput,
  RuntimeServices,
  StopReason,
  SuspendRequest,
  ToolBatchCall,
  ToolBatchResult,
  ToolDecision,
  ToolResult,
} from '@dongkseo/contracts';
import {
  denyDecision,
  errorResult,
  imageBlocksFromResult,
  messageId,
  suspendResult,
} from '@dongkseo/contracts';

export { imageResultForLLM, imageBlocksFromResult, sanitizeToolPairsInPlace } from '@dongkseo/contracts';

export type ToolCall = NonNullable<LLMResponse['toolCalls']>[number];
export type ToolResultBlock = Extract<LLMContentBlock, { type: 'tool_result' }>;

/**
 * Exclusive calls are presented to the executor alone. The model can re-issue
 * the other calls after the exclusive result has been incorporated.
 */
export function selectToolCallsForExecution(
  services: RuntimeServices,
  toolCalls: ToolCall[],
): ToolCall[] {
  const exclusive = toolCalls.find((tc) => {
    const tool = services.tools.get?.(tc.name);
    if (!tool?.isExclusive) return false;
    return typeof tool.isExclusive === 'function'
      ? tool.isExclusive(tc.arguments)
      : tool.isExclusive;
  });
  return exclusive ? [exclusive] : toolCalls;
}

/**
 * 이 호출이 성공 시 루프를 끝내는가 — ToolDefinition.terminatesLoop 조회.
 * 정의를 노출하지 않는 executor(get 미구현)에서는 항상 false.
 */
export function toolTerminatesLoop(services: RuntimeServices, tc: ToolCall): boolean {
  const tool = services.tools.get?.(tc.name);
  if (!tool?.terminatesLoop) return false;
  return typeof tool.terminatesLoop === 'function'
    ? tool.terminatesLoop(tc.arguments)
    : tool.terminatesLoop;
}

/** Full model context disclosed by a tool only after its ordinary answer. */
export function contextMessagesFromResult(result: unknown): LLMMessage[] {
  if (!result || typeof result !== 'object') return [];
  const messages = (result as { contextMessages?: unknown }).contextMessages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message): LLMMessage[] => {
    if (!message || typeof message !== 'object') return [];
    const candidate = message as { content?: unknown; metadata?: unknown };
    if (typeof candidate.content !== 'string') return [];
    return [{
      role: 'user',
      content: candidate.content,
      ...(candidate.metadata && typeof candidate.metadata === 'object'
        ? { metadata: structuredClone(candidate.metadata as Record<string, unknown>) }
        : {}),
    }];
  });
}

// ── 턴 단위 control point ────────────────────────────────────────────────────
// react.ts 와 plan-execute.ts 가 같은 규약을 공유한다. 배선 순서의 원본은 python
// `engines/plain/loop.py` 의 `react_loop` / `_admit_turn_inputs` / `_decide_finish`.

/**
 * 정책이 보는 실행 스냅샷 — python `_control_ctx` 와 같은 것을 담는다.
 *
 * `subject` 는 TS `RuntimeServices` 에 출처가 없어 빈 문자열이다. ControlContext TSDoc 이
 * 정의한 "호스트가 말하지 않았다" 의 정직한 기본값 — 없는 이름을 여기서 지어내지 않는다.
 */
export function controlContext(
  turn: number,
  history: readonly LLMMessage[],
  callsMade: readonly ToolBatchCall[],
  text: string,
): ControlContext {
  return { turn, messages: [...history], callsMade: [...callsMade], text, subject: '' };
}

/**
 * 매 LLM 호출 직전에 "지금 모델을 불러도 되나"를 묻는다 — python `_admit_turn_inputs` 의
 * before_model 자리(입력 스크리닝 뒤, 모델 호출 앞).
 *
 * `proceed` 의 steers 는 호출 전에 history 에 합류하고, `halt` 면 그 결정을 돌려준다
 * (호출자가 그 자리에서 끝낸다). 미설정이면 아무 일도 일어나지 않는다.
 */
export async function askBeforeModel(
  services: RuntimeServices,
  history: LLMMessage[],
  ctx: ControlContext,
): Promise<HaltDecision | undefined> {
  if (!services.beforeModel) return undefined;
  const decision = await services.beforeModel(ctx);
  if (decision.kind === 'halt') return decision;
  history.push(...decision.steers);
  return undefined;
}

/**
 * 종료 직전, 그 종료를 받아들일지 묻는다 — python `_decide_finish` 의 before_finish 자리.
 *
 *   - `halt`    → 게이트가 준 reason 그대로 돌려준다. 게이트가 이유를 바꾸지 않는 만큼
 *                 루프도 바꾸지 않는다.
 *   - `proceed` → 종료하지 않는다. steers 를 history 에 합류시키고 undefined 를 돌려주면
 *                 호출자는 한 라운드 더 돈다(continuation 경로).
 *   - 미설정    → 주어진 reason 그대로 종료(`createControlPlane` 의 기본값과 같다).
 */
export async function askBeforeFinish(
  services: RuntimeServices,
  history: LLMMessage[],
  ctx: ControlContext,
  reason: StopReason,
): Promise<StopReason | undefined> {
  if (!services.beforeFinish) return reason;
  const decision = await services.beforeFinish(ctx, reason);
  if (decision.kind === 'halt') return decision.reason;
  history.push(...decision.steers);
  return undefined;
}

export type ToolCallOutcome = {
  tc: ToolCall;
  result: unknown;
  isError: boolean;
  /**
   * 게이트가 파킹하며 넘긴 질문. 아키텍처가 `onSuspend` 로 실어보내면 런타임이
   * 파킹을 기록한 뒤 발행한다. 도구가 스스로 suspend 한 경우엔 없다.
   */
  suspendRequest?: SuspendRequest;
};

/**
 * 모델이 요청한 배치를 실행한다. `services.preToolUse` 가 설정돼 있으면 각 호출마다
 * executor 를 건드리기 전에 먼저 묻는다.
 *
 * 게이트 답에 따라:
 *   - `continue` → executor 로 (배치 정책 그대로).
 *   - `deny`     → executor 에 보내지 않고 게이트가 준 결과를 그 호출의 결과로 합류.
 *   - `suspend`  → 여기서 `pendingId` 를 만들고 `suspendResult(pendingId)` 를 그 호출의
 *                  결과로 만든다. 게이트가 준 질문(`request`)은 outcome 에 실어 보내
 *                  `onSuspend` 까지 간다 — 발행은 파킹이 기록된 뒤 런타임이 한다
 *                  (ToolDecision 참고). 아키텍처의 기존 suspend 감지 경로가 그대로
 *                  처리한다(새 경로를 만들지 않는다).
 *
 * 게이트가 suspend 를 내면 tool.ts 의 "If it suspends, the remaining calls must not
 * start" 규약대로 남은 호출은 시작하지 않는다 — 게이트에 *묻지도* 않는다. 파킹되는 건
 * 한 호출뿐이라 나머지 질문은 어차피 답 받을 곳이 없다. 이미 통과한 앞선 호출은 그대로
 * 실행하고 결과를 보존한다(호출자가 completedResults 로 체크포인트한다).
 *
 * 미설정이면 게이트 왕복 없이 예전 경로 그대로다.
 *
 * 실제로 실행된 호출은 `services.afterToolCall` 로 기록된다 — 정책이 대신 답한
 * (deny/suspend) 호출은 기록하지 않는다. python `execute_calls` 가 `refused` 인 호출에
 * `record_resolved` 를 부르지 않는 것과 같다("A policy result stands in for an effect;
 * it must not claim that the tool ran").
 */
export async function executeToolCalls(
  services: RuntimeServices,
  toolCalls: ToolCall[],
  ctx: ControlContext,
): Promise<ToolCallOutcome[]> {
  const gate = services.preToolUse;
  if (!gate) return runToolCalls(services, toolCalls, ctx);

  const context = services.tools.getContext?.();
  const decided: { tc: ToolCall; decision: ToolDecision }[] = [];
  for (const tc of toolCalls) {
    const decision = await gate({
      call: { callId: tc.id, name: tc.name, input: tc.arguments },
      ...(context ? { context } : {}),
    });
    decided.push({ tc, decision });
    if (decision.kind === 'suspend') break;
  }

  const allowed = decided.filter(d => d.decision.kind === 'continue').map(d => d.tc);
  const executed = new Map(
    (allowed.length > 0 ? await runToolCalls(services, allowed, ctx) : []).map(out => [out.tc.id, out]),
  );

  const results: ToolCallOutcome[] = [];
  for (const { tc, decision } of decided) {
    if (decision.kind === 'deny') {
      // 거부는 모델에게 실패로 보여야 한다 — 도구가 돌지 않았고, terminatesLoop 같은
      // 성공 전용 판정도 타지 않아야 한다.
      results.push({ tc, result: decision.result, isError: true });
      continue;
    }
    if (decision.kind === 'suspend') {
      results.push({
        tc,
        result: suspendResult(messageId()),
        isError: false,
        suspendRequest: decision.request,
      });
      continue;
    }
    // executor 가 중간에 멈춘(abort / 배치 내 suspend) 호출은 결과가 없다 — 기존
    // runToolCalls 와 동일하게 결과 없이 빠진다.
    const out = executed.get(tc.id);
    if (out) results.push(out);
  }
  return results;
}

async function runToolCalls(
  services: RuntimeServices,
  toolCalls: ToolCall[],
  ctx: ControlContext,
): Promise<ToolCallOutcome[]> {
  if (services.tools.executeBatch) {
    const batchResults = await services.tools.executeBatch(
      toolCalls.map(tc => ({ callId: tc.id, name: tc.name, input: tc.arguments })),
      services.signal,
    );
    const merged = mergeBatchResults(toolCalls, batchResults);
    // 완료 순이 아니라 호출 순으로 기록한다 — python `_execute_batched` 와 같다.
    for (const out of merged) await recordResolved(services, ctx, out.tc, out.result);
    return merged;
  }

  const results: ToolCallOutcome[] = [];
  for (const tc of toolCalls) {
    if (services.signal.aborted) break;
    const result = await services.tools.execute(tc.name, tc.id, tc.arguments, services.signal);
    // 합류 전에 기록한다 — 기록이 실패(throw)하면 그 호출은 미해결로 남는다.
    await recordResolved(services, ctx, tc, result);
    results.push({ tc, result, isError: isErrorResult(result) });
    if (isSuspendResult(result)) break;
  }
  return results;
}

/** 도구가 실제로 돈 결과를 `afterToolCall` 에 넘긴다 — python `record_resolved`. */
async function recordResolved(
  services: RuntimeServices,
  ctx: ControlContext,
  tc: ToolCall,
  result: unknown,
): Promise<void> {
  if (!services.afterToolCall) return;
  await services.afterToolCall(ctx, { callId: tc.id, name: tc.name, input: tc.arguments }, result);
}

function mergeBatchResults(
  toolCalls: ToolCall[],
  batchResults: ToolBatchResult[],
): ToolCallOutcome[] {
  const byId = new Map(batchResults.map(result => [result.callId, result]));
  const completedCalls = batchResults.some(result => result.result.type === 'suspend')
    ? toolCalls.filter(tc => byId.has(tc.id))
    : toolCalls;
  return completedCalls.map((tc) => {
    const result = byId.get(tc.id);
    if (!result) {
      return {
        tc,
        result: { type: 'error' as const, message: `Missing tool result: ${tc.id}` },
        isError: true,
      };
    }
    return { tc, result: result.result, isError: result.isError };
  });
}

/**
 * 파킹을 런타임에 알린다.
 *
 * 게이트가 낸 질문(`request`)이 있는데 `onSuspend` 가 없으면 그 질문은 아무 데도 가지
 * 않는다 — 파킹도 기록되지 않고 발행도 되지 않는다. 승인 게이트를 달면서 suspended-turn
 * 저장소를 안 붙인 전형적인 오설정이고, 조용히 넘어가면 "승인이 영영 안 온다"의 이유를
 * 아무도 못 찾는다. 도구가 스스로 낸 suspend(`request` 없음)는 예전부터 같은 상태였으므로
 * 여기서 새로 시끄럽게 하지 않는다.
 */
export async function announceSuspend(
  services: RuntimeServices,
  info: Parameters<NonNullable<RuntimeServices['onSuspend']>>[0],
): Promise<void> {
  if (!services.onSuspend) {
    if (info.request) {
      services.logger.error('suspend.unhandled', {
        pendingId: info.pendingId,
        toolCallId: info.toolCallId,
        topic: info.request.topic,
        reason:
          'a gate parked this call, but no onSuspend is wired — the question was ' +
          'neither persisted nor published, so no answer can ever arrive',
      });
    }
    return;
  }
  await services.onSuspend(info);
}

export function suspendHistorySnapshot(
  history: LLMMessage[],
  completedResults: ToolResultBlock[],
  suspendedCallId: string,
): LLMMessage[] {
  const retainedCallIds = new Set([
    suspendedCallId,
    ...completedResults.map(result => result.id),
  ]);
  let suspendingMessageIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some(block => block.type === 'tool_call' && block.id === suspendedCallId)
    ) {
      suspendingMessageIndex = i;
      break;
    }
  }

  return history.map((message, index) => {
    if (!Array.isArray(message.content)) return { ...message };
    const content = index === suspendingMessageIndex
      ? message.content.filter(block => block.type !== 'tool_call' || retainedCallIds.has(block.id))
      : [...message.content];
    return { ...message, content };
  });
}

/**
 * 재개 진입부 — 파킹됐던 호출의 결과를 history 에 합류시킨다. react.ts 와
 * plan-execute.ts 가 같은 규약을 공유하므로 여기 한 곳에 둔다.
 *
 * `services.onResume` 이 설정돼 있고 체크포인트에 원본 호출(`resumedCall`)과 포장 전
 * 답변(`resumeAnswer`)이 실려 있으면 현재 정책으로 재검증한다:
 *   - `continue` → 그 도구를 *지금* 실행하고 그 결과를 재개된 호출의 결과로 쓴다.
 *                  (재실행은 preToolUse 를 다시 타지 않는다 — onResume 이 그 재검증이다.
 *                   다시 물으면 승인 게이트가 영원히 재파킹한다.)
 *   - `deny`     → 그 결과를 쓴다. 도구는 실행하지 않는다.
 *   - `suspend`  → 다시 파킹한다(기존 suspend 경로 재사용).
 *
 * 답변 자체가 error 결과면 정책을 묻지 않고 그대로 거부한다 — 아래 주석 참고.
 *
 * 훅이 미설정이거나 체크포인트에 원본이 없으면 예전 동작 그대로 — 답변을 그 호출의
 * 결과로 주입한다.
 *
 * 반환값 false = 턴이 다시 파킹됐다. 호출자는 즉시 return 해야 한다.
 */
export async function* injectResumedToolResult(
  services: RuntimeServices,
  resume: NonNullable<AgentInput['resumeContext']>,
  history: LLMMessage[],
): AsyncGenerator<AgentEvent, boolean> {
  history.push(...resume.architectureHistory);
  const completedResults = resume.completedResults ?? [];

  const call = resume.resumedCall;
  const context = services.tools.getContext?.();
  // 답변 자체가 실패인 경우(승인 채널·어댑터 장애, 잘못된 응답)는 정책에 묻지 않고 그
  // 실패를 그대로 결과로 쓴다. 게이트에 넘기면 "choice 가 없다"로 읽혀 인프라 장애가
  // 프로토콜 실수처럼 보고된다. python `Orchestrator.resume_effect` 가 같은 자리에서
  // 같은 단축을 한다.
  const decision: ToolDecision | undefined = (services.onResume && call && resume.resumeAnswer)
    ? isErrorResult(resume.resumeAnswer.answer)
      ? denyDecision(resume.resumeAnswer.answer as ToolResult)
      : await services.onResume({
        call: { callId: resume.resumedCallId, name: call.name, input: call.input },
        ...(context ? { context } : {}),
        resume: resume.resumeAnswer,
      })
    : undefined;

  let result: unknown = resume.toolResult;
  let isError = isErrorResult(resume.toolResult);
  let ran = false;
  // 재파킹도 첫 파킹과 같다 — 여기서 pendingId 를 만들고, 질문은 onSuspend 로 넘겨
  // 런타임이 새 파킹을 기록한 뒤 발행한다.
  let suspendRequest: SuspendRequest | undefined;

  if (decision?.kind === 'deny') {
    result = decision.result;
    isError = true;
  } else if (decision?.kind === 'suspend') {
    result = suspendResult(messageId());
    isError = false;
    suspendRequest = decision.request;
  } else if (decision?.kind === 'continue') {
    // 원래 turn 에서 이미 tool_call 을 방출했지만 이 실행은 새 프로세스일 수 있다 —
    // 정상 경로와 같은 tool_call → tool_result 쌍을 방출해 미들웨어/트랜스크립트가
    // 짝을 볼 수 있게 한다.
    yield { type: 'tool_call', id: resume.resumedCallId, name: call!.name, input: call!.input };
    // 재개된 실행도 기록 대상이다(python `Orchestrator.resume_effect` 도 `record_resolved`
    // 를 부른다). 재개 시점엔 라운드 번호가 없어 turn 0 으로 둔다.
    const [out] = await runToolCalls(
      services,
      [{ id: resume.resumedCallId, name: call!.name, arguments: call!.input }],
      controlContext(0, history, [], ''),
    );
    result = out ? out.result : errorResult(`Resumed tool call did not run: ${resume.resumedCallId}`);
    isError = out ? out.isError : true;
    ran = true;
    yield { type: 'tool_result', id: resume.resumedCallId, name: call!.name, result, isError };
  }

  if (isSuspendResult(result)) {
    const pendingId = (result as { pendingId: string }).pendingId;
    yield { type: 'suspended', pendingId, toolCallId: resume.resumedCallId };
    await announceSuspend(services, {
      pendingId,
      toolCallId: resume.resumedCallId,
      architectureHistory: suspendHistorySnapshot(history, completedResults, resume.resumedCallId),
      completedResults,
      ...(call ? { call } : {}),
      ...(suspendRequest ? { request: suspendRequest } : {}),
    });
    return false;
  }

  history.push({
    role: 'tool_result',
    content: [
      ...completedResults,
      {
        type: 'tool_result',
        id: resume.resumedCallId,
        content: formatResultForLLM(result),
        isError,
      },
    ],
  });

  // 도구가 실제로 돈 경우만 부가 컨텍스트를 합류시킨다 — 주입 경로(훅 미설정)의
  // history 는 예전과 한 글자도 달라지지 않아야 한다.
  if (ran) {
    const images = imageBlocksFromResult(result);
    if (images.length > 0) {
      history.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Tool ${call!.name} returned ${images.length === 1 ? 'an image' : `${images.length} images`} for call ${resume.resumedCallId}. Use ${images.length === 1 ? 'this image' : 'these images'} as visual context for the current task.`,
          },
          ...images,
        ],
      });
    }
    history.push(...contextMessagesFromResult(result));
  }

  return true;
}

function isSuspendResult(result: unknown): boolean {
  return Boolean(
    result &&
    typeof result === 'object' &&
    (result as { type?: string }).type === 'suspend',
  );
}

/**
 * 한 턴 내부 history 압축 옵션. 임계값은 토큰(문자/4 휴리스틱) 기준.
 * 모두 선택 — 미지정이면 TwoStageCompactor 와 동일한 기본값.
 */
export interface LoopCompactionOptions {
  /** 컨텍스트 윈도우 (토큰). 기본 200_000 */
  contextWindow?: number;
  /** 시스템 프롬프트 + 응답 예약 토큰. 기본 16_384 */
  reserveTokens?: number;
  /** 압축해도 건드리지 않을 최근 tail (토큰). 기본 20_000 */
  keepRecentTokens?: number;
  /** 이 길이보다 긴 tool_result content 만 프루닝 대상. 기본 4_000자 */
  toolResultTruncateChars?: number;
}

const PRUNE_PLACEHOLDER = '[older tool output pruned to fit context]';
const IMAGE_TOKEN_ESTIMATE = 1024;
const MAX_INLINE_FILE_CHARS = 64_000;
const TEXT_FILE_MIME_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/typescript',
  'application/x-javascript',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml',
  'text/yaml',
]);
const TEXT_FILE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.log',
  '.md',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

export function userContentForInput(
  input: AgentInput,
  promptText = input.prompt,
): string | LLMContentBlock[] {
  const text = appendInputFileSummaries(promptText, input.files);
  const imageBlocks: Extract<LLMContentBlock, { type: 'image' }>[] = [];

  for (const img of input.images ?? []) {
    imageBlocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  }
  for (const file of input.files ?? []) {
    if (isImageMime(file.mimeType)) {
      imageBlocks.push({ type: 'image', data: file.data, mimeType: file.mimeType });
    }
  }

  if (imageBlocks.length === 0) return text;
  return [{ type: 'text', text }, ...imageBlocks];
}

/**
 * Move one ordered input group across the runtime/planner admission boundary.
 * Falls back to the legacy synchronous steer queue when no orchestrator is attached.
 *
 * 합류 전에 `services.onInputs` 가 입력을 거른다 — python `_admit_turn_inputs` 의
 * 스크리닝 자리. 돌려준 배열이 실제로 모델 컨텍스트에 들어가는 것이고(빈 배열도 정당한
 * 답), `halt` 면 그 결정을 그대로 돌려준다. 걸러진 입력은 큐에 남기지 않고 버린다.
 * 훅이 미설정이면 예전 경로 그대로다.
 *
 * 반환값: 합류한 입력 개수, 또는 정책이 실행을 끝내라고 하면 그 `halt`.
 */
export async function absorbRuntimeInputs(
  services: RuntimeServices,
  history: LLMMessage[],
  ctx: ControlContext,
  promptText: (input: AgentInput) => string = input => input.prompt,
): Promise<number | HaltDecision> {
  const screen = services.onInputs;

  if (!services.inputs) {
    const steers = services.drainSteers?.() ?? [];
    if (!screen || steers.length === 0) {
      history.push(...steers);
      return steers.length;
    }
    // 큐(`drainSteers`)와 정책은 다른 것이지만, 모델 컨텍스트에 들어가는 건 같은
    // 메시지다 — 스크리닝이 보는 형태로 감싸서 같은 관문을 지나게 한다.
    const screened = await screen(ctx, steers.map(message => ({ kind: 'steer', message })));
    if (!Array.isArray(screened)) return screened;
    for (const input of screened) history.push(messageForRuntimeInput(input, promptText));
    return screened.length;
  }

  const representedIds = new Set(
    history.flatMap(message => message.id ? [message.id] : []),
  );
  let inputs = await services.inputs.claim(representedIds);
  if (screen && inputs.length > 0) {
    const screened = await screen(ctx, inputs);
    if (!Array.isArray(screened)) return screened;
    const surviving = new Set(screened.flatMap(input => input.originId ? [input.originId] : []));
    const discarded = inputs.filter(
      input => input.originId !== undefined && !surviving.has(input.originId),
    );
    if (discarded.length > 0) await services.inputs.discard(discarded);
    inputs = screened;
  }
  for (const input of inputs) {
    history.push(messageForRuntimeInput(input, promptText));
  }
  if (inputs.length > 0) await services.inputs.admit(inputs);
  return inputs.length;
}

function messageForRuntimeInput(
  pending: PendingRuntimeInput,
  promptText: (input: AgentInput) => string,
): LLMMessage {
  if ('input' in pending) {
    return {
      ...(pending.originId ? { id: pending.originId } : {}),
      role: 'user',
      content: userContentForInput(pending.input, promptText(pending.input)),
    };
  }
  return {
    ...structuredClone(pending.message),
    ...(pending.originId ? { id: pending.originId } : {}),
  };
}

function appendInputFileSummaries(
  promptText: string,
  files: AgentInput['files'] | undefined,
): string {
  if (!files?.length) return promptText;

  const parts: string[] = ['Attached files:'];
  for (const file of files) {
    const label = fileLabel(file);
    if (isImageMime(file.mimeType)) {
      parts.push(`- ${label}: image attached as visual context.`);
      continue;
    }

    if (!isTextLikeFile(file)) {
      parts.push(`- ${label}: binary content not inlined.`);
      continue;
    }

    const text = decodeFileText(file.data);
    if (text === null) {
      parts.push(`- ${label}: text-like file could not be decoded as UTF-8.`);
      continue;
    }

    parts.push(`--- ${label} ---\n${truncateInlineFileText(text)}\n--- end ${label} ---`);
  }

  const attachmentText = parts.join('\n\n');
  return promptText ? `${promptText}\n\n${attachmentText}` : attachmentText;
}

function fileLabel(file: NonNullable<AgentInput['files']>[number]): string {
  const name = file.name ? `"${file.name}"` : 'unnamed file';
  const size = typeof file.size === 'number' ? `, ${file.size} bytes` : '';
  return `${name} (${file.mimeType}${size})`;
}

function isImageMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('image/');
}

function isTextLikeFile(file: NonNullable<AgentInput['files']>[number]): boolean {
  const mimeType = file.mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (mimeType.startsWith('text/')) return true;
  if (TEXT_FILE_MIME_TYPES.has(mimeType)) return true;
  const name = file.name?.toLowerCase() ?? '';
  return [...TEXT_FILE_EXTENSIONS].some(ext => name.endsWith(ext));
}

function decodeFileText(data: string): string | null {
  try {
    const base64 = stripDataUrlPrefix(data).replace(/\s+/g, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.includes(0)) return null;
    const text = buffer.toString('utf-8');
    const replacementChars = text.match(/\uFFFD/g)?.length ?? 0;
    if (replacementChars > Math.max(3, Math.floor(text.length * 0.01))) return null;
    return text;
  } catch {
    return null;
  }
}

function stripDataUrlPrefix(data: string): string {
  const match = /^data:[^;]+;base64,(.+)$/i.exec(data.trim());
  return match ? match[1] : data;
}

function truncateInlineFileText(text: string): string {
  if (text.length <= MAX_INLINE_FILE_CHARS) return text;
  return `${text.slice(0, MAX_INLINE_FILE_CHARS)}\n[truncated ${text.length - MAX_INLINE_FILE_CHARS} chars]`;
}

function estimateBlockTokens(content: LLMMessage['content']): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4);
  let total = 0;
  for (const b of content as LLMContentBlock[]) {
    if (b.type === 'text') total += Math.ceil(b.text.length / 4);
    else if (b.type === 'tool_call') total += Math.ceil(JSON.stringify(b.arguments).length / 4);
    else if (b.type === 'tool_result') total += Math.ceil(b.content.length / 4);
    else if (b.type === 'image') total += IMAGE_TOKEN_ESTIMATE;
  }
  return total;
}

function estimateHistoryTokens(history: LLMMessage[]): number {
  return history.reduce((sum, m) => sum + estimateBlockTokens(m.content), 0);
}

/**
 * 한 턴 내부에서 누적된 로컬 history 를 in-place 로 프루닝한다. LLM 호출 없는 결정적 동작.
 *
 * 추정 토큰이 (contextWindow - reserveTokens) 이하면 아무것도 안 하고 false.
 * 초과하면 최근 keepRecentTokens 분량 tail 을 보호한 채, 오래된 것부터 큰 tool_result
 * content 를 placeholder 로 치환해 임계 밑으로 내린다. 프루닝했으면 true.
 *
 * tool_result 의 id·블록 구조는 그대로 두고 content 문자열만 줄이므로 tool_call↔tool_result
 * 짝은 항상 유효하다. placeholder 는 짧아 재호출 시 다시 대상이 되지 않는다(idempotent).
 *
 * 가장 최근 tool_result 가 유일한 후보면(= tail 보호 영역) 줄이지 않는다 — 최근 컨텍스트를
 * 한 턴 내 안전보다 우선한다.
 */
export function pruneLoopHistory(history: LLMMessage[], opts: LoopCompactionOptions = {}): boolean {
  const contextWindow = opts.contextWindow ?? 200_000;
  const reserveTokens = opts.reserveTokens ?? 16_384;
  const keepRecentTokens = opts.keepRecentTokens ?? 20_000;
  const truncateChars = opts.toolResultTruncateChars ?? 4_000;
  const threshold = contextWindow - reserveTokens;

  if (estimateHistoryTokens(history) <= threshold) return false;

  // 최근 tail 보호 경계: 끝에서부터 토큰을 누적해 keepRecentTokens 를 덮는 첫 index.
  // [protectedFrom, end) 는 보호 — 최소한 마지막 메시지는 항상 보호된다.
  let tailTokens = 0;
  let protectedFrom = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    protectedFrom = i;
    tailTokens += estimateBlockTokens(history[i].content);
    if (tailTokens >= keepRecentTokens) break;
  }

  let pruned = false;
  for (let i = 0; i < protectedFrom; i++) {
    if (estimateHistoryTokens(history) <= threshold) break;
    const msg = history[i];
    if (msg.role !== 'tool_result' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as LLMContentBlock[]) {
      if (block.type === 'tool_result' && block.content.length > truncateChars) {
        block.content = PRUNE_PLACEHOLDER;
        pruned = true;
      }
    }
  }
  return pruned;
}

export function isErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return (result as { type?: string }).type === 'error';
}

export function formatResultForLLM(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result);
  const r = result as {
    type?: string;
    text?: string;
    message?: string;
    blocks?: Array<{ type?: string; text?: string }>;
  };
  if (r.type === 'text' && typeof r.text === 'string') return r.text;
  if (r.type === 'error' && typeof r.message === 'string') return `[ERROR] ${r.message}`;
  if (r.type === 'image') return '[image]';
  if (r.type === 'content' && Array.isArray(r.blocks)) {
    // Text summary only — images are attached as separate LLM image blocks by
    // the caller. Never JSON.stringify a content result or its base64 leaks here.
    return r.blocks
      .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '[image]'))
      .join('\n');
  }
  return JSON.stringify(result);
}
