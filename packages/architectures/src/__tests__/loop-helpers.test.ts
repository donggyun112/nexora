import { describe, it, expect } from 'vitest';
import { pruneLoopHistory, sanitizeToolPairsInPlace } from '../loop-helpers.js';
import type { LLMMessage } from '@dongkseo/contracts';

// chars/4 토큰 휴리스틱 기준으로 작은 임계값을 써서 픽스처를 가볍게 유지한다.
// threshold(tokens) = contextWindow - reserveTokens.
const OPTS = {
  contextWindow: 2000, // = 8000 chars
  reserveTokens: 0,
  keepRecentTokens: 500, // = 2000 chars 분량 tail 보호
  toolResultTruncateChars: 100,
};

function toolCallMsg(id: string): LLMMessage {
  return { role: 'assistant', content: [{ type: 'tool_call', id, name: 'web_search', arguments: {} }] };
}
function toolResultMsg(id: string, content: string): LLMMessage {
  return { role: 'tool_result', content: [{ type: 'tool_result', id, content, isError: false }] };
}

describe('pruneLoopHistory', () => {
  it('임계 미만이면 no-op (false) 이고 history 를 바꾸지 않는다', () => {
    const history: LLMMessage[] = [
      toolCallMsg('t1'),
      toolResultMsg('t1', 'x'.repeat(400)), // 100 tokens
      { role: 'assistant', content: 'short answer' },
    ];
    const before = JSON.stringify(history);

    const pruned = pruneLoopHistory(history, OPTS);

    expect(pruned).toBe(false);
    expect(JSON.stringify(history)).toBe(before);
  });

  it('임계 초과 시 오래된 큰 tool_result content 를 placeholder 로 치환하고 true 반환', () => {
    const history: LLMMessage[] = [
      toolCallMsg('t1'),
      toolResultMsg('t1', 'x'.repeat(6000)), // old + big (1500 tokens)
      toolCallMsg('t2'),
      toolResultMsg('t2', 'y'.repeat(6000)), // recent + big — tail 보호
    ];

    const pruned = pruneLoopHistory(history, OPTS);

    expect(pruned).toBe(true);
    // 오래된 t1 결과는 줄어든다
    const t1 = (history[1].content as Array<{ type: string; content: string }>)[0];
    expect(t1.content.length).toBeLessThan(6000);
    // 최근 t2 결과(tail)는 보존
    const t2 = (history[3].content as Array<{ type: string; content: string }>)[0];
    expect(t2.content).toBe('y'.repeat(6000));
  });

  it('최근 tail 안의 큰 tool_result 는 유일한 후보여도 건드리지 않는다 (false)', () => {
    const history: LLMMessage[] = [
      toolCallMsg('t1'),
      toolResultMsg('t1', 'z'.repeat(12000)), // over threshold 이지만 가장 최근 = tail
    ];
    const before = JSON.stringify(history);

    const pruned = pruneLoopHistory(history, OPTS);

    expect(pruned).toBe(false);
    expect(JSON.stringify(history)).toBe(before);
  });

  it('truncateChars 보다 작은 오래된 tool_result 는 건드리지 않는다', () => {
    const history: LLMMessage[] = [
      toolCallMsg('t1'),
      toolResultMsg('t1', 's'.repeat(80)), // old + small (< 100 chars)
      toolCallMsg('t2'),
      toolResultMsg('t2', 'y'.repeat(12000)), // recent + big
    ];

    pruneLoopHistory(history, OPTS);

    const t1 = (history[1].content as Array<{ type: string; content: string }>)[0];
    expect(t1.content).toBe('s'.repeat(80)); // 작아서 유지
  });

  it('프루닝 후에도 tool_call↔tool_result id 짝이 유효하다', () => {
    const history: LLMMessage[] = [
      toolCallMsg('t1'),
      toolResultMsg('t1', 'x'.repeat(6000)),
      toolCallMsg('t2'),
      toolResultMsg('t2', 'y'.repeat(6000)),
    ];

    pruneLoopHistory(history, OPTS);
    const beforeSanitize = history.length;
    sanitizeToolPairsInPlace(history); // orphan 이 생겼다면 여기서 길이가 바뀐다

    expect(history.length).toBe(beforeSanitize); // 짝이 깨지지 않아 변화 없음
    const ids = history
      .filter(m => m.role === 'tool_result')
      .flatMap(m => (m.content as Array<{ id: string }>).map(b => b.id));
    expect(ids).toEqual(['t1', 't2']);
  });
});
