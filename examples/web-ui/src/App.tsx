import '@chatscope/chat-ui-kit-styles/dist/default/styles.min.css';
import {
  MainContainer,
  ChatContainer,
  MessageList,
  Message,
  MessageInput,
  Avatar,
  TypingIndicator,
} from '@chatscope/chat-ui-kit-react';
import { useAgentStream, type ChatMessage } from './hooks/useAgentStream';
import './style.css';

const AGENT_META: Record<string, { avatar: string; color: string }> = {
  assistant: { avatar: '🤖', color: '#3b82f6' },
  coder:     { avatar: '💻', color: '#8b5cf6' },
  researcher:{ avatar: '🔍', color: '#10b981' },
  user:      { avatar: '👤', color: '#6b7280' },
  system:    { avatar: '⚠️', color: '#ef4444' },
};

const TOOL_ICONS: Record<string, string> = {
  read: '📄', grep: '🔍', exec: '⚡', write: '✏️', edit: '✏️',
  delegate: '🤝', handraise: '🙋', knowledge: '📚', 'web-search': '🌐',
};

function ToolBadge({ tool }: { tool: { type: string; name: string; detail: string } }) {
  const icon = TOOL_ICONS[tool.name] || '🔧';
  const cls = tool.type === 'call' ? 'tool-badge call'
    : tool.type === 'error' ? 'tool-badge error'
    : 'tool-badge result';
  return (
    <span className={cls}>
      {icon} {tool.name}{tool.detail ? ` ${tool.detail}` : ''}
    </span>
  );
}

function AgentMsg({ msg }: { msg: ChatMessage }) {
  const meta = AGENT_META[msg.agent] || AGENT_META.system;
  const isUser = msg.role === 'user';

  return (
    <Message
      model={{
        message: '',
        direction: isUser ? 'outgoing' : 'incoming',
        position: 'single',
      }}
      avatarPosition={isUser ? undefined : 'tl'}
    >
      {!isUser && (
        <Avatar size="sm">
          <div className="agent-avatar" style={{ background: meta.color }}>
            {meta.avatar}
          </div>
        </Avatar>
      )}
      <Message.CustomContent>
        {!isUser && <div className="agent-name" style={{ color: meta.color }}>{msg.agent}</div>}
        {msg.tools.length > 0 && (
          <div className="tool-list">
            {msg.tools.map((t, i) => <ToolBadge key={i} tool={t} />)}
          </div>
        )}
        {msg.text && <div className="msg-text">{msg.text}</div>}
        {!msg.done && <div className="typing-dot">●●●</div>}
      </Message.CustomContent>
    </Message>
  );
}

export default function App() {
  const { messages, loading, send } = useAgentStream();

  return (
    <div className="app">
      <header className="app-header">
        <h1>⚡ Nexora</h1>
        <div className="agent-tags">
          {Object.entries(AGENT_META).filter(([k]) => k !== 'user' && k !== 'system').map(([name, m]) => (
            <span key={name} className="agent-tag" style={{ borderColor: m.color, color: m.color }}>
              {m.avatar} {name}
            </span>
          ))}
        </div>
      </header>
      <MainContainer>
        <ChatContainer>
          <MessageList
            typingIndicator={loading ? <TypingIndicator content="에이전트가 작업 중..." /> : undefined}
          >
            {messages.map(msg => <AgentMsg key={msg.id} msg={msg} />)}
          </MessageList>
          <MessageInput
            placeholder="메시지를 입력하세요..."
            attachButton={false}
            onSend={(_, text) => send(text)}
            disabled={loading}
          />
        </ChatContainer>
      </MainContainer>
    </div>
  );
}
