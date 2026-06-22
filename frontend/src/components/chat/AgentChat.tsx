'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Send, Loader2, Bot, User, AlertCircle, Wrench, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useApplication } from '@/context/ApplicationContext';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { cn } from '@/lib/utils';

interface ToolOption {
  name:  string;
  label: string;
}

interface AgentResponse {
  agent?: string;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  availableTools?: ToolOption[];
}

interface Message {
  id: string;
  role: 'user' | 'agent' | 'error' | 'system';
  raw: string;
  parsed?: Record<string, unknown>;
  isError?: boolean;
}

export default function AgentChat() {
  const router = useRouter();
  const { user } = useAuth();
  const { app, loading: appLoading } = useApplication();
  const currentApplicationId = app?.id ?? null;
  const allowedTools = TOOLS_BY_ROLE[user?.role ?? 'APPLICANT'] ?? TOOLS_BY_ROLE.APPLICANT;
  const [messages, setMessages] = useState<Message[]>([{
    id: 'welcome',
    role: 'system',
    raw: "Hi! I'm your VeriKYC assistant. Ask about your application status, submit documents, or check the review queue.",
  }]);
  const [input, setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const [passwordModalTool, setPasswordModalTool] = useState<'change_password' | 'reset_password' | null>(null);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function sendPayload(body: Record<string, unknown>, displayText: string) {
    // For tool calls, merge known context into args so pills work without manual input.
    // Explicit args always win over injected context.
    let payload = body;
    if (body.tool) {
      const tool = body.tool as string;
      const explicitArgs = (body.args as Record<string, unknown>) ?? {};
      const contextArgs: Record<string, unknown> = {
        ...(currentApplicationId && { applicationId: currentApplicationId }),
        ...explicitArgs,
      };
      payload = { tool, args: contextArgs };
    }

    setMessages(prev => [...prev, { id: `u-${Date.now()}`, role: 'user', raw: displayText }]);
    setLoading(true);
    try {
      const { data } = await api.post<AgentResponse>('/agent/chat', payload);
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

    // Passwords need masked input — window.prompt() (used below for
    // everything else) shows plaintext on screen while typing, which is
    // fine for an application ID but not for a password.
    if (toolName === 'change_password' || toolName === 'reset_password') {
      setPasswordModalTool(toolName);
      return;
    }

    // submit_decision needs a real decision + reason codes, which a chat
    // button can't collect — deep-link to the existing review UI instead of
    // duplicating that form here.
    if (toolName === 'submit_decision') {
      const applicationId = window.prompt('Application ID to submit a decision for:');
      if (!applicationId) return;
      router.push(`/admin/${applicationId.trim()}`);
      return;
    }

    // Two optional fields, neither sensitive — sequential prompts, skipping
    // whichever one the user leaves blank/cancels.
    if (toolName === 'update_profile') {
      const fullName = window.prompt('New full name (leave blank to keep unchanged):')?.trim();
      const phone    = window.prompt('New phone number (leave blank to keep unchanged):')?.trim();
      if (!fullName && !phone) return;
      await sendPayload(
        { tool: toolName, args: { ...(fullName && { fullName }), ...(phone && { phone }) } },
        'update_profile',
      );
      return;
    }

    // These tools need one id the chat has no existing context for (there's
    // no "current application" on the admin chat page the way there is for
    // an applicant's own application) — prompt for it before calling.
    const promptCfg = TOOL_ARG_PROMPTS[toolName];
    if (promptCfg) {
      const value = window.prompt(promptCfg.label)?.trim();
      if (!value) return;
      await sendPayload(
        { tool: toolName, args: { ...promptCfg.extraArgs, [promptCfg.argKey]: value } },
        `${toolName} (${value})`,
      );
      return;
    }

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
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Agent Chat</h1>
          {appLoading && <span className="text-xs text-gray-400">Loading context…</span>}
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Ask a question or give a command — the agent routes to the right tool automatically.
        </p>
      </div>

      {/* Messages */}
      <Card className="flex-1 min-h-0 overflow-y-auto mb-3" padding={false}>
        <div className="p-4 space-y-4">
          {messages.map(msg => <Bubble key={msg.id} msg={msg} onTool={sendTool} allowedTools={allowedTools} appLoading={appLoading} />)}

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

      {passwordModalTool && (
        <PasswordModal
          tool={passwordModalTool}
          onClose={() => setPasswordModalTool(null)}
          onSubmit={async (args) => {
            setPasswordModalTool(null);
            await sendPayload({ tool: passwordModalTool, args }, passwordModalTool);
          }}
        />
      )}
    </div>
  );
}

// ── Password modal — masked input, used for change_password/reset_password ────
// window.prompt() (used for every other tool needing an argument) doesn't mask
// input, which is fine for an application ID but not for a password.

function PasswordModal({
  tool, onClose, onSubmit,
}: {
  tool:     'change_password' | 'reset_password';
  onClose:  () => void;
  onSubmit: (args: Record<string, string>) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [resetToken,      setResetToken]      = useState('');
  const [newPassword,     setNewPassword]     = useState('');
  const [error,           setError]           = useState('');

  function submit() {
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (tool === 'change_password') {
      if (!currentPassword) { setError('Current password is required.'); return; }
      onSubmit({ currentPassword, newPassword });
    } else {
      if (!resetToken.trim()) { setError('Reset token is required.'); return; }
      onSubmit({ resetToken: resetToken.trim(), newPassword });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <Card className="w-full max-w-sm relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
        <h2 className="text-base font-semibold text-gray-900 mb-4">
          {tool === 'change_password' ? 'Change password' : 'Reset password'}
        </h2>
        <div className="space-y-3">
          {tool === 'change_password' ? (
            <Input
              type="password"
              label="Current password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              autoFocus
            />
          ) : (
            <Input
              type="text"
              label="Reset token (from your email)"
              value={resetToken}
              onChange={e => setResetToken(e.target.value)}
              autoFocus
            />
          )}
          <Input
            type="password"
            label="New password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            hint="At least 8 characters"
          />
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>Submit</Button>
        </div>
      </Card>
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

function Bubble({ msg, onTool, allowedTools, appLoading }: { msg: Message; onTool: (tool: string) => void; allowedTools: Set<string>; appLoading: boolean }) {
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
      <AgentContent msg={msg} onTool={onTool} allowedTools={allowedTools} appLoading={appLoading} />
    </div>
  );
}

// Per-role pill allowlists. applicationId is injected automatically for tools that need it.
const TOOLS_BY_ROLE: Record<string, Set<string>> = {
  APPLICANT: new Set([
    'create_application',
    'get_application_status', // applicationId injected automatically
    'get_application',        // applicationId injected automatically
    'get_current_user',
    'logout',
    'forgot_password',
    'update_profile',
    'change_password',
    'reset_password',
  ]),
  // reviewerId/reviewerRole are auto-injected server-side (agent.router.ts),
  // same as userId/role above. applicationId/entityId have no equivalent
  // auto-fillable context here (no single "current application" for a
  // reviewer browsing a queue of many) — those prompt for the id on click,
  // see TOOL_ARG_PROMPTS. submit_decision deep-links to the existing
  // /admin/[id] review UI instead of trying to collect decision + reason
  // codes through a chat button.
  REVIEWER: new Set([
    'get_review_queue',
    'get_evidence_bundle',
    'claim_application',
    'submit_decision',
    'get_audit_trail',
    'get_current_user',
    'logout',
    'forgot_password',
    'update_profile',
    'change_password',
    'reset_password',
  ]),
  ADMIN: new Set([
    'get_review_queue',
    'get_evidence_bundle',
    'claim_application',
    'submit_decision',
    'get_audit_trail',
    'get_current_user',
    'logout',
    'forgot_password',
    'update_profile',
    'change_password',
    'reset_password',
  ]),
};

// Tools whose one missing argument is collected via a prompt on click,
// rather than auto-injected context. entity defaults to 'KycApplication'
// for get_audit_trail since that's the only entity type relevant from a
// review-queue context.
const TOOL_ARG_PROMPTS: Record<string, { label: string; argKey: string; extraArgs?: Record<string, unknown> }> = {
  get_evidence_bundle: { label: 'Application ID to fetch the evidence bundle for:', argKey: 'applicationId' },
  claim_application:   { label: 'Application ID to claim:',                          argKey: 'applicationId' },
  get_audit_trail:     { label: 'Application ID to view the audit trail for:',        argKey: 'entityId', extraArgs: { entity: 'KycApplication' } },
  forgot_password:     { label: 'Email address to send the password reset link to:',  argKey: 'email' },
};

// ── Agent message content (routing vs tool result vs plain text) ───────────────

function AgentContent({ msg, onTool, allowedTools, appLoading }: { msg: Message; onTool: (tool: string) => void; allowedTools: Set<string>; appLoading: boolean }) {
  const { parsed, raw } = msg;

  // Routing response — orchestrator didn't execute a tool, just identified the agent
  if (parsed && Array.isArray(parsed.availableTools)) {
    const safeTools = (parsed.availableTools as ToolOption[]).filter(t => allowedTools.has(t.name));
    return (
      <div className="max-w-[85%] px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-50 border border-gray-100 space-y-3">
        <p className="text-sm text-gray-700">
          {String(parsed.message ?? 'Routed to agent.')}
        </p>
        {safeTools.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              <Wrench className="w-3 h-3" />
              Available actions
            </p>
            <div className="flex flex-wrap gap-1.5">
              {safeTools.map(t => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => !appLoading && onTool(t.name)}
                  disabled={appLoading}
                  className={cn(
                    'px-2.5 py-1 rounded-lg bg-brand-navy/5 text-brand-navy text-xs font-medium transition-all',
                    appLoading
                      ? 'opacity-50 cursor-not-allowed'
                      : 'hover:bg-brand-navy/15 active:scale-95 cursor-pointer',
                  )}
                >
                  {t.label}
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
