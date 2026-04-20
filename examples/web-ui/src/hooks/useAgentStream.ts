import { useState, useCallback } from 'react';

export interface AgentChunk {
  type: string;
  text?: string;
  content?: string;
  message?: string;
  name?: string;
  input?: Record<string, unknown>;
  agent?: string;
  from?: string;
  to?: string;
  capability?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  agent: string;
  role: 'user' | 'agent';
  text: string;
  tools: { type: string; name: string; detail: string }[];
  done: boolean;
}

const AGENTS: Record<string, boolean> = { assistant: true, coder: true, researcher: true };

let msgId = 0;

export function useAgentStream() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const send = useCallback(async (text: string) => {
    const userMsg: ChatMessage = { id: `u${++msgId}`, agent: 'user', role: 'user', text, tools: [], done: true };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    // Track current agent bubble — new bubble when agent changes
    let currentAgent = 'assistant';
    let lastChunkAgent = '';
    let lastMsgId = '';
    const allMsgIds = new Set<string>();
    const getOrCreateMsg = (agent: string): string => {
      if (agent === lastChunkAgent && lastMsgId) return lastMsgId;
      const id = `a${++msgId}`;
      lastChunkAgent = agent;
      lastMsgId = id;
      allMsgIds.add(id);
      setMessages(prev => [...prev, { id, agent, role: 'agent', text: '', tools: [], done: false }]);
      return id;
    };

    try {
      const res = await fetch('/messages/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });

      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let c: AgentChunk;
          try { c = JSON.parse(line.slice(6)); } catch { continue; }

          const agent = c.agent && AGENTS[c.agent] ? c.agent : currentAgent;
          const mid = getOrCreateMsg(agent);

          if (c.type === 'text') {
            setMessages(prev => prev.map(m => m.id === mid ? { ...m, text: m.text + (c.text || '') } : m));
          } else if (c.type === 'tool_call') {
            const detail = c.name === 'delegate' && c.input?.capability
              ? `→ @${c.input.capability}`
              : c.name === 'read' && c.input?.path
              ? String(c.input.path)
              : c.name === 'grep' && c.input?.pattern
              ? `/${c.input.pattern}/`
              : '';
            setMessages(prev => prev.map(m =>
              m.id === mid ? { ...m, tools: [...m.tools, { type: 'call', name: c.name!, detail }] } : m
            ));
          } else if (c.type === 'tool_result') {
            setMessages(prev => prev.map(m =>
              m.id === mid ? { ...m, tools: [...m.tools, { type: c.isError ? 'error' : 'result', name: c.name!, detail: '' }] } : m
            ));
          } else if (c.type === 'delegate_start' && c.to) {
            currentAgent = c.to;
            getOrCreateMsg(c.to);
          } else if (c.type === 'delegate_end') {
            currentAgent = 'assistant';
          } else if (c.type === 'done') {
            // Mark all agent messages as done
            setMessages(prev => prev.map(m => allMsgIds.has(m.id) ? { ...m, done: true } : m));
          } else if (c.type === 'error') {
            setMessages(prev => prev.map(m => m.id === mid ? { ...m, text: m.text + `\n[Error] ${c.message}`, done: true } : m));
          }
        }
      }
    } catch (e) {
      setMessages(prev => [...prev, { id: `e${++msgId}`, agent: 'system', role: 'agent', text: `Error: ${(e as Error).message}`, tools: [], done: true }]);
    }
    setLoading(false);
  }, []);

  return { messages, loading, send };
}
