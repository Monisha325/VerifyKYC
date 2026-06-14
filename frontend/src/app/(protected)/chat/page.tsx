'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, Loader2, Bot, User, AlertCircle, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import { cn } from '@/lib/utils';

interface AgentResponse {
  agent?: string;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  availableTools?: string[];
}

interface Message {
  id: string;
  role: 'user' | 'agent' | 'error' | 'system';
  raw: string;
  parsed?: Record<string, unknown>;
  isError?: boolean;
}

export default function ChatPage() {
  useAuth(); // ensures protected layout guard has fired
  const [messages, setMessages] = useState<Message[]>([{
    id: 'welcome',
    role: 'system',
    raw: "Hi! I'm your VeriKYC assistant. Ask about your application status, submit documents, or check the review queue.",
  }]);
  const [input, setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function sendPayload(body: Record<string, unknown>, displayText: string) {
    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', raw: displayText }]);
    setLoading(true);
    try {
      const { data } = await api.post<AgentResponse>('/agent/chat', body);
      const rawText = data.content?.[0]?.text ?? '';
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(rawText); } catch { /* plain text */ }

      setMessages(prev => [...prev, {
        id:      `a-${Date.now()}`,
        role:    data.isError ? 'error' : 'agent',
        raw:     rawText,
        parsed,
        isError: data.isError,
      }]);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setMessages(prev => [...prev, {
        id:   `e-${Date.now()}`,
        role: 'error',
        raw:  status === 401
          ? 'Session expired — please sign in again.'
          : 'Could not reach the server. Check your connection and try again.',
      }]);
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    await sendPayload({ message: text }, text);
  }

  async function sendTool(toolName: string) {
    if (loading) return;
    await sendPayload({ tool: toolName, args: {} }, toolName);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  return (
    <div className="animate-fade-up flex flex-col h-[calc(100vh-8rem)]">

      <div className="mb-4 flex-shrink-0">
        <h1 className="text-2xl font-bold text-gray-900">Agent Chat</h1>
        <p className="text-sm text-gray-500 mt-1">
          Ask a question or give a command — the agent routes to the right tool automatically.
        </p>
      </div>

      {/* Messages */}
      <Card className="flex-1 min-h-0 overflow-y-auto mb-3" padding={false}>
        <div className="p-4 space-y-4">
          {messages.map(msg => <Bubble key={msg.id} msg={msg} onTool={sendTool} />)}

          {loading && (
            <div className="flex items-start gap-3">
              <BotAvatar />
              <div className="flex items-center gap-2 px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100">
                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                <span className="text-sm text-gray-400">Thinking…</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </Card>

      {/* Input */}
      <div className="flex gap-2 items-end flex-shrink-0">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => { setInput(e.target.value); autoResize(e.target); }}
          onKeyDown={onKeyDown}
          placeholder="e.g. 'What is my application status?' or 'Show the review queue'"
          rows={1}
          disabled={loading}
          className={cn(
            'flex-1 resize-none rounded-xl border border-gray-200 bg-white px-4 py-3',
            'text-sm text-gray-900 placeholder:text-gray-400 transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-brand-navy/20 focus:border-brand-navy',
            'disabled:opacity-50 min-h-[46px] max-h-[120px]',
          )}
        />
        <Button
          onClick={send}
          disabled={!input.trim() || loading}
          loading={loading}
          className="flex-shrink-0 !px-3.5 h-[46px]"
          aria-label="Send"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>

      <p className="text-xs text-gray-400 text-center mt-2 flex-shrink-0">
        Enter to send · Shift+Enter for new line
      </p>
    </div>
  );
}

// ── Avatars ───────────────────────────────────────────────────────────────────

function BotAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-brand-navy/10 flex items-center justify-center flex-shrink-0 mt-0.5">
      <Bot className="w-4 h-4 text-brand-navy" />
    </div>
  );
}

function UserAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-brand-navy flex items-center justify-center flex-shrink-0 mt-0.5">
      <User className="w-4 h-4 text-white" />
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function Bubble({ msg, onTool }: { msg: Message; onTool: (tool: string) => void }) {
  if (msg.role === 'user') {
    return (
      <div className="flex items-start gap-3 justify-end">
        <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-tr-sm bg-brand-navy text-white text-sm whitespace-pre-wrap">
          {msg.raw}
        </div>
        <UserAvatar />
      </div>
    );
  }

  if (msg.role === 'system') {
    return (
      <div className="flex items-start gap-3">
        <BotAvatar />
        <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100 text-sm text-gray-500 italic">
          {msg.raw}
        </div>
      </div>
    );
  }

  if (msg.role === 'error') {
    return (
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-rose-100 flex items-center justify-center flex-shrink-0 mt-0.5">
          <AlertCircle className="w-4 h-4 text-rose-500" />
        </div>
        <div className="max-w-[80%] px-4 py-3 rounded-2xl rounded-tl-sm bg-rose-50 border border-rose-200 text-sm text-rose-700">
          {msg.raw}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <BotAvatar />
      <AgentContent msg={msg} onTool={onTool} />
    </div>
  );
}

// Tools that can be called with no arguments — safe to show as clickable pills.
// Everything else requires an ID or structured args and must be typed manually.
// Excluded: get_review_queue (reviewer-only — applicants should not see it as a pill).
const ZERO_ARG_TOOLS = new Set([
  'create_application',
  'logout',
  'get_current_user',
]);

// ── Agent message content (routing vs tool result vs plain text) ───────────────

function AgentContent({ msg, onTool }: { msg: Message; onTool: (tool: string) => void }) {
  const { parsed, raw } = msg;

  // Routing response — orchestrator didn't execute a tool, just identified the agent
  if (parsed && Array.isArray(parsed.availableTools)) {
    const safeTools = (parsed.availableTools as string[]).filter(t => ZERO_ARG_TOOLS.has(t));
    return (
      <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100 space-y-3">
        <p className="text-sm text-gray-700">
          {String(parsed.message ?? 'Routed to agent.')}
        </p>
        {safeTools.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              <Wrench className="w-3 h-3" />
              Available tools
            </p>
            <div className="flex flex-wrap gap-1.5">
              {safeTools.map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onTool(t)}
                  className="px-2.5 py-1 rounded-lg bg-brand-navy/5 text-brand-navy text-xs font-mono hover:bg-brand-navy/15 active:scale-95 transition-all cursor-pointer"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Structured JSON result — pretty-print
  if (parsed && typeof parsed === 'object') {
    return (
      <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100">
        <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words font-mono leading-relaxed overflow-x-auto">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      </div>
    );
  }

  // Plain text fallback
  return (
    <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100 text-sm text-gray-700 whitespace-pre-wrap">
      {raw}
    </div>
  );
}
