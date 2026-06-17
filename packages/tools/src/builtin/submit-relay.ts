/**
 * submit_relay — relay/coordinator 에이전트(예: product-context `product.<id>`)가
 * 사이클 결과를 호출자에게 돌려주는 generic 종료 도구.
 *
 * 배경: thread-bound 에이전트는 `submit_*` 호출을 마커로 사이클을 종료한다
 * (`src/main.ts` 의 `thread-submit-complete` 미들웨어가 호출을 감지해
 *  `ThreadAgentRegistry.completeThread` → `publishThreadResult` 로
 *  `<capability>.completed` / `<capability>.failed` 계열 토픽 발화). 콘텐츠/이미지/키워드 같은 산출물 전용
 *  `submit_*` 와 달리, relay 에이전트는 위임 결과를 그대로 넘기거나 context-only
 *  응답을 마무리하는 역할이라 산출물 스키마가 자유롭다 — 그래서 generic 결과
 *  마커가 필요하다.
 *
 *  이 도구가 없을 때의 증상: in7-agent 가 사이클 종료 트리거를 못 내서 turn 이
 *  끝나도 `product.in7.completed` 가 publish 안 되고, 60분 idle timeout 후에야
 *  `failed` 로 끝난다. (`runtime/thread-lifecycle.ts:92`)
 */

import type { ToolContext, ToolDefinition, ToolResult } from '@dongkseo/contracts';

const PARAMETERS = {
  type: 'object',
  required: ['summary'],
  properties: {
    summary: {
      type: 'string',
      description:
        '호출자에게 보고할 짧은 자연어 요약 (1~3 문장). 사이클 결과의 핵심.',
    },
    artifact: {
      description:
        '선택. 위임 결과를 받았거나 구조화된 결과가 있으면 그대로 동봉한다. ' +
        '없으면 omit — 단순 context-only 응답이면 summary 만으로 충분.',
    },
    status: {
      type: 'string',
      enum: ['completed', 'failed'],
      description:
        '선택. 기본 completed. failed 로 주면 thread-submit-complete 가 <capability>.failed 계열 토픽으로 라우팅한다.',
    },
  },
  additionalProperties: false,
} as const;

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function createSubmitRelayTool(): ToolDefinition {
  return {
    name: 'submit_relay',
    description:
      'relay/coordinator 에이전트(product-context 등)가 사이클을 종료할 때 호출. ' +
      'thread-bound 실행에서는 thread-submit-complete 미들웨어가 이 호출을 감지해 ' +
      'completed/failed 결과 토픽으로 publish 한다.',
    parameters: PARAMETERS as unknown as Record<string, unknown>,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    maxResultSizeChars: 8_000,

    async execute(_callId: string, rawInput: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const input = asObject(rawInput);
      const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
      if (!summary) {
        return { type: 'error', message: 'summary is required (non-empty string)' };
      }

      const status = input.status === 'failed' ? 'failed' : 'completed';
      const payload: Record<string, unknown> = {
        ok: status === 'completed',
        status,
        summary,
      };
      if (input.artifact !== undefined) payload.artifact = input.artifact;

      return {
        type: 'text',
        text: JSON.stringify(payload),
      };
    },
  };
}
