import { useState, useRef, useEffect } from 'react';
import { useAgentStream, type ChatMessage } from './hooks/useAgentStream';
import './style.css';

const AGENTS: Record<string, { avatar: string; color: string }> = {
  assistant: { avatar: '🤖', color: '#5865f2' },
  coder:     { avatar: '💻', color: '#9b59b6' },
  researcher:{ avatar: '🔍', color: '#2ecc71' },
  user:      { avatar: '👤', color: '#fff' },
  system:    { avatar: '⚠️', color: '#e74c3c' },
};

const TOOL_ICON: Record<string, string> = {
  read: '📄', grep: '🔍', exec: '⚡', write: '✏️', edit: '✏️',
  delegate: '🤝', handraise: '🙋', knowledge: '📚',
};

function ToolChip({ t }: { t: { type: string; name: string; detail: string } }) {
  const icon = TOOL_ICON[t.name] || '🔧';
  return (
    <span className={`tool-chip ${t.type}`}>
      {icon} {t.name}{t.detail ? ` ${t.detail}` : ''}
    </span>
  );
}

function Msg({ msg }: { msg: ChatMessage }) {
  const a = AGENTS[msg.agent] || AGENTS.system;
  if (msg.role === 'user') {
    return (
      <div className="msg-row user-row">
        <div className="msg-content">
          <div className="bubble user-bubble">{msg.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg-row agent-row">
      <div className="avatar" style={{ background: a.color }}>{a.avatar}</div>
      <div className="msg-content">
        <span className="agent-name" style={{ color: a.color }}>{msg.agent}</span>
        {msg.tools.length > 0 && (
          <div className="tool-chips">
            {msg.tools.map((t, i) => <ToolChip key={i} t={t} />)}
          </div>
        )}
        {msg.text && <div className="bubble agent-bubble">{msg.text}</div>}
        {!msg.done && <span className="typing">●●●</span>}
      </div>
    </div>
  );
}

export default function App() {
  const { messages, loading, send } = useAgentStream();
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    send(text);
  };

  return (
    <div className="app">
      <header>
        <h1>⚡ Nexora</h1>
        <div className="tags">
          {Object.entries(AGENTS).filter(([k]) => !['user','system'].includes(k)).map(([n, a]) => (
            <span key={n} className="tag" style={{ borderColor: a.color, color: a.color }}>{a.avatar} {n}</span>
          ))}
        </div>
      </header>
      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty">메시지를 보내면 에이전트들이 협업하여 응답합니다.</div>
        )}
        {messages.map(m => <Msg key={m.id} msg={m} />)}
        {loading && <div className="status">에이전트가 작업 중...</div>}
      </div>
      <div className="input-bar">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
          placeholder="메시지를 입력하세요..."
          disabled={loading}
        />
        <button onClick={handleSend} disabled={loading || !input.trim()}>Send</button>
      </div>
    </div>
  );
}
