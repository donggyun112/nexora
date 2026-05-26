import { describe, it, expect } from 'vitest';
import { toAgentMessages, convertToLlm } from '../pi-agent/message-bridge.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

describe('toAgentMessages', () => {
  it('builds a single user message from AgentInput.prompt', () => {
    const r = toAgentMessages({ prompt: 'hello' });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('includes ChatMessage history before the new prompt', () => {
    const r = toAgentMessages({
      prompt: 'next question',
      history: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
      ],
    });
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ role: 'user', content: 'first' });
    expect(r[1]).toMatchObject({ role: 'assistant' });
    expect(r[2]).toMatchObject({ role: 'user', content: 'next question' });
  });

  it('attaches images to the user prompt as ImageContent blocks', () => {
    const r = toAgentMessages({
      prompt: 'see this',
      images: [{ type: 'image', data: 'BASE64', mimeType: 'image/png' }],
    });
    const last = r[r.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as unknown as Array<{ type: string }>;
    expect(blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'see this' }),
      expect.objectContaining({ type: 'image', data: 'BASE64', mimeType: 'image/png' }),
    ]));
  });

  it('uses api/provider from options for assistant history replay shape', () => {
    const r = toAgentMessages(
      { prompt: 'q', history: [{ role: 'assistant', content: 'a' }] },
      { api: 'anthropic-messages', provider: 'anthropic' },
    );
    const asst = r[0] as { api: string; provider: string };
    expect(asst.api).toBe('anthropic-messages');
    expect(asst.provider).toBe('anthropic');
  });

  it('defaults replay shape to openai-completions/openai when no options given', () => {
    const r = toAgentMessages({
      prompt: 'q',
      history: [{ role: 'assistant', content: 'a' }],
    });
    const asst = r[0] as { api: string; provider: string };
    expect(asst.api).toBe('openai-completions');
    expect(asst.provider).toBe('openai');
  });
});

describe('convertToLlm', () => {
  it('is an identity function — passes pi Message[] through unchanged', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'hi', timestamp: 0 } as never,
    ];
    expect(convertToLlm(messages)).toBe(messages);
  });
});
